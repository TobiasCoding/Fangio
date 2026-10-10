<p align="center"><img src="static/icons/icon128.png" width="96" height="96" alt="Fangio"></p>

<h1 align="center">Fangio</h1>

<p align="center">
  Archivá pestañas en una base local, cerralas con seguridad y recuperalas rápido.<br>
  Extensión para Chrome y navegadores Chromium (Manifest V3). Sin servidores, sin cuentas.
</p>

<p align="center">
  <a href="https://github.com/TobiasCoding/Fangio/actions/workflows/ci.yml"><img src="https://github.com/TobiasCoding/Fangio/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/TobiasCoding/Fangio/releases/latest"><img src="https://img.shields.io/github/v/release/TobiasCoding/Fangio?label=versi%C3%B3n" alt="Última versión"></a>
  <a href="LICENSE.txt"><img src="https://img.shields.io/badge/licencia-GPL--3.0-blue" alt="Licencia GPL-3.0"></a>
</p>

> [!WARNING]
> **«Quitar» la extensión en `chrome://extensions` borra toda su base de datos.**
> Antes de desinstalarla, exportá una copia en **Panel → Copias → Exportar JSON**.
> Recargar o actualizar la extensión **no** borra nada.

## Contenido

- [Qué es](#qué-es)
- [Garantías de seguridad](#garantías-de-seguridad)
- [Instalación](#instalación)
- [Primer uso](#primer-uso)
- [Uso diario](#uso-diario)
- [Reglas automáticas y el objetivo de 15 pestañas](#reglas-automáticas-y-el-objetivo-de-15-pestañas)
- [Duplicados](#duplicados)
- [Papelera y eliminación definitiva](#papelera-y-eliminación-definitiva)
- [Registro y deshacer](#registro-y-deshacer)
- [Copias de seguridad y restauración](#copias-de-seguridad-y-restauración)
- [Actualizaciones](#actualizaciones)
- [Permisos](#permisos)
- [Privacidad](#privacidad)
- [Limitaciones](#limitaciones)
- [Desarrollo](#desarrollo)
- [Publicar una versión](#publicar-una-versión)
- [Resultados de verificación](#resultados-de-verificación)

## Qué es

Fangio es para quienes viven con decenas (o cientos) de pestañas abiertas «por las dudas».
Desde el momento en que lo instalás, cada pestaña queda registrada en una base de datos local
(IndexedDB, dentro de tu perfil del navegador) con su URL, título, ventana, grupo y fechas.
Así podés cerrar pestañas sin miedo: la referencia queda guardada y la reabrís con un clic.

- **Archivar** una pestaña la cierra y conserva su enlace y su contexto.
- **Buscar** entre todo lo archivado por título, URL o nota, con filtros por dominio,
  etiquetas, proyecto y estado.
- **Automatizar** (opcional) el cierre de pestañas inactivas hasta un objetivo de pestañas
  abiertas, siempre con previsualización y respetando las protecciones.
- **Recuperar** cualquier cosa: papelera, registro con deshacer y copias de seguridad.

## Garantías de seguridad

La regla de oro es **integridad antes que limpieza**: ante la duda, la pestaña queda abierta.

### Cómo se cierra una pestaña

Cada cierre (manual, por importación o por una regla) sigue siempre este orden:

1. **Guardar**: se escribe la referencia con los datos frescos de la pestaña.
2. **Confirmar**: se espera la confirmación de la escritura en IndexedDB (durabilidad
   estricta). Si la escritura falla, la pestaña no se toca.
3. **Revalidar**: justo antes de cerrar se comprueba que la pestaña sigue existiendo, que
   tiene **exactamente la misma URL** y que sigue siendo elegible. Si algo cambió, se omite.
4. **Cerrar** la pestaña (por lotes; si un lote falla, se reintenta de a una).
5. **Registrar** el resultado en el registro de acciones, con su motivo y la información
   necesaria para deshacer.

Las operaciones se anotan en un diario antes de producir efectos: si el navegador o el
servicio de fondo se interrumpen a mitad de camino, al volver se completan o se revierten
sin perder ni duplicar registros, y nunca se cierra nada «a ciegas».

### Protecciones

Las protecciones **siempre prevalecen** sobre las reglas automáticas. Nunca se cierran
automáticamente las pestañas:

- protegidas por vos, fijadas, activas o seleccionadas;
- que están reproduciendo audio o lo hicieron hace poco;
- de sitios excluidos (por defecto Meet, Docs, Zoom, Teams, Slack, Figma, WhatsApp Web,
  Gmail y Outlook: editores, llamadas y chats con trabajo en curso);
- de incógnito (Fangio no las ve ni las guarda), páginas internas del navegador y de la
  propia extensión.

Una acción manual sobre una pestaña protegida pide confirmación explícita.

### Nada sale de tu equipo

No hay backend, cuentas ni telemetría. Todo vive en tu perfil del navegador. La única
petición de red es opcional: una consulta diaria a la API pública de releases de GitHub para
avisarte si hay una versión nueva (ver [Privacidad](#privacidad)).

### Qué **no** garantiza

Guardar la URL y el título **no** guarda el estado de la página. Al reabrir una pestaña
archivada **no** recuperás:

- formularios a medio completar ni borradores sin guardar;
- el estado interno de aplicaciones web (posición en un video, filtros, chats abiertos,
  sesiones que expiraron);
- contenido que cambió o dejó de existir en el sitio.

Por eso los sitios donde suele haber trabajo en curso están excluidos de la automatización
por defecto. Si una pestaña tiene algo sin guardar, protegela o guardá antes de archivar.

## Instalación

Fangio se distribuye como **extensión descomprimida** desde los
[releases de GitHub](https://github.com/TobiasCoding/Fangio/releases/latest) (no está en la
Chrome Web Store). Requiere Chrome 121 o posterior (también Edge, Brave y otros Chromium).
La guía completa, con solución de problemas, está en
[docs/INSTALL.md](docs/INSTALL.md).

### Opción A: descargar el zip

1. Descargá `fangio-vX.Y.Z.zip` del [último release](https://github.com/TobiasCoding/Fangio/releases/latest).
2. Extraelo en una **carpeta permanente**, por ejemplo `%LOCALAPPDATA%\Fangio\extension`
   en Windows o `~/.local/share/fangio/extension` en Linux. No uses Descargas ni una
   carpeta temporal: Chrome carga la extensión desde ahí cada vez que arranca.
3. Abrí `chrome://extensions`.
4. Activá el **Modo de desarrollador** (arriba a la derecha).
5. Tocá **Cargar descomprimida** y elegí la carpeta donde extrajiste el zip (la que contiene
   `manifest.json`).
6. Fijá el ícono de Fangio en la barra (menú de extensiones, ícono de pieza de rompecabezas).

Opcional: verificá la descarga con el `SHA256SUMS.txt` del release
(`Get-FileHash fangio-vX.Y.Z.zip` en PowerShell o `sha256sum -c SHA256SUMS.txt`).

### Opción B: script de instalación (Windows)

En PowerShell (no requiere permisos de administrador):

```powershell
irm https://raw.githubusercontent.com/TobiasCoding/Fangio/main/scripts/install.ps1 | iex
```

Descarga el último release, verifica su SHA-256 y lo deja en
`%LOCALAPPDATA%\Fangio\extension` (o en la carpeta que indiques con `-InstallDir` si lo
ejecutás como archivo). Después seguí los pasos 3 a 6 de la opción A.

## Primer uso

Apenas se instala, Fangio registra **todas** las pestañas abiertas: desde el primer segundo
ya tenés una copia de sus URLs. Nada se cierra hasta que vos lo decidas.

1. Abrí el panel (`Alt+Shift+F` o el botón del popup). La primera vez se abre el
   **asistente de importación** (sección **Importar**).
2. **Exportá una copia JSON primero.** El asistente te lo propone antes de tocar nada.
3. **Revisá** la lista: protegé lo que no se debe cerrar, marcá pendientes, etiquetá.
4. **Archivá** lo que no necesitás tener abierto. Cada pestaña pasa por el
   [cierre seguro](#cómo-se-cierra-una-pestaña).
5. Si querés, **activá la automatización** en **Reglas**: antes de activarla vas a ver una
   previsualización exacta de qué cerraría y por qué. Está apagada por defecto.

## Uso diario

- **Panel** (`Alt+Shift+F`): lista de todas las referencias (abiertas, archivadas y en la
  papelera), ordenada cronológicamente, con acciones individuales o por selección
  (archivar, reabrir, proteger, etiquetar, mover a la papelera…).
- **Búsqueda** por título, URL y nota, y **filtros** por estado, dominio, etiquetas,
  proyecto, pendientes y protegidas.
- **Pendientes**: marcá lo que tenés que leer o hacer; tienen su propio filtro.
- **Etiquetas, proyectos y notas**: organizá referencias sin depender de carpetas.
- **Reabrir**: las pestañas se reabren de a pocas (para no saturar el equipo), en segundo
  plano, y si eran de un grupo se reagrupan.
- **Popup** (ícono de la barra): acciones sobre la pestaña actual (archivar, proteger,
  marcar pendiente, nota y etiquetas), contadores y acceso al panel.
- **Atajos** (se cambian en `chrome://extensions/shortcuts`):

  | Atajo | Acción |
  |---|---|
  | `Alt+Shift+F` | Abrir el panel |
  | `Alt+Shift+A` | Archivar la pestaña actual |

Cerrar una pestaña a mano (con la X o `Ctrl+W`) la manda a la **papelera** con el motivo
«Cerrada por el usuario», así podés recuperarla. Cerrar una ventana o el navegador no
cambia nada: si la sesión se restaura, las referencias se vuelven a vincular; si no, quedan
**archivadas** (nunca se borran).

## Reglas automáticas y el objetivo de 15 pestañas

La automatización está **apagada** hasta que la activás en **Reglas**. Cuando está activa,
cada pocos minutos (5 por defecto) evalúa las pestañas abiertas en este orden:

1. **Protecciones**: si alguna aplica, la pestaña se queda. Siempre ganan.
2. **Reglas por URL exacta**: por ejemplo, la portada de ChatGPT, Instagram o Google sin
   usar durante 60 minutos va a la papelera. Podés editarlas, desactivarlas o agregar otras.
3. **Inactividad**: lo que no consultaste en 24 horas se archiva (configurable; 0 = nunca).
4. **Objetivo de pestañas abiertas** (15 por defecto): si hay más, se archivan las que hace
   más tiempo que no mirás (con al menos 60 minutos sin uso) hasta llegar al objetivo. Las
   que viste recién se quedan aunque eso supere el objetivo.
5. **Tope por ejecución** (50 por defecto): nunca cierra de golpe más que eso.

La pantalla de reglas muestra la **previsualización** exacta (qué haría con cada pestaña y
por qué) antes de activar o cambiar algo. Cada cierre automático queda en el registro con
su motivo, por ejemplo: «Archivada automáticamente: sin consultar hace 26 h (inactividad
> 24 h)».

## Duplicados

La vista **Duplicados** agrupa las referencias con **exactamente la misma URL**. Nada se
fusiona solo: elegís cuál conservar y **Fusionar** le suma las etiquetas, notas, marcas de
pendiente/protegida y fechas de las demás, que pasan a la papelera (recuperables y con
deshacer). Una pestaña abierta no se fusiona en otra: archivala primero.

## Papelera y eliminación definitiva

Archivar **no** es borrar. La papelera es un paso intermedio separado:

- Van a la papelera las pestañas que cerrás a mano, las que mandás explícitamente y las de
  reglas configuradas con esa acción.
- Desde la papelera podés **restaurar** (vuelve a archivadas) en cualquier momento.
- **Eliminación definitiva automática**: lo que lleva más de **30 días** en la papelera se
  elimina (configurable; **0 = nunca**). Sólo afecta a la papelera, nunca a lo archivado.
- **Vaciar papelera** o **Eliminar definitivamente** a mano piden escribir `ELIMINAR`
  para confirmar.

## Registro y deshacer

Cada cambio (archivar, reabrir, editar, fusionar, restaurar, cierres automáticos…) queda en
el **Registro** con fecha y motivo, y casi todo se puede **deshacer**: las pestañas cerradas
se reabren y los cambios de datos se revierten. La única excepción es la eliminación
definitiva, que sólo se recupera desde una copia JSON. El registro se conserva 90 días
(configurable).

## Copias de seguridad y restauración

En **Copias**:

- **Exportar JSON**: copia completa y versionada (referencias, configuración y últimas entradas del registro).
  Es el formato para restaurar en Fangio.
- **Exportar HTML de marcadores**: formato estándar que cualquier navegador importa. Sirve
  como salvavidas independiente de Fangio.
- **Importar JSON**: valida cada registro y **fusiona** con lo que ya tenés (por id; gana
  la versión editada más recientemente). Nunca borra nada. Lo que en la copia figuraba
  abierto se importa como archivado.

Recomendación: exportá una copia JSON con regularidad (el panel te lo recuerda) y siempre
antes de desinstalar, mover la carpeta o cambiar de equipo.

## Actualizaciones

Chrome **no puede actualizar solo** una extensión descomprimida o distribuida fuera de la
Chrome Web Store: en Windows y macOS sólo se permiten extensiones externas mediante
políticas empresariales, y las descomprimidas nunca se actualizan automáticamente (detalles
y fuentes en [docs/INSTALL.md](docs/INSTALL.md#por-qué-no-se-actualiza-sola)). Por eso:

1. Fangio consulta una vez por día si hay una versión nueva (podés desactivarlo) y te
   muestra un aviso en el panel.
2. Ejecutás el actualizador que está **dentro de la carpeta instalada**:
   - Windows: doble clic en `update.cmd` (o `update.ps1` desde PowerShell).
   - Linux/macOS: `bash update.sh`.

   Descarga el release, verifica su SHA-256, comprueba que sea Fangio con la misma clave,
   guarda la versión anterior en `<carpeta>.previous` y reemplaza los archivos (si algo
   falla, restaura la anterior).
3. Tocás **Recargar** en `chrome://extensions` (o **Recargar extensión** en el aviso del
   panel). **Tus datos se conservan.**

## Permisos

Fangio pide sólo lo necesario y **ningún permiso de host**: no puede leer ni modificar el
contenido de las páginas y no inyecta scripts en ellas.

| Permiso | Para qué |
|---|---|
| `tabs` | Leer URL y título de las pestañas, y abrirlas, cerrarlas o descartarlas. |
| `tabGroups` | Recordar el título y color del grupo de origen y reagrupar al reabrir. |
| `storage` | Datos de la sesión actual del navegador (`storage.session`). |
| `alarms` | Tareas periódicas: reglas, mantenimiento y la consulta diaria de versiones. |
| `unlimitedStorage` | Que el navegador no desaloje la base local por falta de espacio. |
| `favicon` | Mostrar íconos de sitios desde la caché del navegador, sin visitar los sitios. |

El manifiesto incluye una clave pública (`key`) que fija el ID de la extensión
(`domaedkeecbijcmbcjcfpjeabbdcmefb`), para que cada actualización sea reconocida como la
misma extensión con la misma base de datos.

## Privacidad

- Todo se guarda localmente en tu perfil del navegador. No hay servidores, cuentas,
  analíticas ni telemetría.
- La **única** petición de red es opcional: una vez por día Fangio consulta
  `https://api.github.com/repos/TobiasCoding/Fangio/releases/latest` para saber si hay una
  versión nueva. No envía ningún dato tuyo (GitHub ve, como en cualquier petición, tu
  dirección IP). Se desactiva en la configuración.
- Los scripts de instalación y actualización sólo hablan con GitHub y sólo escriben en la
  carpeta de la extensión.

Más detalles en [PRIVACY.md](PRIVACY.md).

## Limitaciones

- Conservar URL y título no recupera formularios, borradores ni el estado interno de las
  aplicaciones web (ver [Qué no garantiza](#qué-no-garantiza)).
- La historia previa a la instalación es desconocida: las pestañas que ya estaban abiertas
  no tienen fecha de apertura.
- Tras reiniciar el navegador, la fecha de «último acceso» de algunas pestañas puede
  reflejar la restauración de la sesión y no tu último uso real.
- Las pestañas de incógnito se ignoran por completo.
- No hay sincronización entre equipos: para llevar tus datos a otro equipo, exportá e
  importá una copia JSON.
- Al no estar en la Chrome Web Store, las actualizaciones requieren el paso manual descrito
  en [Actualizaciones](#actualizaciones), y Chrome puede mostrar avisos sobre extensiones en
  modo de desarrollador.
- **«Quitar» la extensión borra su base de datos.** Exportá antes.

## Desarrollo

Requisitos: Node.js 20 o posterior (CI usa Node 24) y npm.

```bash
npm ci               # instala dependencias exactas
npm run build        # compila en dist/ (sin minificar, para que sea auditable)
npm run dev          # compila y recompila al guardar (alias: build:watch)
npm run typecheck    # TypeScript sin emitir
npm test             # pruebas unitarias (Vitest)
npm run test:e2e     # pruebas de punta a punta con Playwright
npm run check        # typecheck + test + build
npm run package      # build + release/fangio-vX.Y.Z.zip + SHA256SUMS.txt
npm run icons        # regenera los PNG de static/icons/
```

Para probar, cargá la carpeta `dist/` con **Cargar descomprimida** y tocá **Recargar** en
`chrome://extensions` después de cada compilación. La arquitectura y las decisiones de
diseño están en [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Estructura: `src/background` (service worker), `src/core` (lógica y base de datos),
`src/ui` (panel y popup con Preact), `src/shared` (tipos y constantes), `static`
(manifiesto e íconos), `scripts` (compilación, empaquetado, publicación, instalación y
actualización), `tests` y `e2e`.

## Publicar una versión

```bash
# 1. Describí los cambios en la sección [Unreleased] de CHANGELOG.md y hacé commit.
# 2. Desde main, con el árbol limpio:
npm run release -- patch     # o minor, major, o una versión X.Y.Z
# 3. Publicá:
git push origin main --follow-tags
```

`npm run release` corre typecheck y pruebas, sube la versión en `package.json` y
`package-lock.json`, mueve las notas del changelog a la nueva versión, compila, y crea el
commit `release: vX.Y.Z` y la etiqueta `vX.Y.Z`. Al llegar la etiqueta a GitHub, Actions
vuelve a verificar todo, empaqueta el zip y publica el release con sus notas y su
`SHA256SUMS.txt`. Detalles en [docs/RELEASING.md](docs/RELEASING.md).

## Resultados de verificación

Resumen (detalle completo, metodología y limitaciones en [docs/TESTING.md](docs/TESTING.md)):

- **Pruebas unitarias:** 113/113 (persistencia, interrupciones, reglas, protecciones,
  duplicados, importación/exportación, fallos de almacenamiento, 800+ registros).
- **Pruebas de punta a punta en navegador real aislado** (Chromium de Playwright 156,
  perfil temporal, nunca el navegador del usuario): **9/9 escenarios con 820 pestañas**
  en 4 ventanas (fijadas, grupos, duplicados, audio).

Números **medidos** (i7-12700K, 32 GB, Windows 11, una corrida):

| Operación | Resultado |
|---|---|
| Instantánea al instalar con 820 pestañas abiertas | 820 registros en 391 ms, sin duplicados |
| Asistente de importación: archivar 805 pestañas | 9,7 s, 0 fallos; fijadas/activa/audio/excluidas siguen abiertas |
| Matar el navegador (taskkill) a mitad del cierre masivo | 0 referencias perdidas, 0 duplicados, en todos los momentos probados |
| Reinicio | mismos identificadores, archivo intacto |
| Reabrir 50 | 2,1 s, nunca más de 3 cargando a la vez |
| Panel con 10.000 registros | carga 236–344 ms, búsqueda ~150 ms, ≤ 40 filas en el DOM |
| Memoria del navegador | 1,22 GB con 820 pestañas → 0,80 GB tras reiniciar con 15 |

No cubierto todavía: Chrome estable con un perfil real, el popup y los atajos en modo
visible, y los tiempos reales de las alarmas. Ver la sección de limitaciones en
[docs/TESTING.md](docs/TESTING.md).

## Seguridad y licencia

- Para reportar una vulnerabilidad, seguí [SECURITY.md](SECURITY.md).
- Fangio es software libre bajo la licencia [GPL-3.0](LICENSE.txt).
