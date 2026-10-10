<#
.SYNOPSIS
    Updates an installed (unpacked) copy of Fangio to the latest GitHub release.

.DESCRIPTION
    Run it from inside the folder where Fangio is installed (the folder you chose in
    chrome://extensions > "Load unpacked"), or pass -InstallDir.

    Steps: query the GitHub releases API, compare with the local version, download the
    release zip and SHA256SUMS.txt, verify the SHA-256, extract to a temporary folder,
    check that the new manifest is Fangio with the same public key (same extension id),
    move the current files to a sibling backup folder ("<folder>.previous"), copy the new
    files in and restore the backup if anything fails.

    It only touches the installation folder. Your archive lives in the browser profile
    (IndexedDB) and is never read or modified by this script. Afterwards, reload the
    extension in chrome://extensions (or use the "Recargar extension" button in the panel).

    Compatible with Windows PowerShell 5.1 and PowerShell 7. No admin rights needed.

.PARAMETER InstallDir
    Installation folder. Defaults to the folder that contains this script.

.PARAMETER Version
    Install a specific version (e.g. 1.2.0) instead of the latest one (useful to go back).

.PARAMETER Force
    Reinstall even if the installed version is already the latest.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Fangio\extension\update.ps1"
#>
[CmdletBinding()]
param(
    [string]$InstallDir = $PSScriptRoot,
    [string]$Version,
    [switch]$Force
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is very slow in 5.1 with the progress bar

$Repo = 'TobiasCoding/Fangio'
$ApiBase = "https://api.github.com/repos/$Repo/releases"
if ($env:FANGIO_RELEASES_API) { $ApiBase = $env:FANGIO_RELEASES_API } # override only for testing
$Headers = @{ 'User-Agent' = 'Fangio-updater'; 'Accept' = 'application/vnd.github+json' }

# Messages are written with \uXXXX escapes so this file stays pure ASCII (Windows PowerShell
# 5.1 reads BOM-less scripts with the ANSI code page). Values (paths, errors) are inserted
# with -f placeholders after unescaping, so backslashes in paths are never reinterpreted.
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

function Install-Files([string]$From, [string]$To) {
    # Replace the contents of $To with the contents of $From. The current files are first
    # moved to a new sibling backup folder; if anything fails they are moved back. Only after
    # a successful update the previous backup ("<folder>.previous") is replaced.
    $parent = Split-Path -Parent $To
    $leaf = Split-Path -Leaf $To
    if (-not $parent) { Die 'No se puede actualizar en la ra\u00EDz de una unidad: {0}' $To }
    $backup = Join-Path $parent ("$leaf.previous-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $backup | Out-Null

    $moved = New-Object System.Collections.Generic.List[string]
    $phase = 'move'
    try {
        foreach ($item in @(Get-ChildItem -LiteralPath $To -Force)) {
            Move-Item -LiteralPath $item.FullName -Destination (Join-Path $backup $item.Name)
            $moved.Add($item.Name)
        }
        $phase = 'copy'
        foreach ($item in @(Get-ChildItem -LiteralPath $From -Force)) {
            Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $To $item.Name) -Recurse -Force
        }
    } catch {
        $err = $_
        Write-Warning (Msg 'Fall\u00F3 la actualizaci\u00F3n ({0}). Restaurando la versi\u00F3n anterior...' $err.Exception.Message)
        if ($phase -eq 'copy') {
            # Only new (possibly partial) files are in $To at this point.
            foreach ($item in @(Get-ChildItem -LiteralPath $To -Force)) {
                Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        foreach ($name in $moved) {
            Move-Item -LiteralPath (Join-Path $backup $name) -Destination (Join-Path $To $name) -Force
        }
        Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
        throw $err
    }

    # Keep exactly one backup: "<folder>.previous" (only ever replaced if it is Fangio's own code).
    $final = Join-Path $parent "$leaf.previous"
    if (Test-Path -LiteralPath $final) {
        $old = Read-Manifest $final
        if ((Test-FangioManifest $old) -and $old.key -eq $script:LocalKey) {
            Remove-Item -LiteralPath $final -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    if (-not (Test-Path -LiteralPath $final)) {
        try {
            Rename-Item -LiteralPath $backup -NewName "$leaf.previous"
            $backup = $final
        } catch { }
    }
    return $backup
}

# ---------------------------------------------------------------------------------------

if (-not $InstallDir) {
    Die 'No s\u00E9 d\u00F3nde est\u00E1 instalado Fangio. Ejecut\u00E1 el script desde la carpeta de la extensi\u00F3n o pas\u00E1 -InstallDir <carpeta>.'
}
if (-not (Test-Path -LiteralPath $InstallDir -PathType Container)) { Die 'No existe la carpeta {0}.' $InstallDir }
$InstallDir = (Resolve-Path -LiteralPath $InstallDir).ProviderPath
if (($InstallDir + '\') -like '*\User Data\*') { Die 'La carpeta {0} parece un perfil del navegador; no la toco.' $InstallDir }

$localManifest = Read-Manifest $InstallDir
if (-not (Test-FangioManifest $localManifest)) {
    Die ('No encontr\u00E9 una instalaci\u00F3n de Fangio en {0} (falta manifest.json de Fangio).\n' +
        'Pas\u00E1 -InstallDir <carpeta> o instal\u00E1 con install.ps1.') $InstallDir
}
$script:LocalKey = [string]$localManifest.key
$localVersion = [string]$localManifest.version
$versionFile = Join-Path $InstallDir 'VERSION'
if (Test-Path -LiteralPath $versionFile -PathType Leaf) {
    $v = (Get-Content -LiteralPath $versionFile -Raw).Trim()
    if ($v -match '^\d+\.\d+\.\d+$') { $localVersion = $v }
}
if ($Version) {
    $Version = $Version.Trim() -replace '^v', ''
    if ($Version -notmatch '^\d+\.\d+\.\d+$') { Die 'Versi\u00F3n inv\u00E1lida: {0} (us\u00E1 X.Y.Z).' $Version }
}

Say 'Fangio instalado: v{0} en {1}' @($localVersion, $InstallDir)
$release = Get-Release $Version
$target = ([string]$release.tag_name) -replace '^v', ''
if ($target -notmatch '^\d+\.\d+\.\d+$') { Die 'El release de GitHub tiene una etiqueta inesperada: {0}' $release.tag_name }

$cmp = ([version]$target).CompareTo([version]$localVersion)
if ($cmp -le 0 -and -not $Force -and -not $Version) {
    Say 'Ya ten\u00E9s la \u00FAltima versi\u00F3n (v{0}). No hay nada que hacer.' $localVersion
    exit 0
}
if ($cmp -lt 0) {
    Write-Warning (Msg 'Vas a instalar una versi\u00F3n anterior (v{0}). Si la base fue migrada por una versi\u00F3n m\u00E1s nueva, export\u00E1 una copia JSON antes.' $target)
}

$work = Join-Path ([IO.Path]::GetTempPath()) ('fangio-update-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    $pkg = Get-VerifiedRelease $release $target $work
    if ([string]$pkg.Manifest.key -ne $script:LocalKey) {
        Die 'La clave (key) del paquete no coincide con la instalada: ser\u00EDa otra extensi\u00F3n con otra base de datos. Cancelado.'
    }
    $backup = Install-Files $pkg.Dir $InstallDir
    Say ''
    Say 'Fangio actualizado: v{0} -> v{1}' @($localVersion, $target)
    Say 'Versi\u00F3n anterior guardada en {0}' $backup
    Say ''
    Say 'Abr\u00ED chrome://extensions y toc\u00E1 Recargar en Fangio (o el bot\u00F3n ''Recargar extensi\u00F3n'' del panel). Tus datos se conservan.'
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
