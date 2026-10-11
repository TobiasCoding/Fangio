# Privacidad

Fangio funciona por completo en tu equipo.

- **Qué guarda**: URL, título, ícono, ventana y grupo de origen, fechas de apertura, último
  acceso y archivado de tus pestañas, y lo que vos agregues (notas, etiquetas, proyectos,
  marcas de pendiente o protegida), además del registro de acciones y la configuración.
- **Dónde**: en la base IndexedDB de la extensión, dentro de tu perfil del navegador. No se
  sincroniza con ninguna cuenta. Las exportaciones (JSON y HTML) son archivos que vos
  descargás y guardás donde quieras.
- **Qué no hace**: no tiene servidores, cuentas, analíticas, publicidad ni telemetría. No
  lee el contenido de las páginas (no tiene scripts de contenido) y no registra pestañas de
  incógnito.
- **Temas sugeridos**: el análisis que agrupa tus pestañas por tema usa sólo títulos, URLs y
  fechas que ya están en la base, y se calcula en tu equipo.
- **Miniaturas (opcional, apagadas por defecto)**: si las activás, Fangio guarda una captura
  reducida (320 px) de la página que estás mirando. Quedan en la base local, **no** se
  incluyen en las copias JSON y se borran al eliminar el registro o con «Borrar todas las
  miniaturas». Nunca se capturan incógnito, sitios excluidos ni páginas de inicio de sesión,
  cuenta o pagos. Para capturar automáticamente Chrome pide el permiso opcional de «leer y
  cambiar tus datos en todos los sitios»: Fangio sólo lo usa para la captura de la pestaña
  visible y lo devuelve al desactivar la opción. Sin ese permiso, las capturas se toman sólo
  al abrir el popup o al archivar con el atajo (permiso `activeTab`).
- **IA local (opcional)**: «Nombrar con IA local» usa el modelo integrado de Chrome (Gemini
  Nano), que corre en tu dispositivo; los títulos no se envían a ningún servidor. Si el
  modelo no está instalado, Chrome lo descarga una sola vez (de Google) después de que lo
  confirmes; esa descarga la hace el navegador, no Fangio, y no incluye datos tuyos.
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
