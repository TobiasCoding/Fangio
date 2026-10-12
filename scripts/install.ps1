<#
.SYNOPSIS
    Downloads the latest Fangio release and leaves it ready to "Load unpacked" in Chrome.

.DESCRIPTION
    Installs into %LOCALAPPDATA%\Fangio\extension (or -InstallDir). Downloads the release
    zip and SHA256SUMS.txt from GitHub, verifies the SHA-256, checks the manifest and copies
    the files. Then prints the steps to load the folder in chrome://extensions.

    If Fangio is already installed in that folder, it runs the installed update.ps1 instead.
    Never touches browser profiles. No admin rights needed. Windows PowerShell 5.1+.

.PARAMETER InstallDir
    Destination folder (permanent: Chrome loads the extension from here every time).

.PARAMETER Version
    Install a specific version (X.Y.Z) instead of the latest.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
    irm https://raw.githubusercontent.com/TobiasCoding/Fangio/main/scripts/install.ps1 | iex
#>
[CmdletBinding()]
param(
    [string]$InstallDir,
    [string]$Version
)

Set-StrictMode -Version 2.0

# Windows PowerShell started from PowerShell 7 through another program (cmd, update.cmd)
# inherits PowerShell 7's PSModulePath, whose modules hide Get-FileHash and Expand-Archive.
# Keep only Windows PowerShell's own module folders for this process.
if ($PSVersionTable.PSEdition -ne 'Core' -and $env:PSModulePath) {
    $env:PSModulePath = (($env:PSModulePath -split ';') | Where-Object { $_ -and $_ -notlike '*\PowerShell\*' }) -join ';'
}
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo = 'TobiasCoding/Fangio'
$ApiBase = "https://api.github.com/repos/$Repo/releases"
if ($env:FANGIO_RELEASES_API) { $ApiBase = $env:FANGIO_RELEASES_API } # override only for testing
$Headers = @{ 'User-Agent' = 'Fangio-installer'; 'Accept' = 'application/vnd.github+json' }

# See update.ps1: messages use \uXXXX escapes so the file stays ASCII; values go in via -f.
function Msg([string]$Text, [object[]]$Values = @()) {
    $t = [regex]::Unescape($Text)
    if ($Values.Count -gt 0) { return ($t -f $Values) }
    return $t
}
function Say([string]$Text, [object[]]$Values = @()) { Write-Host (Msg $Text $Values) }
function Die([string]$Text, [object[]]$Values = @()) { throw (Msg $Text $Values) }

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }
function Read-Manifest([string]$Dir) {
    $path = Join-Path $Dir 'manifest.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try {
        return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Test-FangioManifest($Manifest) {
    if ($null -eq $Manifest) { return $false }
    $names = @($Manifest.PSObject.Properties.Name)
    return ($names -contains 'name') -and ($Manifest.name -eq 'Fangio') -and
        ($names -contains 'key') -and ([string]$Manifest.key).Length -gt 0 -and
        ($names -contains 'version')
}

function Get-Release([string]$WantedVersion) {
    if ($WantedVersion) { $uri = "$ApiBase/tags/v$WantedVersion" } else { $uri = "$ApiBase/latest" }
    try {
        return Invoke-RestMethod -Uri $uri -Headers $Headers -UseBasicParsing
    } catch {
        Die 'No pude consultar GitHub ({0}): {1}' @($uri, $_.Exception.Message)
    }
}

function Get-VerifiedRelease($Release, [string]$Ver, [string]$WorkDir) {
    $zipName = "fangio-v$Ver.zip"
    $zipAsset = @($Release.assets | Where-Object { $_.name -eq $zipName }) | Select-Object -First 1
    $sumAsset = @($Release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' }) | Select-Object -First 1
    if (-not $zipAsset -or -not $sumAsset) { Die 'El release v{0} no tiene {1} y SHA256SUMS.txt.' @($Ver, $zipName) }

    $zipPath = Join-Path $WorkDir $zipName
    $sumPath = Join-Path $WorkDir 'SHA256SUMS.txt'
    Say 'Descargando {0} ...' $zipName
    Invoke-WebRequest -Uri $zipAsset.browser_download_url -OutFile $zipPath -Headers $Headers -UseBasicParsing
    Invoke-WebRequest -Uri $sumAsset.browser_download_url -OutFile $sumPath -Headers $Headers -UseBasicParsing

    $expected = $null
    foreach ($line in (Get-Content -LiteralPath $sumPath)) {
        if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(\S+)\s*$' -and $Matches[2] -eq $zipName) {
            $expected = $Matches[1].ToLowerInvariant()
        }
    }
    if (-not $expected) { Die 'SHA256SUMS.txt no contiene una suma para {0}.' $zipName }
    $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        Die 'La suma SHA-256 no coincide (esperada {0}, obtenida {1}). No se instal\u00F3 nada.' @($expected, $actual)
    }
    Say 'SHA-256 verificado: {0}' $actual

    $extract = Join-Path $WorkDir 'extracted'
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extract -Force
    $newManifest = Read-Manifest $extract
    if (-not (Test-FangioManifest $newManifest)) { Die 'El paquete descargado no contiene un manifest.json de Fangio v\u00E1lido.' }
    if ($newManifest.version -ne $Ver) { Die 'El paquete dice ser la versi\u00F3n {0}, no {1}.' @($newManifest.version, $Ver) }
    if (-not (Test-Path -LiteralPath (Join-Path $extract 'background.js') -PathType Leaf)) { Die 'Al paquete le falta background.js.' }
    return @{ Dir = $extract; Manifest = $newManifest }
}

