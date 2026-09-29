# Run only on a disposable GitHub-hosted Windows runner, never on a user's PC.
param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or !$env:RUNNER_TEMP) { throw 'Requires an isolated GitHub Actions runner' }
Add-Type -AssemblyName System.Drawing
$config = Get-Content "$PSScriptRoot/../src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
$association = $config.bundle.fileAssociations[0]
$class = "HKCU:\Software\Classes\$($association.name)"
if (Test-Path $class) { throw 'Runner already has this file class; refusing to modify it' }
$installDir = Join-Path $env:RUNNER_TEMP 'Leaf icon check'
$sample = Join-Path $env:RUNNER_TEMP 'leaf-icon-check.md'
Set-Content $sample '# Synthetic icon check' -Encoding utf8
$hash = (Get-FileHash $sample).Hash
# UserChoice belongs to Windows. The installer must not overwrite that selection.
$choices = @{}
foreach ($ext in $association.ext) {
  $key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.$ext\UserChoice"
  $choices[$ext] = if (Test-Path $key) { (Get-ItemProperty $key | Select-Object ProgId,Hash | ConvertTo-Json -Compress) } else { '' }
}
try {
  $process = Start-Process -FilePath (Resolve-Path $Installer) -ArgumentList @('/S',"/D=$installDir") -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Installer exit: $($process.ExitCode)" }
  $exe = Join-Path $installDir 'leaf.exe'
  if (!(Test-Path $exe)) { throw 'Installed application is missing' }
  $icon = (Get-Item "$class\DefaultIcon").GetValue('')
  if ($icon -ne "$exe,0") { throw "Unexpected document icon registration: $icon" }
  $extracted = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
  if (!$extracted -or $extracted.Width -lt 16) { throw 'Installed executable has no usable icon' }
  $extracted.Dispose()
  foreach ($ext in $association.ext) {
    if ((Get-Item "HKCU:\Software\Classes\.$ext").GetValue('') -ne $association.name) { throw "Missing .$ext association" }
    $key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.$ext\UserChoice"
    $after = if (Test-Path $key) { (Get-ItemProperty $key | Select-Object ProgId,Hash | ConvertTo-Json -Compress) } else { '' }
    if ($after -ne $choices[$ext]) { throw "Installer changed Windows UserChoice for .$ext" }
  }
  if ((Get-FileHash $sample).Hash -ne $hash) { throw 'Sample Markdown changed' }
  Write-Output 'PASS Windows installer: Markdown DefaultIcon points to installed Leaf icon, all extensions registered, UserChoice and sample unchanged'
} finally {
  $uninstaller = Join-Path $installDir 'uninstall.exe'
  if (Test-Path $uninstaller) { Start-Process -FilePath $uninstaller -ArgumentList @('/S',"_?=$installDir") -Wait | Out-Null }
  Remove-Item $sample -ErrorAction SilentlyContinue
}
