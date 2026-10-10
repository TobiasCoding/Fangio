# Arquitectura de Fangio

Documento de referencia para el código. Los tipos viven en `src/shared/types.ts`,
el protocolo de mensajes en `src/shared/messages.ts`, constantes en
`src/shared/constants.ts` y la configuración por defecto en `src/shared/settings.ts`.

## Principios

1. **Integridad antes que limpieza.** Ninguna pestaña se cierra si su referencia no
   quedó escrita y confirmada en IndexedDB (transacción `readwrite` con
   `durability: 'strict'`, se espera `tx.done`). Ante la duda, la pestaña queda abierta.
2. **Identidad estable.** Cada referencia tiene `id = crypto.randomUUID()`. Los ids de
   pestaña/ventana del navegador sólo se guardan dentro de `live` / `pendingClose`,
   acompañados de `sessionId`, y nunca se usan como clave.
3. **Idempotencia y reanudación.** Las operaciones de varias fases (cerrar, reabrir) se
   registran en el diario `ops` antes de producir efectos. El servicio de fondo puede
   morir en cualquier línea; al despertar, `resumeOps()` + `reconcile()` terminan o
   revierten sin perder ni duplicar registros.
4. **Las protecciones prevalecen.** Protegida, fijada, activa, seleccionada
   (highlighted), con audio actual o reciente, sitio excluido, incógnito, páginas de la
   propia extensión y URLs no rastreables nunca se cierran automáticamente.
   Una acción manual sobre un registro protegido se rechaza salvo `force: true` (la UI
   pide confirmación explícita y desprotege).
5. **Nada sale del equipo.** Sin backend. La única petición de red opcional es la
   consulta diaria de releases en `api.github.com` (no envía datos del usuario; se
   desactiva en Configuración).

## Estados

| Estado | Significado | Pestaña |
|---|---|---|
| `open` | Existe en el navegador y tiene referencia guardada | Sí (`live` vigente) |
| `archived` | Conserva enlace y contexto sin pestaña | No |
| `trash` | Descartada, recuperable hasta su eliminación definitiva | No |

`protected`, `pending` (pendiente marcado), `tags`, `project` y `note` son atributos
independientes del estado. Reabrir un registro archivado reutiliza el mismo `id`
(state → `open`, `live` nuevo, `reopenCount++`); volver a archivarlo conserva el `id`.

### Transiciones

- Pestaña nueva (rastreable) → registro `open` (`source: 'tracked'`, `openedAt` sólo si se
  creó después del período de gracia de arranque).
- Instalación → *snapshot* de todas las pestañas existentes como `open`
  (`source: 'install-snapshot'`, `importedAt = ahora`, `openedAt` desconocido). Esto ya
  es una copia de respaldo: desde el primer segundo todas las URLs están en la base.
- Archivar (manual, importación o regla) → pipeline de cierre seguro → `archived`.
- Enviar a papelera: si está abierta, el mismo pipeline con `targetState: 'trash'`; si está
  archivada, cambio de estado.
- El usuario cierra una pestaña (`onRemoved` con `isWindowClosing: false`) → `trash`
  con motivo «Cerrada por el usuario» e `implicitCloseAt`.
- Se cierra una ventana (`isWindowClosing: true`) o el navegador → **no se cambia nada**
  en el evento. La reconciliación posterior archiva (`window-closed`) los registros `open`
  sin pestaña una vez pasado el período de gracia. Así un cierre del navegador seguido de
  restauración de sesión vuelve a vincular las mismas referencias.
- Restaurar (`trash` → `archived`). Eliminación definitiva sólo desde `trash`.

### Re-vinculación (evita duplicados)

Cuando aparece una pestaña rastreable no vinculada, se busca en este orden:
1. Registro `open` cuyo `live.tabId` coincide y con la misma URL (recarga de la extensión:
   los ids de pestaña siguen valiendo aunque cambie `sessionId`).
2. Registro con `pendingClose` y misma URL (cierre interrumpido; la pestaña sobrevivió).
3. Registro `open` sin vínculo vigente con la misma URL exacta; desempate por cercanía de
   (`origin.windowOrdinal`, `origin.index`).
