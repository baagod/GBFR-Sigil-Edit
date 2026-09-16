#Requires -Version 5.1
<#
.SYNOPSIS
    Builds the GBFR.SigilEdit mod DLL and the SigilEditTool executable, and
    optionally packs the mod folder and a release zip.

.DESCRIPTION
    The order of the steps is a constraint, not a preference:

        1. dotnet build          -> GBFR.SigilEdit\bin\Release\GBFR.SigilEdit.dll
        2. npm ci + tsc + npm run build -> SigilEditTool\frontend\dist
        3. go build              -> SigilEditTool\SigilEdit.exe

    main.go embeds the frontend bundle at compile time
    (//go:embed all:frontend/dist). Go reads those files from disk while
    compiling, so they have to exist first: if the bundle is missing, `go build`
    stops with "pattern ...: no matching files found", and if it is stale the
    executable silently ships the previous frontend. That is why the frontend is
    built and put in place before the Go build runs.

    Every step is checked; the first failure stops the script with a non-zero
    exit code.

.PARAMETER Package
    After a successful build, assemble dist\GBFR.SigilEdit\ - the folder that is
    the whole mod: the DLL, its manifest and the tool - and write
    dist\GBFR.SigilEdit-<version>.zip holding that folder and the documents.
    Unzipping the folder into Reloaded-II\Mods\ is the entire deployment; there
    is no install step inside the tool.

.EXAMPLE
    ./build.ps1

.EXAMPLE
    ./build.ps1 -Package
#>
[CmdletBinding()]
param(
    [switch]$Package
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root     = $PSScriptRoot
$csproj   = Join-Path $root 'GBFR.SigilEdit\GBFR.SigilEdit.csproj'
$modDll   = Join-Path $root 'GBFR.SigilEdit\bin\Release\GBFR.SigilEdit.dll'
$modCfg   = Join-Path $root 'GBFR.SigilEdit\ModConfig.json'
$modIcon  = Join-Path $root 'icon\sigiledit-256.png'
$toolDir  = Join-Path $root 'SigilEditTool'
$frontend = Join-Path $toolDir 'frontend'
$exe      = Join-Path $toolDir 'SigilEdit.exe'
$distHtml = Join-Path $frontend 'dist\index.html'

function Assert-Tool {
    param([string]$Name, [string]$Hint)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "'$Name' was not found on PATH. $Hint"
    }
}

function Assert-ExitCode {
    param([string]$What)
    if ($LASTEXITCODE -ne 0) {
        throw "$What failed with exit code $LASTEXITCODE."
    }
}

# npm resolves to npm.ps1 here, which a restricted execution policy blocks, so
# prefer the .cmd shim.
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }

Assert-Tool dotnet 'Install the .NET SDK 8 (https://dotnet.microsoft.com/download), then reopen this shell.'
Assert-Tool node   'Install Node.js 20 or newer, 22.5+ only to regenerate the assets (https://nodejs.org), then reopen this shell.'
Assert-Tool go     'Install Go 1.27 or newer (https://go.dev/dl), then reopen this shell.'
if (-not $npm) {
    throw "'npm' was not found on PATH. It ships with Node.js; reinstall Node.js and reopen this shell."
}

Write-Host '==> [1/3] Building the mod DLL (dotnet build -c Release)'
& dotnet build $csproj -c Release --nologo
Assert-ExitCode 'dotnet build'
if (-not (Test-Path -LiteralPath $modDll)) {
    # AppendTargetFrameworkToOutputPath=false in the csproj, so there is no
    # net8.0-windows level in the path. If this trips, that setting changed.
    throw "dotnet build reported success but '$modDll' does not exist."
}

