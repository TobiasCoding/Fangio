# Pruebas de Fangio

Este documento explica cómo correr las pruebas unitarias y la batería end-to-end (e2e) en un
navegador real, qué cubre cada escenario, los resultados **medidos** en una corrida concreta y
las limitaciones conocidas. Los números medidos están separados de las estimaciones.

## Pruebas unitarias

```bash
npm ci
npm run typecheck      # tsc -p . --noEmit
npm test               # vitest run (fake chrome.* + fake-indexeddb)
```

Cubren la lógica pura y el servicio de fondo completo contra un `chrome.*` falso
(`tests/helpers/fakeChrome.ts`): pipeline de cierre, interrupciones en cada fase (`testHooks.checkpoint`),
reinicios del navegador, reglas, duplicados, copias, protecciones.

## Pruebas e2e en navegador real

```bash
npm run build                    # el harness también compila antes de empezar (--no-build lo evita)
npm run test:e2e                 # todos los escenarios, 820 pestañas (~17 min en la máquina medida)
node e2e/run.mjs --list          # lista de escenarios
node e2e/run.mjs --only s1,s2 --tabs 200
node e2e/run.mjs --only s4 --tabs 400 --kill-at middle
node e2e/run.mjs --quick         # omite las esperas del período de gracia (3 min) en S3/S4
```

Opciones: `--only <ids>` (las dependencias se agregan solas: S2 necesita S1, etc.),
`--tabs N` (por defecto 820), `--headed` (ventanas reales fuera de pantalla), `--quick`,
`--keep-profiles`, `--no-build`, `--kill-at early,middle,late`.

Requisitos: Node ≥ 20 y el Chromium de Playwright descargado (`npx playwright install chromium`;
hace falta el navegador completo, no el *headless shell*, porque las extensiones no funcionan en
este último). Probado en Windows; la medición de memoria (S8) usa `Win32_Process` y sólo
funciona en Windows.

Resultados: `e2e/.results/<fecha>/results.json` (y `e2e/.results/latest.json`). Perfiles
temporales: `e2e/.profiles/` (se borran al terminar salvo `--keep-profiles`). Ambos están en
`.gitignore`. **El harness nunca usa el Chrome ni el perfil del usuario**: lanza el Chromium de
Playwright con `--user-data-dir` propio.

### Cómo funciona

- `e2e/lib/server.mjs`: servidor HTTP local en `127.0.0.1` (puerto aleatorio) con páginas
  `/p/<n>?q=..` («Página n»), `/` (para la regla de URL exacta), `/audio` (tono en bucle) y favicon.
- `e2e/helper-ext/`: extensión **de prueba** (no se distribuye) con permisos `tabs`/`tabGroups`
  que crea las pestañas por lotes, las agrupa/fija, y registra eventos de pestañas (para medir
  la concurrencia de reapertura desde fuera de Fangio).
- `e2e/lib/fixtures.mjs`: arma el «navegador del usuario»: N pestañas en 4 ventanas
  (50/30/15/5 %), 4 fijadas, 3 grupos («Trabajo», «Lectura», «Compras»), duplicados exactos,
  casi-duplicados (`?q=a`, `?q=b`, `#sec`), 3 pestañas `/`, 4 pestañas en `localhost`
  (sitio excluido), 1 pestaña con audio. Después **reinicia** el navegador: la restauración de
  sesión deja la gran mayoría de las pestañas **sin cargar** (como un perfil real de larga
  duración). Ese perfil se usa como plantilla (se copia) en S1 y S4.
- `e2e/lib/cdp.mjs`, `browser.mjs`, `page.mjs`: Chromium se lanza como proceso hijo (así se
  conoce su PID y se puede matar el árbol completo) y se maneja por **CDP directo**. Playwright
  sólo se usa para ubicar el binario: `connectOverCDP` se adjunta a todas las pestañas y con
  ~800 pestañas excede su tiempo de espera. La UI se maneja con eventos de entrada reales
  (`Input.dispatchMouseEvent`/`dispatchKeyEvent`/`insertText`).
