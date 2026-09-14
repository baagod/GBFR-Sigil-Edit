#Requires -Version 5.1
<#
.SYNOPSIS
    Builds the GBFR.SkillEdit mod DLL and the SkillEditTool executable, and
    optionally packs a release zip.

.DESCRIPTION
    The order of the steps is a constraint, not a preference:

        1. dotnet build          -> GBFR.SkillEdit\bin\Release\GBFR.SkillEdit.dll
        2. copy that DLL         -> SkillEditTool\assets\GBFR.SkillEdit.dll
        3. npm ci + npm run build -> SkillEditTool\frontend\dist
        4. go build              -> SkillEditTool\SkillEdit.exe

    main.go embeds both the frontend bundle and the mod binary at compile time
    (//go:embed all:frontend/dist and //go:embed assets/GBFR.SkillEdit.dll). Go
    reads those files from disk while compiling, so they have to exist first: if
    either is missing, `go build` stops with "pattern ...: no matching files
    found", and if either is stale the executable silently ships the previous
    version. That is why the DLL and the frontend are built and put in place
    before the Go build runs.

    Every step is checked; the first failure stops the script with a non-zero
    exit code.

.PARAMETER Package
    After a successful build, write dist\GBFR.SkillEdit-<version>.zip
    holding the tool, both READMEs, the LICENSE and the mod itself.

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
$csproj   = Join-Path $root 'GBFR.SkillEdit\GBFR.SkillEdit.csproj'
$modDll   = Join-Path $root 'GBFR.SkillEdit\bin\Release\GBFR.SkillEdit.dll'
$modCfg   = Join-Path $root 'GBFR.SkillEdit\ModConfig.json'
$assetDll = Join-Path $root 'SkillEditTool\assets\GBFR.SkillEdit.dll'
$toolDir  = Join-Path $root 'SkillEditTool'
$frontend = Join-Path $toolDir 'frontend'
$exe      = Join-Path $toolDir 'SkillEdit.exe'
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
Assert-Tool node   'Install Node.js 20 or newer (https://nodejs.org), then reopen this shell.'
Assert-Tool go     'Install Go 1.25 or newer (https://go.dev/dl), then reopen this shell.'
if (-not $npm) {
    throw "'npm' was not found on PATH. It ships with Node.js; reinstall Node.js and reopen this shell."
}

Write-Host '==> [1/4] Building the mod DLL (dotnet build -c Release)'
& dotnet build $csproj -c Release --nologo
Assert-ExitCode 'dotnet build'
if (-not (Test-Path -LiteralPath $modDll)) {
    # AppendTargetFrameworkToOutputPath=false in the csproj, so there is no
    # net8.0-windows level in the path. If this trips, that setting changed.
    throw "dotnet build reported success but '$modDll' does not exist."
}

Write-Host '==> [2/4] Copying the DLL to SkillEditTool\assets (the file go:embed reads)'
Copy-Item -LiteralPath $modDll -Destination $assetDll -Force

Write-Host '==> [3/4] Building the frontend (npm)'
Push-Location $frontend
try {
    if (Test-Path -LiteralPath (Join-Path $frontend 'node_modules')) {
        Write-Host '    node_modules already present, skipping npm ci'
    }
    else {
        & $npm.Source ci
        Assert-ExitCode 'npm ci'
    }
    & $npm.Source run build
    Assert-ExitCode 'npm run build'
}
finally {
    Pop-Location
}
if (-not (Test-Path -LiteralPath $distHtml)) {
    throw "The frontend build did not produce '$distHtml'."
}

Write-Host '==> [4/4] Building SkillEdit.exe (go build)'
Push-Location $toolDir
try {
    & go build -trimpath -ldflags '-H windowsgui -s -w' -o SkillEdit.exe .
    Assert-ExitCode 'go build'
}
finally {
    Pop-Location
}
if (-not (Test-Path -LiteralPath $exe)) {
    throw "go build reported success but '$exe' does not exist."
}

if ($Package) {
    Write-Host '==> Packaging a release zip'

    $version = ''
    if (Test-Path -LiteralPath $modCfg) {
        $version = ([IO.File]::ReadAllText($modCfg) | ConvertFrom-Json).ModVersion
    }
    if (-not $version) {
        Write-Host '    ModConfig.json has no ModVersion, using the date'
        $version = Get-Date -Format 'yyyyMMdd'
    }

    $releaseDir = Join-Path $root 'dist'
    $staging    = Join-Path $releaseDir 'staging'
    $zip        = Join-Path $releaseDir "GBFR.SkillEdit-$version.zip"

    # Staged rather than zipped in place: the archive has to hold exactly six
    # files, and bin\Release also contains the build's other output.
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path (Join-Path $staging 'GBFR.SkillEdit') -Force | Out-Null

    Copy-Item -LiteralPath $exe -Destination $staging -Force
    Copy-Item -LiteralPath (Join-Path $root 'README.md') -Destination $staging -Force
    Copy-Item -LiteralPath (Join-Path $root 'README.zh-CN.md') -Destination $staging -Force
    Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination $staging -Force
    # For anyone who would rather drop the mod into Mods\ by hand.
    Copy-Item -LiteralPath $modCfg -Destination (Join-Path $staging 'GBFR.SkillEdit') -Force
    Copy-Item -LiteralPath $modDll -Destination (Join-Path $staging 'GBFR.SkillEdit') -Force

    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip
    Remove-Item -LiteralPath $staging -Recurse -Force

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
}

Write-Host ''
Write-Host "Build finished: $exe" -ForegroundColor Green