4. Registro con `implicitCloseAt` en los últimos `REBIND_WINDOW_MS` y misma URL
   (Ctrl+Shift+T, «reabrir ventana cerrada»). Acción `rebind`.
5. Si nada coincide → registro nuevo.

Nunca se re-vinculan registros archivados explícitamente: dos pestañas iguales no se
asumen iguales en estado (ver Duplicados).

## Pipeline de cierre (archivar / papelera)

    Guardar → confirmar escritura → revalidar → cerrar → registrar resultado

1. **Diario**: se escribe `OpJournal{kind:'close', items:[{recordId, tabId, status:'pending'}]}`.
2. **Guardar**: por lotes (`WRITE_BATCH_SIZE`), se actualiza cada registro con los datos
   frescos de la pestaña (`chrome.tabs.get`) y `pendingClose{opId, tabId, sessionId,
   expectedUrl, targetState}`. Se espera `tx.done` con durabilidad estricta. Si la escritura
   falla, el ítem queda `failed` y **la pestaña no se toca**.
3. **Revalidar** inmediatamente antes de cerrar: `chrome.tabs.get(tabId)` debe existir, la
   URL debe ser idéntica a `expectedUrl`, y la pestaña debe seguir siendo elegible (para
   acciones automáticas y la importación inicial: no activa, no fijada, sin audio, sitio no
   excluido, no protegida, etc.; para acciones manuales: no protegida salvo `force`). Las
   decisiones automáticas llevan la URL evaluada (`CloseItem.expectedUrl`): si la pestaña ya
   muestra otra, se omite. Además se relee el registro: debe conservar el
   mismo `pendingClose.opId`. Si algo cambió → `skipped` y se limpia `pendingClose`.
   Una acción forzada sobre un registro protegido que termina omitida o con error le
   devuelve la protección.
4. **Cerrar** con `chrome.tabs.remove` en lotes de `CLOSE_BATCH_SIZE`. Cada lote vuelve a
   consultar las pestañas y descarta las que ya no muestran la URL esperada («La URL cambió
   antes de cerrar»: quedan abiertas y se limpia `pendingClose`). Consulta + resguardo +
   `remove` de cada lote corren bajo un mutex global, así dos operaciones concurrentes no
   pueden dejar juntas al navegador vacío. Si el lote falla, se
   reintenta de a una para aislar el error. Si cerrar dejaría al navegador sin ninguna
   pestaña normal, primero se crea una pestaña nueva vacía.
5. **Registrar resultado**: `state = targetState`, `archivedAt`/`trashedAt`, `live = null`,
   `pendingClose = null`, ítems `done`, entrada en el registro de acciones con motivo y
   `before` para deshacer. El handler de `onRemoved` reconoce las pestañas con
   `pendingClose` (o en el set en memoria de cierres en curso) y no las trata como
   «cerradas por el usuario».

Recuperación tras interrupción (`resumeOps` al despertar y en la alarma de mantenimiento):
- Ítem `pending` (nada escrito todavía): se marca `skipped` (la pestaña sigue abierta).
- Registro con `pendingClose` y pestaña todavía existente con la misma URL: se **aborta**
  (se limpia `pendingClose`, sigue `open`). La regla volverá a evaluarla; nunca cerramos a
  ciegas después de una interrupción.
- Registro con `pendingClose` cuya pestaña ya no existe (o sesión distinta y ninguna
  pestaña con esa URL tras la gracia de arranque): se completa a `targetState`.

## Reapertura

`OpJournal{kind:'reopen'}`; concurrencia limitada por `reopenConcurrency`.
Por ítem: marcar `creating` (persistido) → registrar URL esperada en memoria →
`chrome.tabs.create({url, active:false, windowId})` → vincular `live` y `state:'open'`
→ `done`. Se espera `status === 'complete'` o `REOPEN_LOAD_TIMEOUT_MS` antes de liberar
el cupo; si la reapertura es masiva y `discardAfterBulkReopen`, las pestañas en segundo
plano se descartan (`chrome.tabs.discard`) después de cargar. Con `restoreGroups`, se
reagrupa por `origin.groupTitle` en la ventana destino.
Reanudación: ítems `creating` sin `tabId` → si existe una pestaña no vinculada con esa URL
se vincula; si no, se crea. Nunca se crean dos pestañas para el mismo ítem en la misma sesión.