- Lectura del estado: se evalúa código de **solo lectura** en el service worker de Fangio
  (o en una página de Fangio si el worker no arranca): `chrome.tabs.query`, `storage.session`
  e IndexedDB `fangio` (sólo si ya existe: nunca se crea la base desde el harness).
- Instalación con pestañas existentes: método que funcionó → **CDP `Extensions.loadUnpacked`**
  sobre el navegador en marcha (requiere `--enable-unsafe-extension-debugging`). Chromium no
  persiste esas extensiones entre reinicios, así que los relanzamientos cargan el mismo `dist/`
  con `--load-extension` (el manifiesto no tiene `key`: el id depende de la carpeta, y como es el
  mismo `dist/` el id y la IndexedDB son los mismos; el harness lo descubre en tiempo de
  ejecución buscando el service worker cuyo manifiesto se llama «Fangio»).

### Invariantes globales (después de cada escenario)

1. Toda URL de la pestaña original tiene una pestaña abierta con esa URL exacta **o** un registro
   con esa URL exacta (en cualquier estado).
2. Sin inflación: registros ≤ pestañas originales + pestañas creadas por la prueba; y por URL,
   registros ≤ instancias de pestaña con esa URL.
3. Toda pestaña abierta rastreable tiene **exactamente un** registro `open` vinculado en la sesión
   actual. (En S4, dentro del período de gracia, se admiten pestañas sin vincular a propósito
   cuando su URL pertenece a un cierre interrumpido todavía diferido; se informan aparte).

## Escenarios y resultado de la corrida completa

Corrida completa: `npm run test:e2e` (820 pestañas, sin `--quick`), 2026-10-10, duración total
≈ 16,5 min. **9/9 PASS** (80 comprobaciones, 0 fallidas). Antes de las correcciones, S4 había fallado
(ver «Errores encontrados y corregidos»).

| # | Escenario | Qué verifica | Resultado |
|---|---|---|---|
| S1 | Instalación con pestañas existentes | Fangio se carga (CDP `Extensions.loadUnpacked`) en un navegador que ya tiene 820 pestañas en 4 ventanas (fijadas, grupos, audio, casi todas sin cargar). Un registro `open` por pestaña (`install-snapshot`), duplicados exactos con registros separados, títulos de grupo en `origin`, entrada `install-snapshot` en el registro | PASS |
| S2 | Asistente de importación por la UI | `#/importar`: el conteo de la vista previa coincide con las protecciones reales (fijadas/activas/audio/sitio excluido se mantienen); se protegen 3 filas con el checkbox; «Confirmar» → «Aplicar»; quedan abiertas sólo las esperadas; los archivados conservan URL, título, ventana/índice y grupo; el navegador nunca queda sin pestañas; acción deshacible | PASS |
| S9 | Duplicados | URL idéntica → registros separados (S1); «Fusionar en este» en `#/duplicados` (las otras van a papelera, nada se borra); «Deshacer» desde `#/registro` restaura estados y `mergedFrom` | PASS |
| S5 | Reabrir 50 desde la UI | Selección con teclado (Mayús+↓ ×49) en «Archivadas» → «Reabrir» → confirmación; la concurrencia observada desde otra extensión nunca supera `reopenConcurrency`; los mismos ids pasan a `open`; re-archivar y «Deshacer» conservan ids; ningún registro nuevo | PASS |
| S3 | Reinicio del navegador | Cierre ordenado (CDP `Browser.close`) y relanzamiento con restauración de sesión: archivo intacto (mismos ids/URLs), pestañas restauradas re-vinculadas a los **mismos** ids, sin registros nuevos; los registros de una ventana cerrada antes del reinicio siguen `open` durante la gracia y recién después se archivan (`window-closed`), nunca a papelera; el panel carga | PASS |
| S4 | Corte duro durante un archivado masivo | Archivar las 820 y matar el árbol de procesos (`taskkill /F /T`) en 3 momentos (diario escrito / 50 % cerradas / 95 % cerradas); relanzar; sin pérdidas ni duplicados; diario reanudado/abortado según la especificación | PASS (tras corregir 2 errores) |
| S6 | Automatización | Objetivo 15, regla de URL exacta `http://127.0.0.1:<puerto>/` → papelera a los 0 min, tope 20 por ejecución, 2 protegidas, 2 fijadas, 2 en sitio excluido; vista previa = resultado; protecciones nunca cerradas; tope respetado; `/?model=x` y `/#frag` no coinciden con la regla; motivos registrados por regla | PASS |
| S7 | Escala UI (10.000 registros) | Importar copia JSON sintética desde `#/copias` (input de archivo real), carga del panel, latencia de búsqueda, scroll virtualizado con rueda real hasta el final, exportación JSON (descarga real) e ida y vuelta (reimportar: 0 nuevas, 0 actualizadas) | PASS |
| S8 | Recursos | Memoria del árbol de procesos en cada fase, proceso de extensión de Fangio, heap JS del panel | PASS (informativo) |

