# Run only on a disposable GitHub-hosted Windows runner, never on a user's PC.
param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or !$env:RUNNER_TEMP) { throw 'Requires an isolated GitHub Actions runner' }
Add-Type -AssemblyName System.Drawing
function Get-UserChoiceSnapshot([string]$Extension) {
  $key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.$Extension\UserChoice"
  if (!(Test-Path $key)) { return '<absent>' }
  $entry = Get-Item $key
  $values = @($entry.GetValueNames() | Sort-Object | ForEach-Object {
    [pscustomobject]@{ Name = $_; Kind = $entry.GetValueKind($_).ToString(); Value = $entry.GetValue($_) }
  })
  return (ConvertTo-Json -InputObject $values -Compress -Depth 3)
}
function Assert-UsableIco([string]$Path) {
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 6 -or [BitConverter]::ToUInt16($bytes, 0) -ne 0 -or [BitConverter]::ToUInt16($bytes, 2) -ne 1) { throw "Invalid ICO header: $Path" }
  $count = [BitConverter]::ToUInt16($bytes, 4)
  if ($count -lt 3 -or $bytes.Length -lt 6 + 16 * $count) { throw "ICO lacks multiple sizes: $Path" }
  $sizes = @()
  for ($i = 0; $i -lt $count; $i++) {
    $entry = 6 + 16 * $i
    $width = if ($bytes[$entry] -eq 0) { 256 } else { [int]$bytes[$entry] }
    $height = if ($bytes[$entry + 1] -eq 0) { 256 } else { [int]$bytes[$entry + 1] }
    $length = [BitConverter]::ToUInt32($bytes, $entry + 8)
    $offset = [BitConverter]::ToUInt32($bytes, $entry + 12)
    if ($width -ne $height -or $length -eq 0 -or $offset + $length -gt $bytes.Length) { throw "Invalid ICO image entry: $Path" }
    $sizes += $width
  }
  if (@($sizes | Select-Object -Unique).Count -lt 3) { throw "ICO lacks distinct sizes: $Path" }
  $loaded = [System.Drawing.Icon]::new($Path)
  try { if ($loaded.Width -lt 16) { throw "ICO cannot be loaded: $Path" } } finally { $loaded.Dispose() }
}
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
  $choices[$ext] = Get-UserChoiceSnapshot $ext
}
$exe = Join-Path $installDir 'leaf.exe'
$documentIcon = Join-Path $installDir 'document-icon.ico'
$installed = $false
try {
  $process = Start-Process -FilePath (Resolve-Path $Installer) -ArgumentList @('/S',"/D=$installDir") -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Installer exit: $($process.ExitCode)" }
  $installed = $true
  if (!(Test-Path $exe)) { throw 'Installed application is missing' }
  if (!(Test-Path $documentIcon)) { throw 'Installed document icon is missing' }
  $committedIcon = Join-Path $PSScriptRoot '../src-tauri/icons/document-icon.ico'
  $applicationIcon = Join-Path $PSScriptRoot '../src-tauri/icons/icon.ico'
  if ((Get-FileHash $documentIcon).Hash -ne (Get-FileHash $committedIcon).Hash) { throw 'Installed document icon differs from committed ICO' }
  if ((Get-FileHash $documentIcon).Hash -eq (Get-FileHash $applicationIcon).Hash) { throw 'Document icon reuses application ICO' }
  Assert-UsableIco $documentIcon
  $icon = (Get-Item "$class\DefaultIcon").GetValue('')
  if ($icon -ne ('"' + $documentIcon + '",0')) { throw "Unexpected document icon registration: $icon" }
  $extracted = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
  if (!$extracted -or $extracted.Width -lt 16) { throw 'Installed executable has no usable icon' }
  $extracted.Dispose()
  foreach ($ext in $association.ext) {
    if ((Get-Item "HKCU:\Software\Classes\.$ext").GetValue('') -ne $association.name) { throw "Missing .$ext association" }
    $after = Get-UserChoiceSnapshot $ext
    if ($after -ne $choices[$ext]) { throw "Installer changed Windows UserChoice for .$ext" }
  }
  if ((Get-FileHash $sample).Hash -ne $hash) { throw 'Sample Markdown changed' }
  for ($i = 0; $i -lt $menuKeys.Count; $i++) {
    $menuIcon = (Get-Item "$($menuKeys[$i])").GetValue('Icon')
    if ($menuIcon -ne ('"' + $exe + '",0')) { throw "Unexpected folder action icon: $menuIcon" }
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
  Write-Output 'PASS Windows installer: distinct multi-size document ICO, unchanged executable/menu icons, all extensions registered, UserChoice and sample unchanged'
} finally {
  if ($exe) { Get-Process leaf -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force }
  $uninstaller = Join-Path $installDir 'uninstall.exe'
  if (Test-Path $uninstaller) {
    $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList @('/S',"_?=$installDir") -Wait -PassThru
    if ($uninstallProcess.ExitCode -ne 0) { throw "Uninstaller exit: $($uninstallProcess.ExitCode)" }
  }
  if ($installed) {
    if (Test-Path $class) { throw 'Uninstaller left the Leaf document class' }
    if (Test-Path $documentIcon) { throw 'Uninstaller left the document icon resource' }
    foreach ($ext in $association.ext) {
      $extension = "HKCU:\Software\Classes\.$ext"
      if ((Test-Path $extension) -and (Get-Item $extension).GetValue('') -eq $association.name) { throw "Uninstaller left the .$ext association" }
      if ((Get-UserChoiceSnapshot $ext) -ne $choices[$ext]) { throw "Uninstaller changed Windows UserChoice for .$ext" }
    }
  }
  foreach ($key in $menuKeys) { if (Test-Path $key) { throw 'Uninstaller left a Leaf folder action' } }
  Remove-Item $newFolder -Recurse -ErrorAction SilentlyContinue
  Remove-Item $sample -ErrorAction SilentlyContinue
}
