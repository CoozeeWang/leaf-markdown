# Destructive updater checks: only a disposable Actions runner may run these.
param(
  [ValidateSet('SourceFixture','InstalledFixture','RecoveryAudit')][string]$Mode = 'SourceFixture',
  [string]$Installer,
  [string]$OldInstaller
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or !$env:RUNNER_TEMP) { throw 'Requires a disposable GitHub Actions runner' }
$root = Join-Path $env:RUNNER_TEMP "Leaf update fixture 中文 apostrophe's spaces"
$audit = Join-Path $env:RUNNER_TEMP 'leaf-update-audit.json'
if ($Mode -eq 'SourceFixture') {
  cargo test --locked --manifest-path src-tauri/Cargo.toml --bin leaf update_install::windows::tests
  if ($LASTEXITCODE) { throw 'Updater transaction unit tests failed' }
  return
}
if ($Mode -eq 'RecoveryAudit') {
  $results = Get-Content $audit -Raw | ConvertFrom-Json
  $required = @('normal','after_delete','first_replace','helper_replace','registry_delete','registry_write','before_completion','restore_failure','lock_main','lock_helper','lock_resource','exact_adapter')
  foreach ($name in $required) { if (!($results | Where-Object scenario -eq $name)) { throw "Missing Windows proof: $name" } }
  if ($results.Count -ne $required.Count) { throw 'Unexpected or duplicated Windows scenario' }
  Write-Output 'PASS complete Windows payload/registration/restart audit (identity process restart; online GUI upgrade remains separate)'
  return
}
if (!$Installer) { throw 'New installer is required' }
$Installer = (Resolve-Path $Installer).Path
if (!$OldInstaller -or !(Test-Path $OldInstaller)) {
  $download = Join-Path $env:RUNNER_TEMP 'leaf-old-baseline-download'
  New-Item $download -ItemType Directory -Force | Out-Null
  gh run download 40004360368 --repo CoozeeWang/leaf-markdown --name 'Leaf-x86_64-pc-windows-msvc-7594099a85e411f6c76f3c60faade146045176d8' --dir $download
  if ($LASTEXITCODE) { throw 'Could not retrieve the already-built 1.0.0 baseline; do not rebuild it' }
  $OldInstaller = (Get-ChildItem $download -Recurse -Filter '*.exe' | Select-Object -First 1).FullName
}
if ((Get-FileHash $OldInstaller -Algorithm SHA256).Hash.ToLower() -ne '0a3e7d465842830de5667b0ad493c357babf1de67d5e7e0c0ec4973451a24176') { throw 'Old baseline does not match the verified 1.0.0 package' }
if (Test-Path $root) { throw 'Fixture root already exists; refusing to overwrite prior evidence' }
$data = Join-Path $env:APPDATA 'studio.leaf.editor'
if (Test-Path $data) { throw 'Existing Leaf profile found; refusing to touch it' }
New-Item $root,$data -ItemType Directory | Out-Null
$settings = Join-Path $data 'synthetic-update-settings.txt'
[IO.File]::WriteAllText($settings, 'synthetic settings 中文; no credentials; preserve exactly')
$settingsHash = (Get-FileHash $settings).Hash
$target = Join-Path $root 'installed'
$payload = Join-Path $root 'payload'
$preparedInstall = Join-Path $root 'package capture'
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$driver = (Resolve-Path src-tauri/target/debug/leaf-update-helper.exe).Path
$processes = @()
$results = @()
function Install-To([string]$Package,[string]$Destination) {
  $p = Start-Process $Package -ArgumentList @('/S','/NS','/UPDATE',"/D=$Destination") -PassThru
  if (!$p.WaitForExit(120000)) { $p.Kill(); throw 'Fixture installer timed out' }
  if ($p.ExitCode) { throw "Fixture installer failed: $($p.ExitCode)" }
}
function Invoke-Fixture([string]$Scenario) {
  $start = [Diagnostics.ProcessStartInfo]::new($driver)
  foreach ($arg in @('--windows-update-fixture',$target,$payload,$version,$Scenario)) { $start.ArgumentList.Add($arg) }
  $start.UseShellExecute = $false; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
  $p = [Diagnostics.Process]::Start($start)
  if (!$p.WaitForExit(120000)) { $p.Kill(); throw 'Updater supervisor timed out' }
  $output = $p.StandardOutput.ReadToEnd(); $errorText = $p.StandardError.ReadToEnd()
  if ($p.ExitCode) { throw "Supervisor failed: $errorText" }
  $result = $output | ConvertFrom-Json
  if ((Get-FileHash $settings).Hash -ne $settingsHash) { throw 'Updater changed user settings' }
  if ($Scenario -eq 'normal' -or $Scenario -eq 'exact_adapter') {
    if ($result.result.state -ne 'installed' -or !$result.new_matches -or !$result.backup_matches -or $result.result.restart_count -ne 1) { throw "Incomplete successful installation: $output" }
  } elseif ($Scenario -eq 'restore_failure') {
    if ($result.result.state -ne 'rollback_failed' -or !$result.backup_matches -or $result.result.restart_count -ne 0) { throw "False recovery claim: $output" }
  } elseif ($Scenario.StartsWith('lock_')) {
    if ($result.result.state -ne 'install_failed' -or !$result.old_matches -or !$result.registry_restored -or $result.backup_matches -or $result.result.restart_count -ne 0) { throw "File occupancy mutated installation: $output" }
  } else {
    if ($result.result.state -ne 'rolled_back' -or !$result.old_matches -or !$result.registry_restored -or !$result.backup_matches -or $result.result.restart_count -ne 1) { throw "Incomplete recovery: $output" }
  }
  $script:results += @{ scenario=$Scenario; evidence=$result }
  Write-Output "PASS ${Scenario}: $($result.result.state), restart=$($result.result.restart_count), settings preserved"
}
try {
  Install-To $Installer $preparedInstall
  Copy-Item $preparedInstall $payload -Recurse
  Copy-Item $Installer (Join-Path $payload '.leaf-update-installer.exe')
  # A tiny NSIS fault fixture uses the production transaction hooks and real
  # signed-package payload bytes. Fault selection cannot enter release builds.
  $nsis = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'tauri') -Filter makensis.exe -Recurse | Select-Object -First 1
  if (!$nsis) { throw 'Trusted Tauri NSIS compiler not found' }
  $faultExe = Join-Path $root 'fault-installer.exe'
  $hook = (Resolve-Path src-tauri/windows-update-recovery.nsh).Path
  $script = @"
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!define LEAF_UPDATE_FAULT_FIXTURE
!include "$hook"
Name "Leaf disposable update fixture"
OutFile "$faultExe"
RequestExecutionLevel user
SilentInstall silent
Section
  !insertmacro LeafUpdateBegin
  SetOutPath `$INSTDIR
  Delete "`$INSTDIR\leaf.exe"
  !insertmacro LeafUpdateFault "after_delete"
  File /oname=leaf.exe "$payload\leaf.exe"
  !insertmacro LeafUpdateFault "first_replace"
  File /oname=leaf-update-helper.exe "$payload\leaf-update-helper.exe"
  !insertmacro LeafUpdateFault "helper_replace"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Leaf"
  !insertmacro LeafUpdateFault "registry_delete"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Leaf" "DisplayVersion" "$version"
  !insertmacro LeafUpdateFault "registry_write"
  !insertmacro LeafUpdateFault "before_completion"
  !insertmacro LeafUpdateComplete