## Seguimiento de eventos (tracker)

Los listeners se registran **sincrónicamente en el nivel superior** de `background/index.ts`
(requisito de MV3). Los eventos de alto volumen (`onUpdated` de título/favicon/audio) se
acumulan en memoria y se vuelcan con debounce (`EVENT_FLUSH_MS`) en una sola transacción.
Perder un volcado por terminación del worker no es grave: la reconciliación periódica
re-sincroniza títulos y URLs. Los cambios de estado críticos nunca se difieren.

- `onCreated` / `onUpdated(url)` → crear o re-vincular (ver arriba), o actualizar URL
  (la anterior pasa a `previousUrls`).
- `onActivated` → `lastAccessedAt = ahora`.
- `onUpdated(audible)` → `lastAudibleAt`.
- `onRemoved` → ver transiciones.
- `onReplaced` → mover `live.tabId`. `onAttached`/`onDetached` → actualizar `live.windowId`.

URLs rastreables: `http:`, `https:`, `file:`, `ftp:`. `chrome://newtab`, `about:blank`,
páginas de la propia extensión y otras URLs internas no generan registros (no cuentan para
el objetivo de pestañas abiertas). Pestañas de incógnito se ignoran por completo.

## Sesión y reconciliación

`sessionId` vive en `chrome.storage.session` (se borra al reiniciar el navegador o recargar
la extensión). `onStartup` guarda `startupAt` y programa `ALARM_STARTUP_SWEEP`.
`reconcile()` (al iniciar el worker si pasaron >5 min desde la última, en la alarma de
mantenimiento y manualmente):
1. Lista pestañas (`chrome.tabs.query({})`, excluye incógnito).
2. Vincula/actualiza según la tabla de re-vinculación.
3. Registros `open` sin pestaña: dentro de `STARTUP_GRACE_MS` desde el arranque no se
   tocan; si no, → `archived` con motivo «No encontrada (ventana cerrada o sesión no
   restaurada)» (acción `window-closed`). Nunca a `trash`, nunca se borran.
4. Resuelve `pendingClose` huérfanos (ver pipeline).
La función de planificación es pura (`planReconcile`) y está cubierta por pruebas.

## Reglas automáticas

Sólo con `automationEnabled` (apagado hasta que el usuario lo activa tras la importación).
Alarma `ALARM_AUTOMATION` cada `checkIntervalMinutes`. `evaluateRules()` es pura: recibe
pestañas, registros, configuración y `now`, devuelve un `RulePreview`. La UI muestra
exactamente esa previsualización antes de activar.

`idleMinutes = (now - max(record.lastAccessedAt, tab.lastAccessed)) / 60000`.

Orden de evaluación por pestaña abierta:
1. Bloqueos (`BlockReason`): si hay alguno → `keep` con explicación. Prevalecen siempre.
2. Regla de URL exacta habilitada que coincide y `idleMinutes >= afterMinutes` → su acción.
3. Inactividad: `idleArchiveHours > 0` y `idleMinutes >= idleArchiveHours*60` → `archive`.
4. Objetivo: si quedan más de `targetOpenTabs` abiertas (contando todas las rastreables,
   incluso bloqueadas), se archivan las más antiguas por último acceso con
   `idleMinutes >= targetMinIdleMinutes` hasta llegar al objetivo. Las vistas recientemente
   se mantienen aunque se supere el objetivo (`recently-viewed`).
5. Tope `maxAutoClosePerRun` (las más inactivas primero); `capped` lo indica.

Cada acción automática se registra con su motivo, p. ej.
«Archivada automáticamente: sin consultar hace 26 h (inactividad > 24 h)».

## Duplicados

Referencias con URL **idéntica** (comparación exacta de strings) se agrupan en la vista
Duplicados. Nada se fusiona solo. «Fusionar» (manual) conserva el registro elegido y le
agrega: unión de etiquetas, notas concatenadas, `pending`/`protected` por OR, fecha de
creación mínima, último acceso máximo, `mergedFrom`. Los demás pasan a `trash` con motivo
«Fusionada en …» (recuperables, deshacer disponible). Un registro abierto no puede
fusionarse en otro (se rechaza: hay que archivarlo antes).

