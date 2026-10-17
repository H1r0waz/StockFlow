param([ValidateSet('start','stop','status')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$cluster = Join-Path $workspace '.cache/postgres/data'
$envPath = Join-Path $workspace '.env'
$pgControl = (Get-Command pg_ctl -ErrorAction Stop).Source
if ($Action -eq 'stop') {
  if (Test-Path -LiteralPath $cluster) { & $pgControl -D $cluster stop -m fast; if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL stop failed' } }
  exit
}
if ($Action -eq 'status') { & $pgControl -D $cluster status; exit $LASTEXITCODE }
if (-not (Test-Path -LiteralPath $cluster)) {
  if (Test-Path -LiteralPath $envPath) { throw 'Existing .env found; refusing to replace configuration or initialize with unknown credentials' }
  $listener = Get-NetTCPConnection -State Listen -LocalPort 55434 -ErrorAction SilentlyContinue
  if ($listener) { throw 'Port 55434 already in use; refusing to reuse another instance' }
  $localDirectory = Join-Path $workspace '.cache/postgres'
  $null = New-Item -ItemType Directory -Path $localDirectory -Force
  $passwordBytes = [byte[]]::new(32)
  [Security.Cryptography.RandomNumberGenerator]::Fill($passwordBytes)
  $databasePassword = [Convert]::ToHexString($passwordBytes).ToLowerInvariant()
  $passwordFile = Join-Path $localDirectory 'init-password.tmp'
  [IO.File]::WriteAllText($passwordFile, $databasePassword, [Text.UTF8Encoding]::new($false))
  try {
    & initdb -D $cluster -U stockflow --auth-host=scram-sha-256 --auth-local=scram-sha-256 --encoding=UTF8 --locale=C --pwfile=$passwordFile
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL initialization failed' }
  } finally { Remove-Item -LiteralPath $passwordFile -Force }
  $localEnv = "DATABASE_URL=postgresql://stockflow:${databasePassword}@127.0.0.1:55434/stockflow_dev`nTEST_DATABASE_URL=postgresql://stockflow:${databasePassword}@127.0.0.1:55434/stockflow_test`nWEB_ORIGIN=http://127.0.0.1:5173`nPORT=3001`n"
  $stream = [IO.File]::Open($envPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
  try { $bytes = [Text.UTF8Encoding]::new($false).GetBytes($localEnv); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
}
& $pgControl -D $cluster status *> $null
if ($LASTEXITCODE -ne 0) {
  & $pgControl -D $cluster -l (Join-Path $workspace '.cache/postgres/server.log') -o '-h 127.0.0.1 -p 55434' -w start
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL start failed' }
}
Write-Output 'StockFlow-only PostgreSQL is listening on 127.0.0.1:55434. Credentials remain in ignored .env.'
