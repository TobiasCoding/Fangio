# Privacidad

Fangio funciona por completo en tu equipo.

- **Qué guarda**: URL, título, ícono, ventana y grupo de origen, fechas de apertura, último
  acceso y archivado de tus pestañas, y lo que vos agregues (notas, etiquetas, proyectos,
  marcas de pendiente o protegida), además del registro de acciones y la configuración.
- **Dónde**: en la base IndexedDB de la extensión, dentro de tu perfil del navegador. No se
  sincroniza con ninguna cuenta. Las exportaciones (JSON y HTML) son archivos que vos
  descargás y guardás donde quieras.
- **Qué no hace**: no tiene servidores, cuentas, analíticas, publicidad ni telemetría. No
  lee el contenido de las páginas (no tiene permisos de host ni scripts de contenido) y
  no registra pestañas de incógnito.
- **Única conexión de red**: si la opción de buscar actualizaciones está activa (lo está
  por defecto), una vez por día consulta
  `https://api.github.com/repos/TobiasCoding/Fangio/releases/latest`. La petición no
  incluye datos tuyos ni de tus pestañas; como cualquier conexión, GitHub ve tu dirección
  IP y el navegador. Se desactiva en la configuración del panel.
- **Íconos de sitios**: se leen de la caché del propio navegador (permiso `favicon`); Fangio
  no visita los sitios para obtenerlos.
- **Scripts de instalación y actualización**: sólo se conectan a GitHub (API de releases y
  descarga de archivos del release) y sólo escriben en la carpeta de la extensión y en una
  carpeta temporal.
- **Borrado**: eliminar registros desde la papelera los borra de la base. Quitar la
  extensión borra toda la base. Las copias que hayas exportado no se ven afectadas.

Política de privacidad de GitHub: <https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement>.
