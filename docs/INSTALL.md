# Instalar, actualizar y desinstalar Fangio

Fangio se distribuye como **extensión descomprimida** («unpacked») desde los
[releases de GitHub](https://github.com/TobiasCoding/Fangio/releases). Funciona en Chrome 121
o posterior y en otros navegadores Chromium (Edge, Brave, Vivaldi, Opera…; la página de
extensiones cambia de nombre, por ejemplo `edge://extensions`).

> [!WARNING]
> **«Quitar» la extensión borra su base de datos.** Recargarla o actualizarla no borra
> nada. Antes de desinstalar, mover la carpeta o cambiar de perfil, exportá una copia en
> **Panel → Copias → Exportar JSON**.

## Instalación

### Opción A: zip del release (cualquier sistema)

1. Entrá al [último release](https://github.com/TobiasCoding/Fangio/releases/latest) y
   descargá `fangio-vX.Y.Z.zip` (y, si querés verificarlo, `SHA256SUMS.txt`).
2. Verificá la suma (opcional, recomendado):
   - Windows (PowerShell): `(Get-FileHash .\fangio-vX.Y.Z.zip -Algorithm SHA256).Hash`
     y comparalo con el valor de `SHA256SUMS.txt` (no distingue mayúsculas).
   - Linux: `sha256sum -c SHA256SUMS.txt` · macOS: `shasum -a 256 -c SHA256SUMS.txt`.
3. Extraé el zip en una **carpeta permanente** (los archivos quedan directamente en ella,
   junto a `manifest.json`). Sugerencias:
   - Windows: `%LOCALAPPDATA%\Fangio\extension`
   - Linux: `~/.local/share/fangio/extension`
   - macOS: `~/Library/Application Support/Fangio/extension`

   No uses Descargas, el Escritorio ni carpetas temporales o sincronizadas: Chrome carga
   la extensión desde esa carpeta cada vez que arranca.
4. Abrí `chrome://extensions`.
5. Activá el **Modo de desarrollador** (interruptor arriba a la derecha).
6. Tocá **Cargar descomprimida** y elegí la carpeta del paso 3.
7. Fijá Fangio en la barra: menú de extensiones (ícono de pieza de rompecabezas) → fijar.

### Opción B: `install.ps1` (Windows)

Abrí PowerShell (no hace falta como administrador) y ejecutá:

```powershell
irm https://raw.githubusercontent.com/TobiasCoding/Fangio/main/scripts/install.ps1 | iex
```

O descargá [`scripts/install.ps1`](../scripts/install.ps1) y ejecutalo como archivo, lo
que permite elegir carpeta o versión:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -InstallDir "$env:USERPROFILE\Apps\Fangio"
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Version 1.0.0
```

El script consulta el último release, descarga el zip y `SHA256SUMS.txt`, **verifica el
SHA-256**, comprueba que el paquete sea Fangio y lo copia a
`%LOCALAPPDATA%\Fangio\extension` (por defecto). Copia la ruta al portapapeles y te muestra
los pasos 4 a 7 de la opción A. Si Fangio ya estaba instalado en esa carpeta, ejecuta el
actualizador en su lugar. Nunca toca los perfiles del navegador.

## Primer arranque

Al instalarse, Fangio registra todas las pestañas abiertas y abre el asistente de
importación. Exportá una copia JSON antes de archivar nada. Ver
[Primer uso](../README.md#primer-uso).

## Actualizar

1. Cuando hay una versión nueva, el panel de Fangio muestra un aviso (la consulta diaria se
   puede desactivar en la configuración; también podés mirar la página de releases).
2. Ejecutá el actualizador que está **dentro de la carpeta instalada**:
   - **Windows**: doble clic en `update.cmd`, o desde PowerShell:
     `powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Fangio\extension\update.ps1"`
   - **Linux / macOS**: `bash ~/.local/share/fangio/extension/update.sh`
     (necesita `curl`, `unzip` y `sha256sum` o `shasum`).
3. En `chrome://extensions` tocá **Recargar** en la tarjeta de Fangio, o usá el botón
   **Recargar extensión** del aviso en el panel. **Tus datos se conservan.**

Qué hace el actualizador, paso a paso:

1. Lee la versión instalada (`VERSION` / `manifest.json`) y consulta
   `https://api.github.com/repos/TobiasCoding/Fangio/releases/latest`.
2. Si hay una versión más nueva, descarga `fangio-vX.Y.Z.zip` y `SHA256SUMS.txt` a una
   carpeta temporal y **verifica el SHA-256**. Si no coincide, no instala nada.
3. Extrae el zip y comprueba que el `manifest.json` nuevo sea de Fangio y de esa versión.
   Los archivos nuevos van a **la misma carpeta**: el ID de una extensión descomprimida
   depende de su carpeta, así que la extensión (y su base de datos) sigue siendo la misma.
4. Mueve los archivos actuales a una carpeta hermana de respaldo, copia los nuevos y, si
   algo falla, restaura los anteriores. Al terminar, la versión anterior queda en
   `<carpeta>.previous` (por ejemplo `...\Fangio\extension.previous`).
5. Nunca toca tu perfil del navegador: la base de datos de Fangio vive ahí y no se modifica.

Opciones: `-Force` / `--force` reinstala la misma versión; `-Version X.Y.Z` /
`--version X.Y.Z` instala una versión concreta (sirve para volver atrás; si bajás de
versión, exportá antes una copia JSON); `-InstallDir` / `--install-dir` indica la carpeta si
ejecutás el script desde otro lugar.

### Volver a la versión anterior

Ejecutá el actualizador con `-Version X.Y.Z` (o `--version X.Y.Z`), o bien intercambiá el
contenido de la carpeta con el de `<carpeta>.previous` y tocá **Recargar**.

### Por qué no se actualiza sola

Las extensiones de la Chrome Web Store se actualizan solas. Fangio no está publicada ahí y,
fuera de la tienda, Chrome no ofrece una vía de actualización automática para usuarios
comunes de Windows ni de macOS:

- La documentación oficial reconoce sólo dos mecanismos de distribución: la Chrome Web
  Store y el autoalojamiento (*self-hosting*). En Windows y macOS, las extensiones
  autoalojadas sólo se pueden instalar mediante **políticas empresariales** (equipos
  administrados), y las extensiones descomprimidas están pensadas para cargar código de
  confianza durante el desarrollo.
  Fuente: [Distribute your extension](https://developer.chrome.com/docs/extensions/how-to/distribute).
- Linux es la única plataforma donde se pueden instalar extensiones alojadas fuera de la
  tienda (un `.crx` firmado con un `update_url` que Chrome consulta cada pocas horas).
  Fuente: [Self-host for Linux](https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux).
- Desde Chrome 33 (Windows) y 44 (macOS) no se permiten instalaciones externas desde un
  `.crx` local, y en esas plataformas el `update_url` de los métodos de instalación
  alternativos tiene que apuntar a la Chrome Web Store.
  Fuente: [Use alternative installation methods](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions).
- Una extensión cargada con **Cargar descomprimida** no tiene mecanismo de actualización:
  Chrome usa los archivos de la carpeta tal cual y los vuelve a leer al tocar **Recargar**.

Por eso el circuito de Fangio es: aviso diario dentro de la extensión → actualizador local
que reemplaza los archivos de forma verificada → **Recargar**. Como la carpeta no cambia, el
ID de la extensión tampoco: la versión recargada es la misma extensión y conserva su base de
datos. (Instalada desde la Chrome Web Store, la tienda la actualiza sola y no hace falta nada
de esto.)

### Pasar de la v1.1.0 (o anterior) a la v1.1.1

Hasta la v1.1.0 el manifiesto tenía una clave (`key`) que fijaba el ID. La v1.1.1 ya no la
tiene, así que **es otra extensión con otra base de datos** y el actualizador de la v1.1.0 se
niega a instalarla («la clave no coincide»). Para pasar sin perder nada:

1. En la versión vieja: **Panel → Copias → Exportar copia JSON**.
2. Quitá la versión vieja en `chrome://extensions` (o dejala desactivada hasta comprobar la
   nueva).
3. Instalá la v1.1.1 (descomprimida, con `install.ps1`, o desde la Chrome Web Store).
4. En la nueva: **Copias → Importar JSON** con el archivo del paso 1. Las pestañas que siguen
   abiertas se unen a su registro (no quedan duplicadas) y recuperan notas, etiquetas y fechas.

## Desinstalar, mover o cambiar de equipo

1. **Exportá una copia JSON** (Panel → Copias). Opcionalmente, también el HTML de marcadores.
2. Desinstalar: **Quitar** en `chrome://extensions` (esto **borra la base**) y después borrá
   la carpeta de instalación y `<carpeta>.previous`.
3. Mover la carpeta, o pasar a otro equipo o perfil: instalá en el nuevo lugar e importá la
   copia JSON en **Copias → Importar JSON**. No muevas la carpeta de una extensión cargada
   sin haber exportado antes.

## Problemas frecuentes

- **«No se pudo cargar el manifiesto»**: elegiste una carpeta de más arriba o de más abajo;
  tiene que ser la que contiene `manifest.json`.
- **La extensión dejó de cargar después de mover o borrar la carpeta**: Chrome no la
  encuentra. Volvé a ponerla en su lugar y tocá **Recargar**.
- **Chrome muestra un aviso sobre extensiones en modo de desarrollador**: es normal en
  extensiones descomprimidas; podés cerrarlo.
- **PowerShell dice que la ejecución de scripts está deshabilitada**: usá `update.cmd` o
  `powershell -NoProfile -ExecutionPolicy Bypass -File ...` (sólo afecta a ese comando).
- **El actualizador de la v1.1.0 dice que la clave no coincide** al pasar a la v1.1.1: es
  esperable (la v1.1.1 ya no tiene `key`). Seguí los pasos de «Pasar de la v1.1.0 (o
  anterior) a la v1.1.1».
