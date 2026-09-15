#Requires -Version 5.1
<#
.SYNOPSIS
    Copies the built mod folder into Reloaded-II\Mods\GBFR.SigilEdit.

.DESCRIPTION
    The deployment is a folder copy, because the folder *is* the mod: the DLL,
    its manifest and the tool that edits it. Run build.ps1 -Package first - the
    copy comes from dist\GBFR.SigilEdit\, which is exactly what the release zip
    holds.

    The tool is relaunched from the deployed copy afterwards, so what is running
    is what was just deployed.

.PARAMETER Target
    The deployed mod folder. Defaults to the usual local installation.

.EXAMPLE
    ./deploy.ps1

.EXAMPLE
    ./deploy.ps1 -Target 'D:\Reloaded-II\Mods\GBFR.SigilEdit'
#>
[CmdletBinding()]
param(
    [string]$Target = 'C:\Users\baago\Desktop\Reloaded-II\Mods\GBFR.SigilEdit'
)

$ErrorActionPreference = 'Stop'

$root   = $PSScriptRoot
$source = Join-Path $root 'dist\GBFR.SigilEdit'

# 0. Refuse a target that is not the mod folder: the replacement below is a
# recursive delete, so a mistyped -Target must never hit an unrelated path.
$resolvedTarget = [IO.Path]::GetFullPath($Target).TrimEnd('\')
if (-not $resolvedTarget.EndsWith('\GBFR.SigilEdit', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to deploy to a path that is not the mod folder: $Target"
}

# 1. The built folder has to be complete. Keep in sync with the files build.ps1
# copies into dist\GBFR.SigilEdit\ - a mod missing its manifest or its DLL looks
# deployed and then does nothing.
foreach ($required in @('GBFR.SigilEdit.dll', 'ModConfig.json', 'SigilEdit.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $required) -PathType Leaf)) {
        throw "Built mod folder is incomplete: $source (missing $required). Run build.ps1 -Package first."
    }
}

# 2. The game must be closed: it loads the mod DLL from the Mods folder and keeps
# it open, so the copy below would fail halfway through.
if (Get-Process -Name 'granblue_fantasy_relink' -ErrorAction SilentlyContinue) {
    throw 'The game is running; close it first (its Reloaded-II mods are loaded from the Mods folder).'
}

# 3. The tool is one of the files being replaced, so stop it and wait until it is
# really gone rather than racing its shutdown.
Get-Process -Name 'SigilEdit' -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Process -Name 'SigilEdit' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
}

# 4. Replace the deployed folder. The mod's log goes with it: the mod starts that
# file over on its next launch, so a leftover one is only ever yesterday's.
if (Test-Path -LiteralPath $Target) {
    Remove-Item -LiteralPath $Target -Recurse -Force
}
New-Item -ItemType Directory -Path (Split-Path -Parent $Target) -Force | Out-Null
Copy-Item -Path $source -Destination (Split-Path -Parent $Target) -Recurse -Force

# 5. Reopen the editor from the copy that was just deployed.
Start-Process -FilePath (Join-Path $Target 'SigilEdit.exe')
Write-Output "Deployed build to: $Target"