SectionEnd
"@
  $nsi = Join-Path $root 'fault.nsi'; [IO.File]::WriteAllText($nsi,$script)
  & $nsis.FullName /V2 $nsi
  if ($LASTEXITCODE) { throw 'NSIS recovery fixture did not compile' }
  Install-To $OldInstaller $target
  Invoke-Fixture 'normal'
  foreach ($fault in @('after_delete','first_replace','helper_replace','registry_delete','registry_write','before_completion','restore_failure')) {
    Install-To $OldInstaller $target
    Copy-Item $faultExe (Join-Path $payload '.leaf-update-installer.exe') -Force
    $env:LEAF_UPDATE_FIXTURE_FAULT = if ($fault -eq 'restore_failure') { 'registry_write' } else { $fault }
    Invoke-Fixture $fault
  }
  Remove-Item Env:LEAF_UPDATE_FIXTURE_FAULT
  Copy-Item $Installer (Join-Path $payload '.leaf-update-installer.exe') -Force
  foreach ($lock in @(@('lock_main','leaf.exe'),@('lock_helper','leaf-update-helper.exe'),@('lock_resource','document-icon.ico'))) {
    Install-To $OldInstaller $target
    # Reading remains possible for the before/after manifest; replacement does
    # not. This isolates installation occupancy from a fixture snapshot failure.
    $stream = [IO.File]::Open((Join-Path $target $lock[1]),'Open','Read','Read')
    try { Invoke-Fixture $lock[0] } finally { $stream.Dispose() }
  }
  # A real mapped executable lock: only the exact installed adapter may stop.
  Install-To $OldInstaller $target
  $source = Join-Path $root 'SyntheticAdapter.cs'; [IO.File]::WriteAllText($source,'class SyntheticAdapter { static void Main() { System.Threading.Thread.Sleep(180000); } }')
  $other = Join-Path $root 'leaf-mcp-adapter.exe'; $csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
  & $csc /nologo /platform:x64 /target:exe "/out:$other" $source
  if ($LASTEXITCODE) { throw 'Synthetic occupancy executable did not compile' }
  $bytes = [IO.File]::ReadAllBytes($other) + [Text.Encoding]::UTF8.GetBytes("LEAF_UPDATE_BINARY_IDENTITY_V1`0Leaf`0studio.leaf.editor`01.0.0`0leaf-mcp-adapter`0")
  [IO.File]::WriteAllBytes($other,$bytes)
  Copy-Item $other (Join-Path $target 'leaf-mcp-adapter.exe') -Force
  $external = Start-Process $other -PassThru; $owned = Start-Process (Join-Path $target 'leaf-mcp-adapter.exe') -PassThru
  $processes += $external,$owned
  Start-Sleep -Milliseconds 300
  Invoke-Fixture 'exact_adapter'
  if (!$owned.WaitForExit(5000) -or $external.HasExited) { throw 'Updater failed exact-path process isolation' }
  $results | ConvertTo-Json -Depth 30 | Set-Content $audit -Encoding UTF8
  # Capture the real NSIS payload and installer for the custodian's signed
  # updater archive; generated outputs stay out of Git.
  $capture = Join-Path $PWD 'test-results/windows-updater-payload'
  New-Item $capture -ItemType Directory -Force | Out-Null
  Copy-Item (Join-Path $preparedInstall '*') $capture -Recurse
  Copy-Item $Installer (Join-Path $capture '.leaf-update-installer.exe')
  Copy-Item $audit (Join-Path $PWD 'test-results/windows-update-audit.json')
} finally {
  foreach ($p in $processes) { if (!$p.HasExited) { $p.Kill(); $p.WaitForExit() } }
  Remove-Item Env:LEAF_UPDATE_FIXTURE_FAULT -ErrorAction SilentlyContinue
  # This directory and synthetic profile were created here after refusing any
  # existing profile. Keep audit JSON; delete only these disposable fixtures.
  Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $data -Recurse -Force -ErrorAction SilentlyContinue
}
