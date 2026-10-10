# Verificación de APIs (Chrome MV3) para Fangio

**Fecha de verificación:** 2026-10-10. Las fuentes son la documentación oficial de developer.chrome.com, MDN y GitHub Docs.
**Veredictos:** Confirmado / Contradicho / Parcial / No documentado. "No documentado" significa que la documentación oficial no lo dice. Lo que figura entre paréntesis como "comportamiento observado" no es contrato, así que el código debe ser defensivo.

## Tabla resumen

| # | Supuesto | Veredicto | Fuente |
|---|---|---|---|
| 1 | Campos de `tabs.Tab` y sus versiones | Confirmado (con matices) | [tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs) |
| 2 | `query` no carga pestañas; `remove(array)`; cerrar la última pestaña | Parcial / No documentado | [tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs) |
| 3 | `onRemoved`, `onReplaced`, `onActivated`, `onUpdated` | Confirmado; el cierre del navegador no está documentado | [tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs) |
| 4 | Restricciones de `discard` y `create` | Parcial | [tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs) |
| 5 | `tabGroups` y `tabs.group` | Confirmado | [tabGroups](https://developer.chrome.com/docs/extensions/reference/api/tabGroups) |
| 6 | Alarms: mínimo de 30 s y persistencia | Parcial (hay un cambio en Chrome 150) | [alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms) |
| 7 | `storage.session` | Confirmado | [storage](https://developer.chrome.com/docs/extensions/reference/api/storage) |
| 8 | Ciclo de vida del service worker | Confirmado; BroadcastChannel no está documentado para extensiones | [lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) |
| 9 | Permiso `favicon` y `_favicon` | Confirmado; el origen (caché o red) no está documentado | [favicons](https://developer.chrome.com/docs/extensions/how-to/ui/favicons) |
| 10 | `unlimitedStorage` e IndexedDB | Confirmado; borrado y reload, parcial | [storage-and-cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies) |
| 11 | Campo `key` del manifest | Confirmado; los riesgos no están documentados | [key](https://developer.chrome.com/docs/extensions/reference/manifest/key) |
| 12 | Durabilidad de IndexedDB | Confirmado (por defecto `relaxed` desde Chrome 121) | [blog](https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed) |
| 13 | Auto-update fuera de la tienda en Windows | **Contradicho** | [install-extensions](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions) |
| 14 | `onStartup` y `onInstalled` | Confirmado / Parcial | [runtime](https://developer.chrome.com/docs/extensions/reference/api/runtime) |
| 15 | Atajos de commands: máximo 4 y Alt+Shift+letra | Confirmado | [commands](https://developer.chrome.com/docs/extensions/reference/api/commands) |
| 16 | `incognito: "not_allowed"` | Confirmado | [incognito](https://developer.chrome.com/docs/extensions/reference/manifest/incognito) |
| 17 | `fetch` a api.github.com sin `host_permissions` | Confirmado (por CORS) | [GitHub CORS](https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests) |

## Notas por ítem

**1. Tab.** Con el permiso `tabs` (o con host permissions) se exponen `url`, `title`, `favIconUrl` y `pendingUrl` (Chrome 79+, solo mientras hay una navegación pendiente). Versiones mínimas de otros campos: `discarded` y `autoDiscardable` desde 54, `groupId` desde 88, `mutedInfo` desde 46, `audible` desde 45, **`frozen` desde Chrome 132** y **`lastAccessed` desde Chrome 121** (en ms epoch). También existe `splitViewId` desde 140. `TabStatus` vale `unloaded`, `loading` o `complete`. Matices:
- `url` es la última URL committed y **puede ser `""`** si todavía no hubo commit. `favIconUrl` puede ser `""` mientras la pestaña carga.
- `id` es opcional y es único **solo dentro de la sesión**.
- La documentación no dice explícitamente que url y title estén disponibles en pestañas descartadas o no cargadas. Solo dice que la pestaña sigue en la tira de pestañas.
- *Implicación:* hacer fallback `url || pendingUrl` y descartar entradas sin URL. Nunca persistir `tab.id` como clave estable entre sesiones.

**2. query y remove.** La documentación no dice si `query` activa o recarga pestañas, aunque no hay nada que indique que lo haga. Sin el permiso, los filtros `url` y `title` se ignoran. `remove(number | number[])` acepta un array (Chrome 88+), pero **no documenta qué pasa con un id inválido**. Comportamiento observado: el error rechaza la promesa y las pestañas previas del array pueden quedar ya cerradas. Que el navegador se cierre al quitar la última pestaña de la última ventana tampoco está documentado. *Implicación:* volver a consultar los ids justo antes de cerrar. Cerrar en lotes tolerantes a error, con fallback de uno en uno. Antes de archivar todas las pestañas, crear una pestaña de reemplazo (por ejemplo, la página de Fangio).

**3. Eventos.** `onRemoved` incluye `{isWindowClosing, windowId}`, y `isWindowClosing` es true si la pestaña se cerró porque se cerró su ventana. **No está documentado si se dispara al cerrar el navegador.** `onReplaced(addedTabId, removedTabId)` se dispara por prerender o por navegación instantánea. `onActivated` incluye `{tabId, windowId}`. `changeInfo` puede traer url, title (48+), favIconUrl, audible, status, discarded, frozen (132+), groupId, pinned, mutedInfo y autoDiscardable. *Implicación:* no depender de `onRemoved` durante el apagado. Reconciliar con `tabs.query` en `onStartup` y remapear ids en `onReplaced`.

**4. discard y create.** `discard(tabId)` descarta la pestaña salvo que esté **activa o ya descartada**. Puede fallar si no hay pestañas descartables. Las pestañas que todavía cargan no están documentadas. La documentación no dice si el id cambia, así que conviene usar el Tab devuelto. `create` requiere una URL con esquema. `active` vale true por defecto y `index` se ajusta al rango válido. Las URLs `javascript:` no están soportadas en `update`. **`file://`:** la documentación oficial no lo cubre. Según el anuncio en el grupo chromium-extensions, desde Chrome 118 solo funciona si el usuario activa "Permitir acceso a URLs de archivo". Las restricciones sobre `chrome://` no están documentadas. *Implicación:* restaurar en try/catch por pestaña y, si falla, mostrar la URL para que el usuario la copie.

**5. tabGroups.** Requiere el permiso `tabGroups` (MV3, Chrome 89+). Métodos: `get`, `query`, `update` y `move`. Colores: grey, blue, red, yellow, green, pink, purple, cyan y orange. `TabGroup` tiene `collapsed`, `color`, `id`, `title?`, `windowId` y `shared` (137+). `TAB_GROUP_ID_NONE` vale -1. En `tabs.group({tabIds, groupId?, createProperties:{windowId}})`, **no se puede combinar `groupId` con `createProperties`**.

**6. alarms.** Un valor menor de 0.5 min no se respeta y genera un aviso. La página de lifecycle sitúa el mínimo de 30 s en Chrome 120. Las extensiones unpacked no tienen límite. **Desde Chrome 150** existe `persistAcrossSessions`, que en Chrome vale true por defecto. Con true, la alarma persiste hasta que la extensión se actualiza. Con false, se borra al recargar o al reiniciar el navegador. Antes de 150 el comportamiento era "impredecible". *Implicación:* en `onStartup` y `onInstalled`, hacer `alarms.get()` y recrear la alarma si falta. Las alarmas se pierden con una update.

**7. storage.session.** Vive en memoria. Se borra al **deshabilitar, recargar o actualizar la extensión, y al reiniciar el navegador**. La cuota es de 10 MB (1 MB hasta Chrome 111). Necesita el permiso `storage`. Por defecto no se expone a content scripts (solo a contextos de confianza), y se cambia con `setAccessLevel`.

**8. Service worker.** Se termina tras 30 s inactivo. Los eventos y las llamadas a APIs de extensión reinician el timer; las llamadas a APIs cuentan desde Chrome 110. Una sola petición que dure más de 5 min termina el SW, y también una respuesta de `fetch` que tarde más de 30 s. Las variables globales se pierden. Los listeners deben registrarse en el top level de forma síncrona (ver [events](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/events)). IndexedDB y Cache Storage están disponibles, Web Storage no. En los SW de módulo no hay `import()` dinámico. **BroadcastChannel no está documentado para extensiones.** Es un estándar de workers de mismo origen y no despierta un SW dormido. *Implicación:* usar `runtime.sendMessage` y `storage.onChanged` para despertar o notificar al SW. BroadcastChannel solo sirve entre páginas abiertas.

**9. favicon.** Requiere el permiso `favicon`, con el aviso "Leer los iconos de los sitios que visitas". La URL es `chrome-extension://<id>/_favicon/?pageUrl=<url>&size=<px>`, construida con `runtime.getURL("/_favicon/")`. Desde content scripts hay que declararla en `web_accessible_resources`. **No está documentado si sale de la caché o de la red, ni qué devuelve si no hay icono.** *Implicación:* tratarlo como si viniera solo de caché y tener un icono por defecto propio.

**10. unlimitedStorage.** Quita la cuota de `storage.local`, IndexedDB, Cache Storage y OPFS, y exime de la evicción ([permissions-list](https://developer.chrome.com/docs/extensions/reference/permissions-list)). Los datos de la extensión no se borran al limpiar los datos de navegación. `storage.local` "se borra al eliminar la extensión". Para IndexedDB no lo dice explícitamente, aunque en la práctica también se borra. La documentación no dice que IndexedDB sobreviva a un reload o update. Solo dice que `storage.session` se borra en ese caso, y la práctica confirma que sí sobrevive. *Implicación:* ofrecer una exportación o backup manual antes de desinstalar o mover el proyecto.

**11. key.** Mantiene el ID de la extensión durante el desarrollo. Se obtiene subiendo el paquete al Developer Dashboard y copiando la clave del botón "View public key". La documentación no menciona riesgos. Es una clave pública, así que publicarla no expone ningún secreto, pero **cualquiera puede reutilizarla para cargar un unpacked con el mismo ID**. *Implicación:* no usar el ID como autenticación (externally_connectable, allowlists de servidor). Sin `key`, mover la carpeta cambia el ID y los datos quedan huérfanos.

**12. Durabilidad de IndexedDB.** Los valores son `strict`, `relaxed` y `default` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction)). **Desde Chrome 121 el valor por defecto es `relaxed`** (antes era `strict`). La versión en que se introdujo la opción (supuestamente Chrome 83) no está verificada. *Implicación:* usar `{durability:'strict'}` en las transacciones que archivan antes de cerrar pestañas.

**13. Distribución.** Según la documentación, **"en Windows y macOS el update_URL debe apuntar a la Chrome Web Store"**. No se permiten instalaciones externas desde un CRX local en Windows desde Chrome 33. El autohospedaje solo es posible en Linux ([host-on-linux](https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux)) o mediante políticas empresariales. `runtime.reload()` sí está permitido salvo en modo kiosco. En una extensión unpacked, el reload cuenta como update y dispara `onInstalled` con el motivo `update`.

**14. onStartup y onInstalled.** `onStartup` se dispara cuando arranca un perfil que tiene la extensión instalada, y no en incógnito. Los motivos de `onInstalled` son `install`, `update`, `chrome_update` y `shared_module_update`. No está documentado si `onStartup` se dispara al cargar la extensión recién instalada, y en la práctica no lo hace. *Implicación:* poner la inicialización común en una función que llamen ambos eventos y también el top level del SW, de forma idempotente.

**15. commands.** Admite como máximo 4 atajos sugeridos. Cada atajo debe incluir Ctrl o Alt, y no se permite Ctrl+Alt. Alt+Shift+letra es válido. Si otra extensión ya usa el atajo, no se registra; se detecta porque `commands.getAll()` devuelve `shortcut` vacío.

**16. incognito "not_allowed".** La extensión no puede habilitarse en incógnito. Existe desde Chrome 47.

**17. GitHub.** La REST API admite CORS desde cualquier origen y responde con `Access-Control-Allow-Origin: *`. Sin host permissions, el `fetch` de la extensión se trata como cross-origin ([network-requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)) y funciona gracias a CORS. Los límites de peticiones sin autenticar no figuran en esa página.