# ---------------------------------------------------------------------------------------
# Everything runs inside a function so that `irm ... | iex` never calls `exit` on the
# user's PowerShell session.
function Install-Fangio {

    if (-not $InstallDir) {
        if (-not $env:LOCALAPPDATA) { Die 'No encuentro %LOCALAPPDATA%; pas\u00E1 -InstallDir <carpeta>.' }
        $InstallDir = Join-Path $env:LOCALAPPDATA 'Fangio\extension'
    }
    $InstallDir = [IO.Path]::GetFullPath($InstallDir)
    if (($InstallDir + '\') -like '*\User Data\*') { Die 'La carpeta {0} parece un perfil del navegador; eleg\u00ED otra.' $InstallDir }
    if ($Version) {
        $Version = $Version.Trim() -replace '^v', ''
        if ($Version -notmatch '^\d+\.\d+\.\d+$') { Die 'Versi\u00F3n inv\u00E1lida: {0} (us\u00E1 X.Y.Z).' $Version }
    }

    if (Test-Path -LiteralPath $InstallDir -PathType Container) {
        $existing = Read-Manifest $InstallDir
        if (Test-FangioManifest $existing) {
            $updater = Join-Path $InstallDir 'update.ps1'
            Say 'Fangio ya est\u00E1 instalado en {0} (v{1}).' @($InstallDir, $existing.version)
            if (Test-Path -LiteralPath $updater -PathType Leaf) {
                Say 'Busco actualizaciones con update.ps1...'
                $updArgs = @{ InstallDir = $InstallDir }
                if ($Version) { $updArgs.Version = $Version }
                & $updater @updArgs
                return
            }
            Die 'Para actualizar, descarg\u00E1 update.ps1 del repositorio y ejecutalo con -InstallDir.'
        }
        if (@(Get-ChildItem -LiteralPath $InstallDir -Force).Count -gt 0) {
            Die 'La carpeta {0} ya existe y no est\u00E1 vac\u00EDa. Eleg\u00ED otra con -InstallDir.' $InstallDir
        }
    }

    $release = Get-Release $Version
    $target = ([string]$release.tag_name) -replace '^v', ''
    if ($target -notmatch '^\d+\.\d+\.\d+$') { Die 'El release de GitHub tiene una etiqueta inesperada: {0}' $release.tag_name }
    Say 'Instalando Fangio v{0} en {1}' @($target, $InstallDir)

    $work = Join-Path ([IO.Path]::GetTempPath()) ('fangio-install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    try {
        $pkg = Get-VerifiedRelease $release $target $work
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        foreach ($item in @(Get-ChildItem -LiteralPath $pkg.Dir -Force)) {
            Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $InstallDir $item.Name) -Recurse -Force
        }
    } finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }

    $copied = $false
    try { Set-Clipboard -Value $InstallDir; $copied = $true } catch { }

    Say ''
    Say 'Fangio v{0} qued\u00F3 en: {1}' @($target, $InstallDir)
    if ($copied) { Say '(La ruta ya est\u00E1 copiada en el portapapeles.)' }
    Say ''
    Say 'Para cargarla en Chrome (una sola vez):'
    Say '  1. Abr\u00ED chrome://extensions'
    Say '  2. Activ\u00E1 "Modo de desarrollador" (arriba a la derecha).'
    Say '  3. Toc\u00E1 "Cargar descomprimida" y eleg\u00ED la carpeta de arriba.'
    Say '  4. Fij\u00E1 el \u00EDcono de Fangio en la barra (\u00EDcono de pieza de rompecabezas).'
    Say ''
    Say 'No borres ni muevas esa carpeta: Chrome carga Fangio desde ah\u00ED.'
    Say 'Para actualizar m\u00E1s adelante: ejecut\u00E1 update.cmd (o update.ps1) dentro de esa carpeta.'
}

Install-Fangio
