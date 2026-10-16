# Destructive installer regression: disposable GitHub runner only.
param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or !$env:RUNNER_TEMP) { throw 'Requires an isolated GitHub Actions runner' }
$Installer = (Resolve-Path $Installer).Path
$root = Join-Path $env:RUNNER_TEMP 'Leaf upgrade synthetic 中文 spaces'
$installDir = Join-Path $root 'installed'
$otherDir = Join-Path $root 'other installation'
$adapter = Join-Path $installDir 'leaf-mcp-adapter.exe'
$exe = Join-Path $installDir 'leaf.exe'
$config = Get-Content "$PSScriptRoot/../src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
$appData = Join-Path $env:APPDATA $config.identifier
if ((Test-Path $root) -or (Test-Path $appData)) { throw 'Existing test or application data; refusing to overwrite' }
New-Item -ItemType Directory -Path $root, $otherDir, $appData | Out-Null
$sentinel = Join-Path $appData 'synthetic-upgrade-settings.json'
[IO.File]::WriteAllText($sentinel, '{"enabled":true,"synthetic":"preserve saved connection settings"}')
$settingsHash = (Get-FileHash $sentinel).Hash
$processes = @()
$lock = $null
function Invoke-Installer([bool]$ExpectSuccess = $true) {
  $p = Start-Process $Installer -ArgumentList @('/S', '/NS', "/D=$installDir") -PassThru
  if (!$p.WaitForExit(90000)) { $p.Kill(); throw 'Installer timed out (possibly a hidden file-in-use dialog)' }
  if ($ExpectSuccess -and $p.ExitCode -ne 0) { throw "Installer failed: $($p.ExitCode)" }
  if (!$ExpectSuccess -and $p.ExitCode -eq 0) { throw 'Installer ignored a locked adapter' }
}
function Start-LockedAdapter([string]$Path) {
  $p = Start-Process $Path -PassThru
  Start-Sleep -Milliseconds 300
  if ($p.HasExited) { throw 'Synthetic adapter did not stay running' }
  return $p
}
function Assert-Stopped($Process) {
  if (!$Process.WaitForExit(10000)) { throw 'Installed adapter still running' }
}
try {
  Invoke-Installer
  $expectedAdapter = (Get-FileHash $adapter).Hash
  $expectedMain = (Get-FileHash $exe).Hash
  # A mapped executable has the same Windows replacement lock regardless of
  # MCP authentication. This fixture requires no real broker or credentials.
  $source = Join-Path $root 'SyntheticAdapter.cs'
  [IO.File]::WriteAllText($source, 'class SyntheticAdapter { static void Main() { System.Threading.Thread.Sleep(180000); } }')
  $fixture = Join-Path $otherDir 'leaf-mcp-adapter.exe'
  $csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
  & $csc /nologo /target:exe "/out:$fixture" $source
  if ($LASTEXITCODE -ne 0) { throw 'Synthetic adapter compilation failed' }
  Copy-Item $fixture $adapter -Force
  $other = Start-LockedAdapter $fixture
  $first = Start-LockedAdapter $adapter
  $second = Start-LockedAdapter $adapter
  $processes += $other, $first, $second
  $denied = $false
  try { $probe = [IO.File]::Open($adapter, 'Open', 'Write', 'ReadWrite'); $probe.Dispose() } catch [IO.IOException] { $denied = $true }
  if (!$denied) { throw 'Test did not reproduce the Windows executable write lock' }
  Write-Output 'PASS reproduced live adapter executable write lock'
  Invoke-Installer
  Assert-Stopped $first
  Assert-Stopped $second
  if ($other.HasExited) { throw 'Installer killed an adapter belonging to another installation' }
  if ((Get-FileHash $adapter).Hash -ne $expectedAdapter) { throw 'Upgrade did not replace the locked adapter' }
  if ((Get-FileHash $sentinel).Hash -ne $settingsHash) { throw 'Upgrade changed saved settings' }
  Write-Output 'PASS live locked upgrade, all matching helpers stopped, other path preserved, payload and settings intact'

  # A non-process file lock must fail before any payload is overwritten. Retry
  # succeeds after its owner releases it; silent mode must never hang on a UI.
  $lock = [IO.File]::Open($adapter, 'Open', 'Read', 'None')
  Invoke-Installer $false
  if ((Get-FileHash $exe).Hash -ne $expectedMain) { throw 'Blocked upgrade changed the main executable' }
  $lock.Dispose(); $lock = $null
  Invoke-Installer
  if ((Get-FileHash $adapter).Hash -ne $expectedAdapter) { throw 'Retry left a stale adapter' }
  Write-Output 'PASS external lock fails closed and retry succeeds'

  Copy-Item $fixture $adapter -Force
  $last = Start-LockedAdapter $adapter
  $processes += $last
  $uninstaller = Join-Path $installDir 'uninstall.exe'
  $p = Start-Process $uninstaller -ArgumentList @('/S', "_?=$installDir") -PassThru
  if (!$p.WaitForExit(90000)) { $p.Kill(); throw 'Uninstaller timed out' }
  if ($p.ExitCode -ne 0) { throw "Uninstaller failed: $($p.ExitCode)" }
  Assert-Stopped $last
  if (Test-Path $adapter) { throw 'Uninstaller left a locked adapter behind' }
  if ($other.HasExited) { throw 'Uninstaller killed another installation' }
  if ((Get-FileHash $sentinel).Hash -ne $settingsHash) { throw 'Uninstaller changed application settings' }
  Write-Output 'PASS uninstall releases only its installed helper and preserves settings'
} finally {
  if ($lock) { $lock.Dispose() }
  foreach ($p in $processes) { if (!$p.HasExited) { $p.Kill(); $p.WaitForExit() } }
  $uninstaller = Join-Path $installDir 'uninstall.exe'
  if (Test-Path $uninstaller) {
    $p = Start-Process $uninstaller -ArgumentList @('/S', "_?=$installDir") -PassThru
    if (!$p.WaitForExit(30000)) { $p.Kill() }
  }
  Remove-Item $appData -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}
