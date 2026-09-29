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
$newFolder = Join-Path $env:RUNNER_TEMP 'Leaf new document 中文 space'
New-Item -ItemType Directory -Path $newFolder | Out-Null
$menuKeys = @('HKCU:\Software\Classes\Directory\shell\Leaf.NewMarkdown', 'HKCU:\Software\Classes\Directory\Background\shell\Leaf.NewMarkdown')
foreach ($key in $menuKeys) { if (Test-Path $key) { throw 'Runner already has Leaf folder actions' } }
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
  for ($i = 0; $i -lt $menuKeys.Count; $i++) {
    $command = (Get-Item "$($menuKeys[$i])\command").GetValue('')
    $placeholder = if ($i -eq 0) { '%1' } else { '%V' }
    if ($command -ne ('"' + $exe + '" --new-in "' + $placeholder + '\."')) { throw "Unexpected folder action: $command" }
  }
  # Cold launch, then single-instance dispatch. Existing content must survive.
  $original = Join-Path $newFolder '未命名.md'
  Set-Content $original '# Preserve this original' -Encoding utf8
  $originalHash = (Get-FileHash $original).Hash
  foreach ($number in @(2, 3)) {
    Start-Process -FilePath $exe -ArgumentList @('--new-in', ('"' + $newFolder + '\."')) | Out-Null
    $created = Join-Path $newFolder "未命名 $number.md"
    $deadline = (Get-Date).AddSeconds(45)
    while (!(Test-Path $created) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    if (!(Test-Path $created) -or (Get-Item $created).Length -ne 0) { throw 'Context action did not create an empty Markdown file' }
    Start-Sleep -Seconds 2
    $running = Get-Process leaf -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }
    if (!$running) { throw 'Leaf did not remain open after creating the document' }
  }
  if ((Get-FileHash $original).Hash -ne $originalHash) { throw 'New document action overwrote original' }
  Write-Output 'PASS Windows folder actions: registered commands, cold/single-instance creation, collision preservation'
  Write-Output 'PASS Windows installer: Markdown DefaultIcon points to installed Leaf icon, all extensions registered, UserChoice and sample unchanged'
} finally {
  if ($exe) { Get-Process leaf -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force }
  $uninstaller = Join-Path $installDir 'uninstall.exe'
  if (Test-Path $uninstaller) { Start-Process -FilePath $uninstaller -ArgumentList @('/S',"_?=$installDir") -Wait | Out-Null }
  foreach ($key in $menuKeys) { if (Test-Path $key) { throw 'Uninstaller left a Leaf folder action' } }
  Remove-Item $newFolder -Recurse -ErrorAction SilentlyContinue
  Remove-Item $sample -ErrorAction SilentlyContinue
}
