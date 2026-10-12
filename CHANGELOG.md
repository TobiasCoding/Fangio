# Registro de cambios

Todos los cambios relevantes de Fangio se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto
usa [Versionado Semántico](https://semver.org/lang/es/). Las notas de cada versión se
publican también en la página de [releases](https://github.com/TobiasCoding/Fangio/releases).

## [Unreleased]

### Corregido

- `update.ps1` / `update.cmd` no encontraban la carpeta instalada al ejecutarse con Windows
  PowerShell 5.1 (`$PSScriptRoot` vacío como valor por defecto de un parámetro) y pedían
  `-InstallDir`. Ahora usan la carpeta del script.
- `update.cmd` lanzado desde PowerShell 7 fallaba con «Get-FileHash no se reconoce»: Windows
  PowerShell heredaba la ruta de módulos de PowerShell 7. `update.cmd`, `update.ps1` e
  `install.ps1` ahora usan sólo los módulos de Windows PowerShell.

## [1.1.0] - 2026-10-11

### Agregado

- **Vistas del listado**: Lista, **Tarjetas** (miniatura de la página o póster generado con
  el color e ícono del sitio), **Línea de tiempo** (por día y por sesión de trabajo, con
  histograma de actividad por hora y selección de un día o una sesión completa) y **Temas**.
  Todas comparten búsqueda, filtros, selección y acciones.
- **Temas sugeridos**: análisis contextual local que agrupa referencias relacionadas aunque
  sean de sitios distintos, combinando palabras en común (títulos, lo que buscaste en
  Google/Bing/YouTube/Mercado Libre y palabras de la URL), cercanía en el tiempo y estructura
  (pestaña de origen, grupo de Chrome, proyecto). Muestra el recorrido (búsqueda → chat con
  IA → sitios), los términos en común y la afinidad, y permite seleccionar, asignar proyecto,
  etiquetar, crear un grupo de pestañas de Chrome, reabrir, archivar o descartar la sugerencia.
  Investigación y diseño en `docs/CONTEXT.md`.
- **Nombrar con IA local** (opcional): usa Gemini Nano integrado en Chrome, en el dispositivo,
  para nombrar los grupos y señalar títulos que no pertenecen. Sólo aparece si el navegador
  y el equipo lo permiten.
- **Miniaturas de páginas** (opcional, apagadas por defecto): captura reducida de la pestaña
  visible, guardada sólo localmente, nunca en las copias. Exclusiones propias, filtro de
  páginas sensibles y botón para borrarlas.
- Se registra la **pestaña de origen** de cada pestaña nueva (`openerId`), incluida en las
  copias JSON.

### Cambiado

- Base de datos versión 2 (migración aditiva: nuevo almacén `thumbs`; los registros no cambian).
- Permisos: se agrega `activeTab` (sin advertencia) y el permiso de host **opcional**
  `<all_urls>`, que sólo se pide al activar las miniaturas automáticas.

## [1.0.0] - 2026-10-10

Primera versión pública.

### Agregado

- Archivo local de pestañas en IndexedDB: cada pestaña abierta queda registrada desde la
  instalación (foto inicial de todas las ventanas) y se actualiza con cada cambio.
- Cierre seguro en cinco pasos: guardar → confirmar escritura → revalidar → cerrar →
  registrar. Si algo no coincide, la pestaña queda abierta.
- Protecciones que prevalecen siempre: pestañas protegidas, fijadas, activas,
  seleccionadas, con audio, sitios excluidos, incógnito y páginas internas.
- Panel completo con búsqueda (título, URL y nota), filtros (estado, dominio, etiquetas,
  proyecto, pendientes, protegidas), lista virtualizada y acciones por selección.
- Popup para la pestaña actual: archivar, proteger, marcar pendiente, nota y etiquetas.
- Atajos de teclado: `Alt+Shift+F` abre el panel y `Alt+Shift+A` archiva la pestaña actual.
- Asistente de importación inicial con copia de seguridad previa.
- Reglas automáticas (apagadas por defecto) con previsualización: inactividad, objetivo de
  pestañas abiertas (15 por defecto) y reglas por URL exacta.
- Vista de duplicados con fusión manual.
- Papelera con eliminación definitiva configurable (30 días por defecto; 0 = nunca).
- Registro de acciones con deshacer.
- Copias de seguridad: exportación JSON versionada e importación sin pérdidas, y
  exportación HTML en formato de marcadores.
- Aviso opcional de nuevas versiones (consulta diaria a la API de releases de GitHub) y
  scripts `install.ps1`, `update.ps1` / `update.cmd` y `update.sh` para instalar y
  actualizar la carpeta de la extensión.

[Unreleased]: https://github.com/TobiasCoding/Fangio/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/TobiasCoding/Fangio/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/TobiasCoding/Fangio/releases/tag/v1.0.0