## Números MEDIDOS

**Máquina:** Intel Core i7-12700K (12 núcleos / 20 hilos), 32 GB de RAM, Windows 11 Pro.
**Navegador:** Chromium 156.0.8078.4 de Playwright 1.64 (`chromium-1248`), `--headless=new`,
salida de audio falsa (`--disable-audio-output`). Una sola corrida en esta máquina; otras
máquinas (y Chrome estable) darán otros valores. Tiempos de pared medidos desde el harness
(incluyen la latencia de CDP y del sondeo, típicamente 10–100 ms).

| Medición | Valor |
|---|---|
| Crear la plantilla (820 pestañas, carga + descarte) / restaurarla | 26,7 s / 7,8 s |
| S1: `Extensions.loadUnpacked` | 67 ms |
| S1: instalación → 820 registros `open` vinculados | **391 ms** |
| S2: vista previa de importación visible (820 filas) | 255 ms |
| S2: «Aplicar» → «Importación lista» (805 archivadas + 3 protegidas) | **9,7 s** (≈ 83 pestañas/s) |
| S2: Fangio estable tras aplicar | +1,5 s |
| S5: reabrir 50 → todas vinculadas / operación terminada | 2,1 s / 2,2 s |
| S5: máximo de pestañas cargando a la vez (`reopenConcurrency` = 3) | 3 |
| S5: re-archivar 50 / deshacer (reabre 50) | 0,6 s / 2,0 s |
| S3: cierre ordenado / relanzar hasta tener las pestañas / Fangio estable | 0,6 s / 0,5 s / +1,6 s |
| S3: panel cargado tras reiniciar | 90 ms |
| S3: barrido de arranque (ventana cerrada → `archived`) | 185 s tras el arranque (gracia 180 s + 5 s) |
| S6: vista previa / ejecución (20 cierres) | 4 ms / 211 ms |
| S7: importar 10.000 registros desde `#/copias` | 1,1 s |
| S7: carga del panel `#/lista` con 10.001 registros (3 recargas) | 251 / 236 / 344 ms |
| S7: búsqueda hasta que la lista cambia (incluye debounce de 120 ms): exacta / amplia (2.500) / sin resultados | 164 / 150 / 153 ms |
| S7: scroll con rueda hasta el final de 9.501 filas | máx. 40 filas en el DOM; mayor hueco entre frames 34 ms |
| S7: heap JS del panel con 10.001 registros | 19 MB |
| S7: exportar JSON (5,5 MB, descarga real) / reimportar el mismo archivo | 0,7 s / 1,6 s |

### S4 — corte duro (820 pestañas)

