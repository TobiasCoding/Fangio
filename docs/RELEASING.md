# Publicar versiones de Fangio

Guía para mantenedores. Resumen: **una etiqueta `vX.Y.Z` en `main` = un release**.

## Versionado

- Versionado semántico `X.Y.Z` (sin sufijos: Chrome sólo acepta números en `version`).
  - `patch`: correcciones sin cambios de comportamiento visibles.
  - `minor`: funciones nuevas compatibles; migraciones de base sin pérdida.
  - `major`: cambios incompatibles (por ejemplo, formato de exportación nuevo).
- La única fuente de verdad es `version` en `package.json`. `static/manifest.json` tiene
  `"version": "0.0.0"` como marcador: `scripts/build.mjs` inyecta la versión real en
  `dist/manifest.json` y escribe `dist/VERSION` (que leen los actualizadores).
- Cada cambio relevante se anota en la sección `## [Unreleased]` de `CHANGELOG.md`
  (formato [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/)) en el mismo PR.

## Flujo normal

```bash
git switch main && git pull
npm ci
npm run release -- patch     # o minor | major | X.Y.Z
git push origin main --follow-tags
```

`scripts/release.mjs`:

1. Exige la rama `main`, árbol limpio, que la etiqueta no exista y notas en `[Unreleased]`.
2. Corre `npm run typecheck` y `npm test` sobre el árbol limpio.
3. Actualiza `package.json` y `package-lock.json`, mueve las notas a
   `## [X.Y.Z] - AAAA-MM-DD`, actualiza los enlaces de comparación y corre `npm run build`
   (que falla si la versión no es `X.Y.Z`). Si algo falla, restaura los tres archivos.
4. Crea el commit `release: vX.Y.Z` y la etiqueta anotada `vX.Y.Z`.
5. Imprime (no ejecuta) `git push origin main --follow-tags`.

Al recibir la etiqueta, `.github/workflows/release.yml`:

1. Verifica que la etiqueta sea exactamente `v` + `package.json.version` (si no, falla).
2. `npm ci`, typecheck, pruebas, `npm run package` con `SOURCE_DATE_EPOCH` = fecha del
   commit (zip reproducible).
3. Crea el release con `gh release create` (CLI preinstalada en los runners, autenticada
   con `GITHUB_TOKEN`), lo marca como *latest* y adjunta `fangio-vX.Y.Z.zip` y
   `SHA256SUMS.txt`. Las notas salen de la sección de `CHANGELOG.md` (con
   `scripts/changelog-notes.mjs`) más un pie con instrucciones y el SHA-256; si no hay
   sección, usa `--generate-notes`.

Las extensiones instaladas detectan el release en su consulta diaria a
`/releases/latest`, y `update.ps1` / `update.sh` lo instalan.

## Primera versión (1.0.0)

`package.json` ya está en `1.0.0` y `CHANGELOG.md` ya tiene su sección. Pasando la versión
**actual**, el script sólo verifica, compila y etiqueta (sin commit de versión):

```bash
npm run release -- 1.0.0
git push origin main --follow-tags
```

## Contenido del release

`npm run package` (= `npm run build` + `scripts/package.mjs`) genera en `release/`:

- `fangio-vX.Y.Z.zip`: el contenido de `dist/` en la raíz del zip (`manifest.json`,
  `background.js`, `dashboard.*`, `popup.*`, `icons/`, `VERSION`, `update.ps1`,
  `update.cmd`, `update.sh`). JavaScript **sin minificar** y sin *sourcemaps*, para que
  cualquiera pueda auditar lo que se ejecuta.
- `SHA256SUMS.txt`: formato de `sha256sum` (`<hash>  fangio-vX.Y.Z.zip`).

El zip se arma sin dependencias (deflate de `zlib`, CRC-32, nombres UTF-8). Para revisarlo:
`unzip -l release/fangio-vX.Y.Z.zip` o `Expand-Archive` en PowerShell.

## Si algo sale mal

- **El workflow falló antes de crear el release**: corregí en `main`, borrá la etiqueta
  (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`) y volvé a publicar con una
  versión nueva (preferible) o la misma.
- **El release salió con un problema**: no reemplaces archivos de un release publicado
  (los usuarios verifican el SHA-256). Publicá una versión `patch` nueva.
- **La etiqueta no coincide con `package.json`**: el workflow falla a propósito. Usá
  siempre `npm run release`.

## Probar los instaladores localmente

`install.ps1`, `update.ps1` y `update.sh` aceptan la variable de entorno
`FANGIO_RELEASES_API` (sólo para pruebas) para apuntar a un servidor local que imite
`https://api.github.com/repos/TobiasCoding/Fangio/releases` (rutas `/latest` y
`/tags/vX.Y.Z`, con `assets[].name` y `assets[].browser_download_url`). Así se puede probar
instalación, actualización, verificación de SHA-256 y restauración ante fallos sin
publicar nada. Verificación de sintaxis:

```powershell
$null = [System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw scripts/update.ps1), [ref]$null)
```

```bash
bash -n scripts/update.sh
```

Los `.ps1` se mantienen en ASCII puro (los acentos se escriben como `\uXXXX`), porque
Windows PowerShell 5.1 lee los scripts sin BOM con la página de códigos ANSI.

## Integración continua

- `.github/workflows/ci.yml`: en cada push a `main` y en cada PR corre `npm ci`,
  typecheck, pruebas y build, y sube `dist/` como artefacto. Permisos: `contents: read`.
- `.github/workflows/release.yml`: descrito arriba. Permisos: `contents: write`.
- `.github/dependabot.yml`: actualizaciones semanales de npm y de GitHub Actions.

## Clave de la extensión

`static/manifest.json` incluye la clave **pública** (`key`) que fija el ID
`domaedkeecbijcmbcjcfpjeabbdcmefb`. Publicarla es seguro y necesario: sin ella, cada
carpeta tendría otro ID y otra base de datos. La clave **privada** correspondiente no se
necesita para distribuir la extensión descomprimida, se guarda fuera del repositorio y
**nunca** debe commitearse (`*.pem` y `*.crx` están en `.gitignore`).

## Configuración recomendada del repositorio

- *Settings → Actions → General*: permitir GitHub Actions. Los workflows declaran sus
  propios permisos, así que el valor por defecto del token puede quedar en «solo lectura».
- *Settings → Security*: activar **Private vulnerability reporting** (lo usa
  [SECURITY.md](../SECURITY.md)) y las alertas de Dependabot.
- Protección de la rama `main` (PR + CI en verde) y una regla que restrinja quién puede
  crear etiquetas `v*`.