Write-Host '==> [2/3] Building the frontend (npm)'
Push-Location $frontend
try {
    if (Test-Path -LiteralPath (Join-Path $frontend 'node_modules')) {
        Write-Host '    node_modules already present, skipping npm ci'
    }
    else {
        & $npm.Source ci
        Assert-ExitCode 'npm ci'
    }
    # vite only strips types, so nothing else in this script would notice a type
    # error: run the compiler over the same sources before bundling.
    & $npm.Source run typecheck
    Assert-ExitCode 'npm run typecheck'
    # The tests are a gate, not something to remember: a release that ships with a
    # red suite is a release nobody checked.
    & $npm.Source test
    Assert-ExitCode 'npm test'
    & $npm.Source run build
    Assert-ExitCode 'npm run build'
}
finally {
    Pop-Location
}
if (-not (Test-Path -LiteralPath $distHtml)) {
    throw "The frontend build did not produce '$distHtml'."
}

Write-Host '==> [3/3] Building SigilEdit.exe (go build)'
Push-Location $toolDir
try {
    # main.go embeds this file as the window icon, so it has to be in place before
    # the Go build for the same reason the frontend bundle does.
    Copy-Item -LiteralPath $modIcon -Destination (Join-Path $toolDir 'appicon.png') -Force

    # -buildvcs=false for the same reason the csproj turns SourceLink and the
    # informational version off: Go otherwise stamps the commit sha and a
    # "modified" flag into the binary, so the same sources built before and after
    # a commit are not the same bytes. Measured: it was the only difference between
    # two builds of one unchanged tree.
    & go test ./...
    Assert-ExitCode 'go test'
    & go build -trimpath -buildvcs=false -ldflags '-H windowsgui -s -w' -o SigilEdit.exe .
    Assert-ExitCode 'go build'
}
finally {
    Pop-Location
}
if (-not (Test-Path -LiteralPath $exe)) {
    throw "go build reported success but '$exe' does not exist."
}

if ($Package) {
    Write-Host '==> Packaging the mod folder and a release zip'

    $version = ''
    if (Test-Path -LiteralPath $modCfg) {
        $version = ([IO.File]::ReadAllText($modCfg) | ConvertFrom-Json).ModVersion
    }
    if (-not $version) {
        Write-Host '    ModConfig.json has no ModVersion, using the date'
        $version = Get-Date -Format 'yyyyMMdd'
    }

    $releaseDir = Join-Path $root 'dist'
    $modOut     = Join-Path $releaseDir 'GBFR.SigilEdit'
    $zip        = Join-Path $releaseDir "GBFR.SigilEdit-$version.zip"

    # The mod folder exactly as Reloaded-II sees it. The tool rides along with the
    # mod it edits: dropping this one folder into Mods\ is the whole deployment,
    # and it is what deploy.ps1 copies.
    #
    # dist\ rather than bin\Release: the mod's own build output holds other files
    # too, and only these four belong in the Mods folder. The icon is the file
    # ModConfig.json names in ModIcon, so it has to keep that name in the folder.
    Remove-Item -LiteralPath $modOut -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $modOut -Force | Out-Null
    Copy-Item -LiteralPath $modDll -Destination $modOut -Force
    Copy-Item -LiteralPath $modCfg -Destination $modOut -Force
    Copy-Item -LiteralPath $exe -Destination $modOut -Force
    Copy-Item -LiteralPath $modIcon -Destination (Join-Path $modOut 'icon.png') -Force

    # Zipped straight from the pieces rather than through a staging copy: the four
    # paths are the whole archive, and nothing else in dist\ is dragged in.
    $documents = @(
        (Join-Path $root 'README.md'),
        (Join-Path $root 'README.zh-CN.md'),
        (Join-Path $root 'LICENSE')
    )
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    Compress-Archive -Path (@($modOut) + $documents) -DestinationPath $zip

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Write-Host ''
    Write-Host "==> $zip"
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        foreach ($entry in $archive.Entries) {
            Write-Host ("    {0}  ({1} bytes)" -f $entry.FullName, $entry.Length)
        }
    }
    finally {
        $archive.Dispose()
    }
    Write-Host ''
    Write-Host "Mod folder: $modOut (this is what goes into Reloaded-II\Mods\)"
}

Write-Host ''
Write-Host "Build finished: $exe" -ForegroundColor Green