| Momento del corte | Primer arranque tras el corte | Arranque siguiente, dentro de la gracia | Tras la gracia (barrido) |
|---|---|---|---|
| *early*: 145 ms tras enviar «archivar 820», diario escrito, 0 cerradas | 820 pestañas restauradas; el worker de Fangio no arranca (ver Limitaciones); datos intactos | 820 registros con `pendingClose`, 820 pestañas sin vincular a propósito (diferido) | **820 abiertas** (cierre abortado: las pestañas siguen), 0 pendientes, 0 duplicados |
| *middle*: 6,4 s, 425 cerradas | el navegador restauró 683 pestañas (incluye 288 que ya estaban cerradas) | 129 con `pendingClose` diferido | **683 abiertas** (mismos ids) + **137 archivadas**; 0 pérdidas, 0 duplicados |
| *late*: 10,3 s, 800 cerradas | el navegador restauró 451 | 359 con `pendingClose` diferido | **451 abiertas** + **369 archivadas**; 0 pérdidas, 0 duplicados |

En una corrida previa con 400 pestañas, el corte *late* llegó **después** de la escritura final
(400 archivadas, sin `pendingClose`) y el navegador igual restauró 141 de esas pestañas: con la
corrección de la regla 4b se re-vincularon a los mismos 141 registros (sin la corrección: 368
registros duplicados en el mismo escenario).

### S8 — memoria del árbol de procesos de Chromium

| Fase | Procesos | Working set | Privada |
|---|---|---|---|
| 820 pestañas restauradas (5 cargadas, resto `unloaded`), sin Fangio | 14 | 1.224 MB | 892 MB |
| Tras el snapshot de instalación | 19 | 1.492 MB | 1.019 MB |
| Antes de archivar (panel abierto) | 22 | 1.701 MB | 1.133 MB |
| Después de archivar 805 | 25 | 1.810 MB | 1.171 MB |
| Tras reiniciar con 15 pestañas abiertas | 12 | 799 MB | 503 MB |

- Proceso de extensión de Fangio (service worker) tras el snapshot de 820: **72 MB** de working
  set; con el panel abierto llegó a ~110 MB (59 MB privados). Heap JS del panel con ~820
  registros: 3,9 MB.
- Archivar **no** bajó la memoria durante la sesión: las pestañas cerradas ya estaban sin cargar
  (`unloaded` por la restauración de sesión; no `discarded`) y, mientras tanto, Chromium siguió
  cargando pestañas restauradas en segundo plano (7 → 17 renderizadores). El ahorro aparece en el
  siguiente arranque: 799 MB con 15 pestañas frente a 1,2–1,8 GB con 820.
- La suma de working sets cuenta dos veces las páginas compartidas; «Privada» es más representativa.
- Al **crear** la plantilla, cargar y luego descartar 820 pestañas sin límite de procesos dejó ~820
  renderizadores vivos (~17 GB privados): `chrome.tabs.discard` no liberó los procesos en este
  build. Por eso la plantilla se arma con `--renderer-process-limit=6` y se reinicia.

## Vistas y análisis contextual (v1.1)

```bash
npm run test:e2e:views           # compila, ~1 min; capturas en e2e/.results/views/
node e2e/views.mjs --headed --no-build
```

Navegador aislado igual que la batería principal (Chromium de Playwright, perfil temporal).
Todos los nombres de host se resuelven a un servidor HTTPS local
(`--host-resolver-rules`, certificado autofirmado descartable creado con `openssl`,
`--ignore-certificate-errors`): «google.com», «chatgpt.com» o «react.dev» son páginas de
prueba locales y **nada sale a la red** (HTTPS porque esos dominios tienen HSTS precargado).
La extensión se carga desde una copia de `dist/` con el permiso opcional `<all_urls>` ya
concedido, porque el diálogo de permisos del navegador no se puede aceptar por automatización.

Escenario: 14 pestañas abiertas de a una y vistas 2,7 s cada una — una búsqueda de Google
sobre hooks de React seguida de una conversación de ChatGPT y tres sitios (abiertos desde la
búsqueda, con `openerTabId`), una búsqueda de bicicletas con tienda, blog y video, tres
páginas sobre Lisboa y ruido (clima, una receta).

Resultado medido (Chromium 156, i7-12700K, Windows 11): **14/14 comprobaciones**.

