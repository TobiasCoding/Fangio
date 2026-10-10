# Registro de cambios

Todos los cambios relevantes de Fangio se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto
usa [Versionado Semántico](https://semver.org/lang/es/). Las notas de cada versión se
publican también en la página de [releases](https://github.com/TobiasCoding/Fangio/releases).

## [Unreleased]

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

[Unreleased]: https://github.com/TobiasCoding/Fangio/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/TobiasCoding/Fangio/releases/tag/v1.0.0
