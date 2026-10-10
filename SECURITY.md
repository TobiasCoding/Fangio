# Política de seguridad

## Versiones con soporte

Sólo la **última versión publicada** en
[Releases](https://github.com/TobiasCoding/Fangio/releases/latest) recibe correcciones de
seguridad. Actualizá con `update.cmd` / `update.ps1` / `update.sh` (ver
[docs/INSTALL.md](docs/INSTALL.md#actualizar)).

## Cómo reportar una vulnerabilidad

**No abras un issue público.** Usá el reporte privado de GitHub:

1. Entrá a la pestaña [**Security**](https://github.com/TobiasCoding/Fangio/security) del
   repositorio.
2. Tocá **Report a vulnerability** y completá el formulario.

Incluí, si podés: versión de Fangio y del navegador, sistema operativo, pasos para
reproducir, impacto esperado y una prueba de concepto mínima. Por favor no incluyas datos
personales reales (por ejemplo, tu propia exportación de pestañas).

Qué podés esperar:

- Acuse de recibo dentro de los 7 días.
- Una evaluación inicial y un plan dentro de los 30 días.
- Crédito en las notas de la versión con la corrección, si lo deseás.

## Alcance

Interesan especialmente:

- Pérdida o corrupción de datos (pestañas cerradas sin referencia guardada, registros
  borrados fuera de la política de la papelera).
- Fugas de datos: cualquier vía por la que información de tus pestañas salga del equipo.
- Ejecución de código o inyección en el panel o el popup (por ejemplo, a través de títulos,
  URLs o archivos de importación maliciosos).
- Los scripts `install.ps1`, `update.ps1` y `update.sh`: verificación de integridad
  (SHA-256, nombre y `key` del manifiesto), manejo de rutas y restauración ante fallos.
- El flujo de publicación (`.github/workflows/`).

Fuera de alcance: problemas que requieren acceso previo al equipo o al perfil del navegador
con permisos de usuario, y las limitaciones documentadas en el README.

## Modelo de amenazas, en breve

- Fangio no tiene servidor ni cuentas; los datos viven en IndexedDB dentro del perfil.
- No tiene permisos de host ni scripts de contenido; la CSP de sus páginas sólo permite
  scripts propios (`script-src 'self'`).
- Los releases se compilan en GitHub Actions desde la etiqueta, sin minificar, y se
  publican con su SHA-256. Los actualizadores verifican esa suma y que el manifiesto
  descargado tenga la misma `key` que la instalación.
- La suma se descarga del mismo release que el zip: protege contra descargas corruptas o
  incompletas, no contra un compromiso de la cuenta de GitHub del proyecto.
