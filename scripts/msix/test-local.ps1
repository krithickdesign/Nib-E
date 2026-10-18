# Installs the Store package's files on this Windows computer for a test,
# before uploading to Partner Center. Nothing is signed or uploaded.
#
# 1. Windows Settings -> System -> For developers -> Developer Mode: On
# 2. From the Release run's Artifacts, download "Nib-E-<version>-store-msix"
#    and unzip it. Open PowerShell in the unzipped folder.
# 3. Run:   powershell -ExecutionPolicy Bypass -File .\test-local.ps1
#    Nib-E (Store edition) appears in the Start menu. Test it.
# 4. Remove it again before installing from the Store:
#           powershell -ExecutionPolicy Bypass -File .\test-local.ps1 -Remove
param([switch]$Remove)
$ErrorActionPreference = 'Stop'

$manifest = Join-Path $PSScriptRoot 'stage\AppxManifest.xml'
if (-not (Test-Path $manifest)) { throw "Unzip the whole artifact: $manifest not found." }
[xml]$xml = Get-Content $manifest
$name = $xml.Package.Identity.Name

$existing = Get-AppxPackage -Name $name -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Removing the earlier test install ($($existing.Version))..."
  Remove-AppxPackage -Package $existing.PackageFullName
}
if ($Remove) { Write-Host 'Removed.'; return }

Add-AppxPackage -Register $manifest
Write-Host "Installed $name for testing. Open Nib-E from the Start menu."
Write-Host 'Check: opens, Settings shows "Microsoft Store edition", no "Get the latest version" button,'
Write-Host 'a PDF opens with right-click -> Open with -> Nib-E, Save writes over the file.'
# Windows caches file icons; refresh them so PDFs show the new Nib-E file icon.
try { & "$env:WINDIR\System32\ie4uinit.exe" -show } catch { }
Write-Host 'PDF files should show a page with the Nib-E badge in File Explorer (large icons view).'
