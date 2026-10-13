# Builds the Microsoft Store package (MSIX) from the Nib-E app built by
#   npm run tauri build -- --no-bundle
# The package is left unsigned: the Store signs it after upload.
# Needs the Store identity from Partner Center (see STORE.md) in the
# environment: MSIX_IDENTITY_NAME, MSIX_PUBLISHER, MSIX_PUBLISHER_NAME.
param([Parameter(Mandatory = $true)][string]$Version)
$ErrorActionPreference = 'Stop'

foreach ($name in 'MSIX_IDENTITY_NAME', 'MSIX_PUBLISHER', 'MSIX_PUBLISHER_NAME') {
  if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Set $name (see STORE.md)." }
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must look like 0.5.1, got '$Version'." }

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$exe = Join-Path $root 'src-tauri\target\release\nib.exe'
if (-not (Test-Path $exe)) { throw "Build the app first: $exe not found." }

$stage = Join-Path $root 'dist-msix\stage'
$out = Join-Path $root 'dist-msix'
Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $stage 'Assets') | Out-Null

Copy-Item $exe (Join-Path $stage 'Nib-E.exe')
$icons = Join-Path $root 'src-tauri\icons'
foreach ($f in 'StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png') {
  Copy-Item (Join-Path $icons $f) (Join-Path $stage "Assets\$f")
}

# Escape for XML (the publisher name may contain & or quotes).
function Esc([string]$s) { [System.Security.SecurityElement]::Escape($s) }
$manifest = Get-Content (Join-Path $PSScriptRoot 'AppxManifest.template.xml') -Raw
$manifest = $manifest.Replace('{{IDENTITY_NAME}}', (Esc $env:MSIX_IDENTITY_NAME)).
  Replace('{{PUBLISHER}}', (Esc $env:MSIX_PUBLISHER)).
  Replace('{{PUBLISHER_NAME}}', (Esc $env:MSIX_PUBLISHER_NAME)).
  Replace('{{VERSION}}', "$Version.0")
Set-Content -Path (Join-Path $stage 'AppxManifest.xml') -Value $manifest -Encoding UTF8

# Windows SDK tools (installed on GitHub's Windows computers).
$kits = 'C:\Program Files (x86)\Windows Kits\10\bin'
$bin = Get-ChildItem $kits -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'x64\makeappx.exe') } |
  Sort-Object Name -Descending | Select-Object -First 1
if (-not $bin) { throw 'Windows SDK (makeappx.exe) not found.' }
$tools = Join-Path $bin.FullName 'x64'

# Resource index (lets Windows pick the right icon sizes).
Push-Location $stage
try {
  & (Join-Path $tools 'makepri.exe') createconfig /cf priconfig.xml /dq en-US /o | Out-Null
  & (Join-Path $tools 'makepri.exe') new /pr . /cf priconfig.xml /mn AppxManifest.xml /of resources.pri /o | Out-Null
  Remove-Item priconfig.xml -ErrorAction SilentlyContinue
} finally { Pop-Location }

$msix = Join-Path $out "Nib-E_$($Version)_x64.msix"
& (Join-Path $tools 'makeappx.exe') pack /d $stage /p $msix /o
if ($LASTEXITCODE -ne 0) { throw "makeappx failed ($LASTEXITCODE)." }
# For a test on your own PC before uploading (see test-local.ps1).
Copy-Item (Join-Path $PSScriptRoot 'test-local.ps1') (Join-Path $out 'test-local.ps1')
Write-Host "Store package: $msix"
