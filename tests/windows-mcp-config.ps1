# Real vendor parser + isolated native broker/host checks. No real API key.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Run in a disposable GitHub Actions Windows runner only' }
# The complete Rust suite runs in the preceding workflow step.
$archive = 'tunnel-client-v0.0.16-windows-amd64.zip'
$metadata = Invoke-RestMethod 'https://api.github.com/repos/openai/tunnel-client/releases/tags/v0.0.16'
$asset = $metadata.assets | Where-Object { $_.name -eq $archive }
if (!$asset -or !$asset.digest.StartsWith('sha256:')) { throw 'Official archive digest missing' }
$directory = Join-Path $env:RUNNER_TEMP 'Leaf MCP vendor'
New-Item -ItemType Directory -Force $directory | Out-Null
$zip = Join-Path $directory $archive
Invoke-WebRequest $asset.browser_download_url -OutFile $zip
if (('sha256:' + (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()) -ne $asset.digest) { throw 'Official archive digest mismatch' }
Expand-Archive $zip -DestinationPath (Join-Path $directory 'unpacked') -Force
$client = Get-ChildItem (Join-Path $directory 'unpacked') -Filter tunnel-client.exe -Recurse | Select-Object -First 1
if (!$client) { throw 'Official tunnel-client.exe missing' }
$env:LEAF_TEST_TUNNEL_CLIENT = $client.FullName
cargo test --locked --manifest-path src-tauri/Cargo.toml --bin leaf official_tunnel_client_prepares_profile_with_spaces_and_unicode -- --nocapture
if ($LASTEXITCODE -ne 0) { throw 'Production profile preparation failed against official tunnel-client' }
Remove-Item Env:LEAF_TEST_TUNNEL_CLIENT
$nativeFailures = @()
node scripts/test-mcp-startup.mjs
if ($LASTEXITCODE -ne 0) { $nativeFailures += 'Native consent restart regression failed' }
node scripts/test-mcp-adapter.mjs stdio-and-origin --reuse-build
if ($LASTEXITCODE -ne 0) { $nativeFailures += 'Generated Claude/WorkBuddy host transport regression failed' }
if ($nativeFailures.Count) { throw ($nativeFailures -join '; ') }
