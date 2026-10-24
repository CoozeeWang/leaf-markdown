# Reuse verified application bytes; only regenerate the NSIS wrapper.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or !$env:RUNNER_TEMP) { throw 'Disposable runner required' }
if ($env:LEAF_REUSE_RUN -notmatch '^\d+$' -or $env:LEAF_REUSE_SOURCE -notmatch '^[a-f0-9]{40}$' -or $env:LEAF_REUSE_SHA256 -notmatch '^[a-f0-9]{64}$') { throw 'Exact reuse provenance required' }
$actual = gh api "repos/CoozeeWang/leaf-markdown/actions/runs/$env:LEAF_REUSE_RUN" --jq .head_sha
if ($LASTEXITCODE -or $actual.Trim() -ne $env:LEAF_REUSE_SOURCE) { throw 'Installer source mismatch' }
$work = Join-Path $env:RUNNER_TEMP 'leaf-verified-repackage'
if (Test-Path $work) { throw 'Existing capture directory' }
New-Item $work -ItemType Directory | Out-Null
gh run download $env:LEAF_REUSE_RUN --repo CoozeeWang/leaf-markdown --name "Unvalidated-NSIS-$env:LEAF_REUSE_SOURCE" --dir $work
if ($LASTEXITCODE) { throw 'Existing installer retrieval failed' }
$installers = @(Get-ChildItem $work -Filter '*.exe')
if ($installers.Count -ne 1 -or (Get-FileHash $installers[0].FullName -Algorithm SHA256).Hash.ToLower() -ne $env:LEAF_REUSE_SHA256) { throw 'Existing installer hash mismatch' }
$capture = Join-Path $work 'installed'
$config = Get-Content "$PSScriptRoot/../src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
$manufacturer = if ($config.bundle.publisher) { $config.bundle.publisher } else { $config.identifier.Split('.')[1] }
$installerKey = "HKCU:\Software\$manufacturer\$($config.productName)"
if (Test-Path $installerKey) { throw 'Existing application registration; refusing payload capture' }
$process = Start-Process $installers[0].FullName -ArgumentList @('/S','/NS',"/D=$capture") -PassThru
if (!$process.WaitForExit(120000) -or $process.ExitCode) { throw 'Disposable payload capture failed' }
try {
  $release = Join-Path $PWD "src-tauri/target/$env:LEAF_BUILD_TARGET/release"
  New-Item $release -ItemType Directory -Force | Out-Null
  New-Item src-tauri/binaries -ItemType Directory -Force | Out-Null
  $guiHash = (Get-FileHash (Join-Path $capture 'leaf.exe') -Algorithm SHA256).Hash
  $adapterHash = (Get-FileHash (Join-Path $capture 'leaf-mcp-adapter.exe') -Algorithm SHA256).Hash
  Copy-Item (Join-Path $capture 'leaf.exe') (Join-Path $release 'leaf.exe')
  Copy-Item (Join-Path $capture 'leaf-mcp-adapter.exe') (Join-Path $release 'leaf-mcp-adapter.exe')
  Copy-Item (Join-Path $capture 'leaf-mcp-adapter.exe') "src-tauri/binaries/leaf-mcp-adapter-$env:LEAF_BUILD_TARGET.exe"
  node node_modules/@tauri-apps/cli/tauri.js bundle --bundles nsis --target $env:LEAF_BUILD_TARGET --config src-tauri/tauri.windows.conf.json --ci
  if ($LASTEXITCODE) { throw 'Wrapper-only bundle failed' }
  if ((Get-FileHash (Join-Path $release 'leaf.exe') -Algorithm SHA256).Hash -ne $guiHash -or (Get-FileHash (Join-Path $release 'leaf-mcp-adapter.exe') -Algorithm SHA256).Hash -ne $adapterHash -or (Get-FileHash "src-tauri/binaries/leaf-mcp-adapter-$env:LEAF_BUILD_TARGET.exe" -Algorithm SHA256).Hash -ne $adapterHash) { throw 'Repackaging changed application bytes' }
  "LEAF_REUSED_APPLICATION_SOURCE=$env:LEAF_REUSE_SOURCE" >> $env:GITHUB_ENV
  "LEAF_REUSED_GUI_SHA256=$guiHash" >> $env:GITHUB_ENV
  "LEAF_REUSED_ADAPTER_SHA256=$adapterHash" >> $env:GITHUB_ENV
  Write-Output 'PASS wrapper-only NSIS bundling; GUI and MCP executable hashes unchanged'
} finally {
  $uninstall = Join-Path $capture 'uninstall.exe'
  if (Test-Path $uninstall) {
    $process = Start-Process $uninstall -ArgumentList @('/S',"_?=$capture") -PassThru
    if (!$process.WaitForExit(90000)) { $process.Kill(); throw 'Capture cleanup timed out' }
  }
  # NSIS retains the language preference; this key was absent before capture.
  Remove-Item $installerKey -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
