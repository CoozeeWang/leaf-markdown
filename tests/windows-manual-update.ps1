# Destructive installer check; disposable Actions runner only. All data is synthetic.
param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or !$env:RUNNER_TEMP) { throw 'Requires a disposable GitHub Actions runner' }
$Installer = (Resolve-Path $Installer).Path
$config = Get-Content "$PSScriptRoot/../src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
$root = Join-Path $env:RUNNER_TEMP 'Leaf manual upgrade synthetic 中文'
$data = Join-Path $env:APPDATA $config.identifier
$local = Join-Path $env:LOCALAPPDATA $config.identifier
if ((Test-Path $root) -or (Test-Path $data) -or (Test-Path $local)) { throw 'Existing data found; refusing to overwrite' }
$installed = Join-Path $root 'installed'
New-Item $root,$data,$local -ItemType Directory | Out-Null
function Install([string]$Path) {
  $p = Start-Process $Path -ArgumentList @('/S','/NS',"/D=$installed") -PassThru
  if (!$p.WaitForExit(120000)) { $p.Kill(); throw 'Installer timed out' }
  if ($p.ExitCode) { throw "Installer failed: $($p.ExitCode)" }
}
function Inventory([string]$Path) {
  $result = @{}
  Get-ChildItem $Path -Recurse -File | ForEach-Object { $result[$_.FullName.Substring($Path.Length)] = (Get-FileHash $_.FullName -Algorithm SHA256).Hash }
  return $result
}
try {
  $old = Join-Path $root 'Leaf-1.0.2-windows-x64-setup.exe'
  Invoke-WebRequest 'https://github.com/CoozeeWang/leaf-markdown/releases/download/v1.0.2/Leaf-1.0.2-windows-x64-setup.exe' -OutFile $old
  if ((Get-FileHash $old -Algorithm SHA256).Hash.ToLower() -ne '789e964b15dbabb27831538d22142a3c1ac35a30c7b2de4ef9ed45453b111a5c') { throw 'Published baseline hash mismatch' }
  Install $old
  # Persisted schema and directory names match the product; no live credentials.
  $profiles = @('chatgpt','claude-desktop','workbuddy') | ForEach-Object { @{client=$_;configured=$false;enabled=$false;generation=7;credential_ref=$null;tunnel=$null;has_runtime_key=$false} }
  [IO.File]::WriteAllText((Join-Path $data 'mcp-profiles-v1.json'),($profiles | ConvertTo-Json))
  [IO.File]::WriteAllText((Join-Path $data 'mcp-preferences-v1.json'),'{"enabled":false}')
  [IO.File]::WriteAllText((Join-Path $data 'language-v1.json'),'{"preference":"en"}')
  New-Item (Join-Path $data 'synthetic-recovery'),(Join-Path $data 'mcp/tunnel'),(Join-Path $local 'synthetic-webview') -ItemType Directory | Out-Null
  [IO.File]::WriteAllText((Join-Path $data 'synthetic-recovery/draft.md'),'Synthetic unsaved draft; preserve exact bytes')
  [IO.File]::WriteAllText((Join-Path $data 'mcp/tunnel/synthetic.yaml'),'synthetic configuration; no secrets')
  [IO.File]::WriteAllText((Join-Path $local 'synthetic-webview/preferences.txt'),'synthetic theme/font/layout settings')
  $before = Inventory $data
  $localBefore = Inventory $local
  Install $Installer
  $version = [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $installed 'leaf.exe')).ProductVersion
  if ($version -notmatch ('^' + [regex]::Escape($config.version) + '(?:\.0)?$')) { throw "Unexpected installed version: $version" }
  foreach ($entry in $before.GetEnumerator()) { if ((Get-FileHash ($data + $entry.Key) -Algorithm SHA256).Hash -ne $entry.Value) { throw 'Roaming configuration or draft changed' } }
  foreach ($entry in $localBefore.GetEnumerator()) { if ((Get-FileHash ($local + $entry.Key) -Algorithm SHA256).Hash -ne $entry.Value) { throw 'Local preferences changed' } }
  if (!(Test-Path (Join-Path $installed 'leaf-mcp-adapter.exe'))) { throw 'MCP adapter missing' }
  if (Test-Path (Join-Path $installed 'leaf-update-helper.exe')) { throw 'Retired automatic installer helper remains installed' }
  New-Item (Join-Path $PWD 'test-results') -ItemType Directory -Force | Out-Null
  @{source=$env:GITHUB_SHA;from_version='1.0.2';to_version=$config.version;data_files=$before.Count;local_files=$localBefore.Count;manual_install_pass=$true;persisted_bytes_preserved=$true;automatic_helper_absent=$true;external_mcp_authorization_tested=$false} | ConvertTo-Json | Set-Content (Join-Path $PWD 'test-results/windows-manual-update.json') -Encoding UTF8
  Write-Output 'PASS manual 1.0.2 upgrade: version, MCP adapter, exact persisted synthetic data and preferences; retired installer helper absent'
} finally {
  $uninstaller = Join-Path $installed 'uninstall.exe'
  if (Test-Path $uninstaller) {
    $p = Start-Process $uninstaller -ArgumentList @('/S',"_?=$installed") -PassThru
    if (!$p.WaitForExit(90000)) { $p.Kill(); throw 'Fixture uninstall timed out' }
  }
  # Only disposable data created after the existing-data refusal above.
  Remove-Item $data,$local,$root -Recurse -Force -ErrorAction SilentlyContinue
}