| Comprobación | Resultado |
|---|---|
| Registros y pestaña de origen | 14/14 registros; `openerId` correcto en las 3 pestañas abiertas desde la búsqueda |
| Miniaturas reales | 14 capturas WebP de 320 px (≈2,5 KB en estas páginas simples; páginas reales pesan más) |
| Tarjetas | Por defecto, minimalistas (sin imagen ni colores); con miniatura y colores activados en «Diseño de tarjetas», 14 tarjetas con miniatura; tras «Borrar todas las miniaturas», pósters generados |
| Línea de tiempo | filas de día y de sesión |
| Temas | 3 grupos: «Hooks · useEffect · React» (búsqueda + ChatGPT + 3 sitios, recorrido que empieza en la búsqueda), «Bicicleta · rodado · MTB» (búsqueda + tienda + blog + video), «Lisboa» (3); clima y receta fuera de todo grupo |
| Análisis | 3–8 ms para 14 referencias en el *worker*; 10.000 referencias sintéticas ≈0,2 s (prueba unitaria en Node) |
| Agrupar en Chrome | grupo de pestañas nativo con las 5 pestañas del tema |
| Reglas → Miniaturas | el interruptor refleja el ajuste guardado y no avisa de permiso faltante |

Después de los cambios de la v1.1 (migración de la base a la versión 2, `openerId`,
listeners de miniaturas) la batería principal volvió a pasar completa: `node e2e/run.mjs
--tabs 200 --quick` → **9/9 escenarios**.

No cubierto: el diálogo real de permisos, la IA integrada de Chrome (Gemini Nano no está en
el Chromium de Playwright; el código detecta su ausencia y oculta el botón) y temas con miles
de referencias reales.

## ESTIMACIONES (no medidas)

- En Chrome estable 155 con un perfil real los tiempos deberían ser del mismo orden: el costo
  dominante del archivado masivo es `chrome.tabs.remove` en lotes de 25 más las escrituras
  `strict` (≈ 80–100 pestañas/s aquí). Con un disco más lento o con antivirus que escanee
  IndexedDB puede ser 2–5× más lento. Sin medir.
- Memoria con pestañas **cargadas** (no fue el caso medido): cada renderizador de una página
  real usa decenas a cientos de MB; ahí archivar sí libera memoria de inmediato.

## Errores encontrados y corregidos

1. **El barrido de arranque no resolvía los cierres interrumpidos diferidos**
   (`src/background/index.ts`). Tras un corte, al despertar dentro del período de gracia
   `resumeOps()` difiere el cierre interrumpido (las pestañas todavía se están restaurando) y lo
   marca como activo; el barrido de los 3 min sólo llamaba a `reconcile()`, que deja en paz las
   operaciones activas. Resultado medido (S4 *middle*, 400 pestañas): tras la gracia seguían 400
   registros con `pendingClose` y 376 pestañas **sin rastrear**, hasta la alarma de mantenimiento
   (hasta 15 min) o un reinicio del worker. Corrección: el barrido ejecuta `resumeOps()` y luego
   `reconcile()`. Prueba: `tests/crashRecovery.test.ts` («a close interrupted by a crash … is
   completed by the startup sweep»).
2. **Duplicados masivos cuando el navegador restaura pestañas recién archivadas**
   (`src/core/reconcile.ts`, `src/shared/constants.ts`). Si el navegador se corta pocos segundos
   después de un archivado masivo, su archivo de sesión todavía tiene las pestañas y las
   restaura; como los registros estaban `archived` (cierre explícito), se creaba un registro
   nuevo por pestaña (S4 *late*, 400 pestañas: 768 registros para 400 pestañas). Corrección:
   regla de re-vinculación **4b**, sólo durante la gracia de arranque de una sesión nueva y sólo
   para registros cerrados por Fangio como mucho 10 min (`RESTORED_AFTER_CLOSE_WINDOW_MS`)
   **antes** de que empezara la sesión: se reutiliza el registro (acción `rebind`). Un archivado
   hecho en la sesión actual nunca se re-vincula. Pruebas: `tests/crashRecovery.test.ts` (3 casos).
   Documentado en `docs/ARCHITECTURE.md`.

