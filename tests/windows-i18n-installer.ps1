# Real installer checks on a disposable hosted runner, never a user's PC.
param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or !$env:RUNNER_TEMP) { throw 'Requires an isolated GitHub Actions runner' }
$config = Get-Content "$PSScriptRoot/../src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
$manufacturer = if ($config.bundle.publisher) { $config.bundle.publisher } else { $config.identifier.Split('.')[1] }
$installerKey = "HKCU:\Software\$manufacturer\$($config.productName)"
$appData = Join-Path $env:APPDATA $config.identifier
$preference = Join-Path $appData 'language-v1.json'
$menuKeys = @('HKCU:\Software\Classes\Directory\shell\Leaf.NewMarkdown', 'HKCU:\Software\Classes\Directory\Background\shell\Leaf.NewMarkdown')
if ((Test-Path $installerKey) -or (Test-Path $appData)) { throw 'Runner already has Leaf data; refusing to overwrite' }
foreach ($key in $menuKeys) { if (Test-Path $key) { throw 'Runner already has Leaf folder actions' } }
$installDir = Join-Path $env:RUNNER_TEMP 'Leaf i18n install'
$exe = Join-Path $installDir 'leaf.exe'
$sampleDir = Join-Path $env:RUNNER_TEMP 'Leaf i18n synthetic 中文 folder'
# Preserve any runner association metadata; all test handlers are synthetic.
$association = $config.bundle.fileAssociations[0]
$backupName = "$($association.name)_backup"
$originalClasses = @{}
$originalBackups = @{}
$originalKeyExists = @{}
$previousClasses = @{}
foreach ($ext in $association.ext) {
  $key = "HKCU:\Software\Classes\.$ext"
  $originalKeyExists[$ext] = Test-Path $key
  $originalClasses[$ext] = if (Test-Path $key) { (Get-Item $key).GetValue('') } else { $null }
  $originalBackups[$ext] = if (Test-Path $key) { (Get-Item $key).GetValue($backupName) } else { $null }
  if ($originalClasses[$ext] -eq $association.name) { throw 'Runner already has a Leaf association' }
  # Include an unassociated extension and distinct previous classes.
  $previousClasses[$ext] = if ($ext -eq 'markdown') { '' } else { "Leaf.Synthetic.PreviousHandler.$ext" }
}
New-Item -ItemType Directory -Path $appData, $sampleDir | Out-Null
# Deliberately differ from the Chinese installer languages; installing must preserve it.
[IO.File]::WriteAllText($preference, '{"preference":"en"}', [Text.UTF8Encoding]::new($false))
$preferenceHash = (Get-FileHash $preference).Hash
function Stop-TestLeaf {
  Get-Process leaf -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force
}
function Install-Language([int]$Id, [string]$Locale) {
  # MUI2 restores the installer language from its own registry value even in /S.
  # This tests compiled language tables without inventing an unsupported /LANG flag.
  New-Item -Path $installerKey -Force | Out-Null
  New-ItemProperty -Path $installerKey -Name 'Installer Language' -Value "$Id" -PropertyType String -Force | Out-Null
  $process = Start-Process -FilePath (Resolve-Path $Installer) -ArgumentList @('/S', '/NS', "/D=$installDir") -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Installer exit: $($process.ExitCode)" }
  if (!(Test-Path $exe)) { throw 'Missing installed executable' }
  $catalog = Get-Content "$PSScriptRoot/../src/locales/$Locale.json" -Raw -Encoding utf8 | ConvertFrom-Json
  foreach ($key in $menuKeys) {
    if ((Get-Item $key).GetValue('') -cne $catalog.'Info.create_a_markdown_document_with_leaf') { throw "Wrong installed shell language: $Locale" }
  }
  if ((Get-FileHash $preference).Hash -ne $preferenceHash) { throw 'Installer overwrote application language preference' }
  foreach ($ext in $association.ext) {
    $key = Get-Item "HKCU:\Software\Classes\.$ext"
    if ($key.GetValue('') -cne $association.name) { throw "Installer did not register .$ext" }
    if ($key.GetValue($backupName) -cne $previousClasses[$ext]) { throw "Reinstall lost the previous .$ext association" }
  }
}
function Uninstall-TestLeaf {
  Stop-TestLeaf
  $uninstaller = Join-Path $installDir 'uninstall.exe'
  if (Test-Path $uninstaller) {
    $process = Start-Process -FilePath $uninstaller -ArgumentList @('/S', "_?=$installDir") -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Uninstaller exit: $($process.ExitCode)" }
    foreach ($key in $menuKeys) { if (Test-Path $key) { throw 'Uninstaller left a Leaf shell entry' } }
    foreach ($ext in $association.ext) {
      $key = "HKCU:\Software\Classes\.$ext"
      $restored = if (Test-Path $key) { (Get-Item $key).GetValue('') } else { '' }
      if ($restored -cne $previousClasses[$ext]) { throw "Uninstall did not restore the previous .$ext association" }
    }
  }
}
try {
  foreach ($ext in $association.ext) {
    $key = "HKCU:\Software\Classes\.$ext"
    New-Item -Path $key -Force | Out-Null
    Set-Item -LiteralPath $key -Value $previousClasses[$ext]
  }
  foreach ($language in @(@{Id=1033;Locale='en'}, @{Id=2052;Locale='zh-Hans'}, @{Id=1028;Locale='zh-Hant-TW'})) {
    Install-Language $language.Id $language.Locale
    Write-Output "PASS installed shell language and preference preservation: $($language.Locale)"
    Uninstall-TestLeaf
  }
  Install-Language 1033 'en'
  Install-Language 1028 'zh-Hant-TW'
  Install-Language 2052 'zh-Hans'
  Write-Output 'PASS reinstall updates shell language independently of application preference'
  # The app's saved English preference owns new names, despite Traditional Chinese installation.
  $original = Join-Path $sampleDir 'Untitled.md'
  Set-Content $original '# Preserve synthetic original' -Encoding utf8
  $originalHash = (Get-FileHash $original).Hash
  foreach ($number in @(2,3)) {
    Start-Process -FilePath $exe -ArgumentList @('--new-in', ('"' + $sampleDir + '\."')) | Out-Null
    $created = Join-Path $sampleDir "Untitled $number.md"
    $deadline = (Get-Date).AddSeconds(45)
    while (!(Test-Path $created) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    if (!(Test-Path $created) -or (Get-Item $created).Length -ne 0) { throw 'App language did not control the new filename' }
  }
  if ((Get-FileHash $original).Hash -ne $originalHash) { throw 'New document action overwrote original' }
  if ((Get-FileHash $preference).Hash -ne $preferenceHash) { throw 'App preference changed during installer checks' }
  Write-Output 'PASS cold/warm new-file language and collision preservation'
  Uninstall-TestLeaf
  # Simulate a backup already overwritten by the old installer. Do not restore
  # Leaf as its own previous handler when the real previous class is unknown.
  $key = 'HKCU:\Software\Classes\.md'
  Set-Item -LiteralPath $key -Value $association.name
  New-ItemProperty -Path $key -Name $backupName -Value $association.name -PropertyType String -Force | Out-Null
  $previousClasses['md'] = ''
  Install-Language 1033 'en'
  Write-Output 'PASS legacy self-association backup is not restored as Leaf'
} finally {
  try {
    Uninstall-TestLeaf
  } finally {
    foreach ($ext in $association.ext) {
      $path = "Software\Classes\.$ext"
      $entry = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($path)
      try {
        if ($null -eq $originalClasses[$ext]) { $entry.DeleteValue('', $false) }
        else { $entry.SetValue('', $originalClasses[$ext]) }
        if ($null -eq $originalBackups[$ext]) { $entry.DeleteValue($backupName, $false) }
        else { $entry.SetValue($backupName, $originalBackups[$ext]) }
        $empty = $entry.ValueCount -eq 0 -and $entry.SubKeyCount -eq 0
      } finally { $entry.Dispose() }
      if (!$originalKeyExists[$ext] -and $empty) { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($path, $false) }
    }
    Remove-Item $appData -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $sampleDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
