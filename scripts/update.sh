#!/usr/bin/env bash
# Fangio updater for Linux / macOS (bash + curl + unzip + sha256sum/shasum).
#
# Run it from inside the installed extension folder (the one loaded with "Load unpacked"),
# or pass --install-dir. It downloads the latest GitHub release, verifies its SHA-256,
# checks the manifest (name "Fangio"; the folder stays the same, so the extension id and its
# data do too), moves
# the current files to "<folder>.previous" and copies the new ones in (restoring the
# backup if anything fails). It never touches browser profile data.
#
#   bash update.sh [--install-dir DIR] [--version X.Y.Z] [--force]
set -euo pipefail

REPO="TobiasCoding/Fangio"
API="${FANGIO_RELEASES_API:-https://api.github.com/repos/${REPO}/releases}" # override only for testing
UA="Fangio-updater"
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION=""
FORCE=0

die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || die "Falta el comando '$1'."; }

while [ $# -gt 0 ]; do
  case "$1" in
    --install-dir) [ $# -ge 2 ] || die "Falta el valor de --install-dir"; INSTALL_DIR="$2"; shift 2 ;;
    --version) [ $# -ge 2 ] || die "Falta el valor de --version"; VERSION="${2#v}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "Opción desconocida: $1" ;;
  esac
done

need curl; need unzip
if command -v sha256sum >/dev/null 2>&1; then SHA256="sha256sum"
elif command -v shasum >/dev/null 2>&1; then SHA256="shasum -a 256"
else die "Falta sha256sum o shasum."; fi

# First "field": "string" value in a JSON file (good enough for GitHub's API and our manifest).
json_str() {
  tr ',{}[]' '\n\n\n\n\n' < "$2" | sed -n "s/^[[:space:]]*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1
}
is_version() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; }
# ver_cmp A B -> prints -1, 0 or 1
ver_cmp() {
  local IFS=. a b i
  read -r -a a <<< "$1"; read -r -a b <<< "$2"
  for i in 0 1 2; do
    if (( 10#${a[i]} > 10#${b[i]} )); then echo 1; return; fi
    if (( 10#${a[i]} < 10#${b[i]} )); then echo -1; return; fi
  done
  echo 0
}
is_fangio() { [ -f "$1/manifest.json" ] && [ "$(json_str name "$1/manifest.json")" = "Fangio" ]; }

[ -d "$INSTALL_DIR" ] || die "No existe la carpeta $INSTALL_DIR."
INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd -P)"
case "$INSTALL_DIR" in /|"$HOME") die "Carpeta de instalación inválida: $INSTALL_DIR" ;; esac
is_fangio "$INSTALL_DIR" || die "No encontré una instalación de Fangio en $INSTALL_DIR (falta manifest.json de Fangio). Usá --install-dir."
LOCAL_VERSION="$(json_str version "$INSTALL_DIR/manifest.json")"
if [ -f "$INSTALL_DIR/VERSION" ]; then
  v="$(tr -d '[:space:]' < "$INSTALL_DIR/VERSION")"
  if is_version "$v"; then LOCAL_VERSION="$v"; fi
fi
if [ -n "$VERSION" ] && ! is_version "$VERSION"; then die "Versión inválida: $VERSION (usá X.Y.Z)."; fi

say "Fangio instalado: v$LOCAL_VERSION en $INSTALL_DIR"
WORK="$(mktemp -d 2>/dev/null || mktemp -d -t fangio)"
trap 'rm -rf "$WORK"' EXIT

if [ -n "$VERSION" ]; then URL="$API/tags/v$VERSION"; else URL="$API/latest"; fi
curl -fsSL -H "User-Agent: $UA" -H "Accept: application/vnd.github+json" "$URL" -o "$WORK/release.json" \
  || die "No pude consultar GitHub ($URL)."
TAG="$(json_str tag_name "$WORK/release.json")"
TARGET="${TAG#v}"
is_version "$TARGET" || die "El release de GitHub tiene una etiqueta inesperada: $TAG"

CMP="$(ver_cmp "$TARGET" "$LOCAL_VERSION")"
if [ "$CMP" -le 0 ] && [ "$FORCE" -eq 0 ] && [ -z "$VERSION" ]; then
  say "Ya tenés la última versión (v$LOCAL_VERSION). No hay nada que hacer."
  exit 0
fi
[ "$CMP" -lt 0 ] && say "AVISO: vas a instalar una versión anterior (v$TARGET). Exportá una copia JSON antes."

ZIP="fangio-v$TARGET.zip"
asset_url() { tr ',{}[]' '\n\n\n\n\n' < "$WORK/release.json" | sed -n 's/^[[:space:]]*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | grep -F "/$1" | head -n 1 || true; }
ZIP_URL="$(asset_url "$ZIP")"
SUMS_URL="$(asset_url SHA256SUMS.txt)"
[ -n "$ZIP_URL" ] && [ -n "$SUMS_URL" ] || die "El release v$TARGET no tiene $ZIP y SHA256SUMS.txt."

say "Descargando $ZIP ..."
curl -fsSL -H "User-Agent: $UA" "$ZIP_URL" -o "$WORK/$ZIP" || die "Falló la descarga de $ZIP."
curl -fsSL -H "User-Agent: $UA" "$SUMS_URL" -o "$WORK/SHA256SUMS.txt" || die "Falló la descarga de SHA256SUMS.txt."
EXPECTED="$(awk -v n="$ZIP" '$2 == n || $2 == "*" n { print tolower($1) }' "$WORK/SHA256SUMS.txt" | head -n 1)"
[ -n "$EXPECTED" ] || die "SHA256SUMS.txt no contiene una suma para $ZIP."
ACTUAL="$($SHA256 "$WORK/$ZIP" | awk '{ print tolower($1) }')"
[ "$ACTUAL" = "$EXPECTED" ] || die "La suma SHA-256 no coincide (esperada $EXPECTED, obtenida $ACTUAL). No se instaló nada."
say "SHA-256 verificado: $ACTUAL"

NEW="$WORK/extracted"
mkdir -p "$NEW"
unzip -q "$WORK/$ZIP" -d "$NEW"
is_fangio "$NEW" || die "El paquete descargado no contiene un manifest.json de Fangio válido."
[ "$(json_str version "$NEW/manifest.json")" = "$TARGET" ] || die "El paquete no es la versión $TARGET."
[ -f "$NEW/background.js" ] || die "Al paquete le falta background.js."

# Current files go to a new sibling backup folder; only after a successful update does it
# replace "<folder>.previous" (which is only ever deleted if it is Fangio's own code).
BACKUP="$INSTALL_DIR.previous-$(date +%Y%m%d-%H%M%S)"
mkdir -p -- "$BACKUP"

shopt -s dotglob nullglob
restore() {
  say "Falló la actualización. Restaurando la versión anterior..."
  if [ "$1" = copy ]; then
    for item in "$INSTALL_DIR"/*; do rm -rf -- "$item"; done
  fi
  for item in "$BACKUP"/*; do mv -f -- "$item" "$INSTALL_DIR/"; done
  rmdir -- "$BACKUP" 2>/dev/null || true
}
for item in "$INSTALL_DIR"/*; do
  mv -- "$item" "$BACKUP/" || { restore move; die "No pude mover $item."; }
done
cp -R -- "$NEW"/* "$INSTALL_DIR"/ || { restore copy; die "No pude copiar los archivos nuevos."; }
chmod +x "$INSTALL_DIR/update.sh" 2>/dev/null || true

FINAL="$INSTALL_DIR.previous"
if [ -e "$FINAL" ] && is_fangio "$FINAL"; then
  rm -rf -- "$FINAL"
fi
if [ ! -e "$FINAL" ] && mv -- "$BACKUP" "$FINAL" 2>/dev/null; then BACKUP="$FINAL"; fi

say ""
say "Fangio actualizado: v$LOCAL_VERSION -> v$TARGET"
say "Versión anterior guardada en $BACKUP"
say ""
say "Abrí chrome://extensions y tocá Recargar en Fangio (o el botón 'Recargar extensión' del panel). Tus datos se conservan."