Ambas correcciones se validaron de nuevo en navegador real (S4 con 400 y con 820 pestañas).

## Hallazgos que no son errores de Fangio

- **Tras un corte duro, el service worker de la extensión no arranca en la sesión siguiente**
  (Chromium 156, extensiones cargadas con `--load-extension`; reproducido también con una
  extensión mínima de prueba, clásica y de módulo). Las páginas de la extensión abren, pero
  `chrome.runtime.sendMessage` falla con «Receiving end does not exist». En el arranque
  siguiente vuelve a funcionar. Mientras tanto Fangio no rastrea nada (no hay pérdida: no se
  cierra ninguna pestaña y los datos quedan intactos; la reconciliación del arranque siguiente
  pone todo al día). No se pudo comprobar si pasa igual con una extensión sin empaquetar
  instalada desde `chrome://extensions` en Chrome estable (ver Limitaciones). S4 lo detecta,
  lo informa (`serviceWorkerStartsAfterCrash: false`) y reinicia el navegador normalmente.
- Al relanzar después de un corte, el navegador restauró pestañas que Fangio ya había cerrado
  (288 de 425 en *middle*): el archivo de sesión de Chromium se guarda con retraso. Fangio las
  re-vincula a sus registros (regla 2 si el cierre no había terminado; regla 4b si sí).
- `chrome.tabs.discard` de este build no termina el proceso renderizador de pestañas recién
  cargadas (ver S8).
- Las pestañas de fondo restauradas no reproducen audio hasta que se muestran una vez
  (Chromium difiere los medios); el harness activa la pestaña de audio un instante.

## Limitaciones (lo que NO cubre esta batería)

- **Chromium de Playwright 156, no Chrome estable 155** ni el perfil real del usuario. El
  comportamiento de restauración de sesión, descarte y ciclo de vida del worker puede variar.
- **Restauración de sesión de un perfil real con 800 pestañas** de sitios reales (páginas
  pesadas, logins, `beforeunload`): no probado. Las páginas de prueba son mínimas y locales.
- **Instalación persistente**: Chromium no persiste las extensiones cargadas por CDP; tras
  reiniciar se usa `--load-extension`. No se probó «Cargar descomprimida» desde
  `chrome://extensions` ni la actualización con `update.ps1`.
- **Headless**: las ventanas son de `--headless=new`. La UI se maneja con eventos de entrada
  reales vía CDP, pero no se validó apariencia visual, foco real del sistema operativo,
  atajos de teclado globales (`commands`) ni el popup de la acción.
- **Audio**: probado con salida de audio falsa (`--disable-audio-output`): `audible=true` se
  reporta y la protección por audio se cumple (S2). No se probó con dispositivo de audio real ni
  `audioGraceMinutes` (audio reciente) en navegador real.
- **`file://`, `ftp://`**, incógnito, pestañas en vista dividida, ventanas emergentes/PWA y
  `chrome://` no se probaron en navegador real (sólo en las pruebas unitarias).
- **Alarmas reales de automatización** (cada `checkIntervalMinutes`) y la alarma de
  mantenimiento de 15 min no se esperaron: S6 usa `runRulesNow`. `lastAccessed` antiguo no se
  simuló; se usó `targetMinIdleMinutes = 0` e `idleArchiveHours = 0`.
- **Ciclo de vida del worker**: el harness se adjunta por CDP al service worker para leer el
  estado, y con DevTools adjunto Chromium no lo termina a los 30 s de inactividad. Las
  terminaciones del worker en medio de una operación se cubren en las pruebas unitarias
  (`tests/interruption.test.ts`), no aquí; los cortes duros (S4) sí son reales.
- Una sola corrida por escenario: no hay estadística (percentiles) de los tiempos.
- La medición de memoria es exclusiva de Windows (`Win32_Process`).