## Papelera y eliminación definitiva

Política explícita y separada del archivado: `trashRetentionDays` (30 por defecto; 0 =
nunca). La alarma de mantenimiento elimina sólo registros en `trash` con
`trashedAt < now - retención`, y deja una entrada `purge` en el registro (no deshacible).
Como resguardo ante saltos de reloj, no elimina nada si algún `trashedAt` está en el futuro
(el reloj retrocedió) y nunca más de 500 por ejecución (las más antiguas primero).
«Vaciar papelera» y «Eliminar definitivamente» requieren `confirm: 'ELIMINAR'`.

## Registro de acciones y deshacer

Cada mutación escribe una `ActionEntry` con motivo y `before`. Deshacer:
- `archive`/`trash` de pestañas abiertas → se reabren (concurrencia limitada).
- `trash` de archivados, `restore`, `update`, `merge`, `user-closed`, `window-closed` →
  se restauran los campos de `before`.
- `purge` no se puede deshacer (sólo desde una copia JSON).
Retención del registro: `logRetentionDays`.

## Persistencia (IndexedDB `fangio`, versión 1)

- `records` (keyPath `id`): índices `state`, `url`, `domain`, `tags` (multiEntry), `updatedAt`.
- `actions` (keyPath `id`): índice `at`.
- `ops` (keyPath `id`): diario de operaciones.
- `kv` (keyPath `key`): `settings`, `lastAutoRun`, `updateInfo`, `meta`.
Se pide `unlimitedStorage` para que el archivo no sea desalojado. Las migraciones futuras
se hacen en `onupgradeneeded` sin pérdida de datos.

## Exportación / importación

JSON versionado `ExportFileV1` (`format: 'fangio-export'`, `schemaVersion: 1`). Al importar
se valida cada registro (sólo URLs http/https/file/ftp, largos acotados; las entradas del
registro de acciones se filtran por campos y nunca son deshacibles); los registros
importados en estado `open` pasan a `archived` (no tienen pestaña) y los de `trash` reciben
`trashedAt = ahora` (la retención cuenta desde la importación); fusión por `id` (gana
`updatedAt` mayor, pero un registro abierto o con cierre en curso conserva URL, estado y
vínculo; la URL que pierde pasa a `previousUrls`); nunca se borra nada al importar. Reabrir
rechaza URLs no rastreables. También se exporta HTML en formato de marcadores Netscape (importable en
cualquier navegador) como vía de recuperación independiente de la extensión.

## Interfaz

- `dashboard.html` (pestaña completa): lista virtualizada, búsqueda (título, URL, nota),
  filtros (estado, dominio, etiquetas, proyecto, pendientes, protegidas), orden cronológico,
  acciones individuales y por selección, asistente de importación inicial, reglas con
  previsualización, duplicados, papelera, registro con deshacer, copia de seguridad.
  Lee IndexedDB directamente; muta vía mensajes; escucha `BroadcastChannel`.
- `popup.html`: pestaña actual (archivar, proteger, pendiente, nota, etiquetas), contadores,
  abrir panel.
- Atajos (`commands`): abrir panel, archivar pestaña actual.

## Permisos

`tabs` (URL/título de pestañas), `tabGroups` (título/color de grupo de origen), `storage`
(`storage.session`), `alarms`, `unlimitedStorage`, `favicon` (iconos desde la caché del
navegador vía `/_favicon/` sin visitar sitios). Sin permisos de host ni scripts de contenido.
El manifiesto incluye una clave pública (`key`) para fijar el ID de la extensión: así la
base de datos sobrevive aunque se mueva la carpeta de instalación.

## Limitaciones conocidas

- Conservar URL y título no recupera formularios, borradores ni estado interno de apps.
- La cronología previa a la instalación es desconocida (`openedAt` vacío).
- `tab.lastAccessed` tras reiniciar el navegador puede reflejar la restauración.
- Desinstalar («Quitar») la extensión borra su IndexedDB: exportar antes. Recargar o
  actualizar no borra datos.
