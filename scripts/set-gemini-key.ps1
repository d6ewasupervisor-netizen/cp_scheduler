#Requires -Version 5.1
<#
.SYNOPSIS
  Set GEMINI_API_KEY on Railway (and optionally local .env) without echoing the secret.

.DESCRIPTION
  Prompts with a masked SecureString, pipes the value into railway variable set --stdin,
  never prints the key, and only reports whether the variable is present afterward.

  Usage (from cp_scheduler repo root):
    powershell -ExecutionPolicy Bypass -File .\scripts\set-gemini-key.ps1
    npm run set-gemini-key

  Options:
    -SkipDeploy   Do not trigger a Railway redeploy
    -LocalEnv     Also write/update .env in the repo (gitignored)
    -Service      Railway service name (default: cp_scheduler)
#>
param(
  [switch]$SkipDeploy,
  [switch]$LocalEnv,
  [string]$Service = 'cp_scheduler'
)

$ErrorActionPreference = 'Stop'

function Assert-RailwayCli {
  $cmd = Get-Command railway -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw 'Railway CLI not found on PATH. Install/login first, then re-run this script.'
  }
}

function Test-GeminiKeyPresent {
  param([string]$ServiceName)
  # Prefer presence-only check: do not dump --json (that includes raw secrets).
  $kv = & railway variable list -s $ServiceName -k 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not list Railway variables. Is the project linked and CLI authed?'
  }
  $line = ($kv | Where-Object { $_ -match '^GEMINI_API_KEY=' } | Select-Object -First 1)
  if (-not $line) { return $false }
  $val = $line -replace '^GEMINI_API_KEY=', ''
  return ($val.Length -gt 0)
}

function Set-LocalEnvKey {
  param([string]$PlainKey)
  $envPath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path '.env'
  $lines = @()
  if (Test-Path $envPath) {
    $lines = Get-Content -LiteralPath $envPath -ErrorAction SilentlyContinue
  }
  $out = @()
  $replaced = $false
  foreach ($line in $lines) {
    if ($line -match '^\s*GEMINI_API_KEY\s*=') {
      $out += "GEMINI_API_KEY=$PlainKey"
      $replaced = $true
    } else {
      $out += $line
    }
  }
  if (-not $replaced) {
    if ($out.Count -gt 0 -and $out[-1] -ne '') { $out += '' }
    $out += "GEMINI_API_KEY=$PlainKey"
  }
  Set-Content -LiteralPath $envPath -Value $out -Encoding utf8
  Write-Host 'Updated local .env (gitignored) - value not printed.' -ForegroundColor DarkGray
}

Assert-RailwayCli

Write-Host ''
Write-Host 'Gemini API key -> Railway (masked entry)' -ForegroundColor Cyan
Write-Host 'Get a key at: https://aistudio.google.com/apikey' -ForegroundColor DarkGray
Write-Host "Service: $Service" -ForegroundColor DarkGray
Write-Host ''

$secure = Read-Host 'Paste GEMINI_API_KEY (input hidden)' -AsSecureString
if (-not $secure -or $secure.Length -eq 0) {
  throw 'No key entered - aborted.'
}

$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) | Out-Null
}

if (-not $plain -or $plain.Trim().Length -lt 20) {
  $plain = $null
  throw 'Key looks too short - aborted (nothing was set).'
}

$plain = $plain.Trim()
# Soft shape check only - never print the value
if ($plain -notmatch '^AIza') {
  Write-Host 'Warning: Gemini keys usually start with AIza... Continuing anyway.' -ForegroundColor Yellow
}

$setArgs = @('variable', 'set', 'GEMINI_API_KEY', '--stdin', '-s', $Service)
if ($SkipDeploy) { $setArgs += '--skip-deploys' }

Write-Host 'Setting GEMINI_API_KEY on Railway...' -ForegroundColor DarkGray
# Pipe secretly: do not use Write-Output to the console
$plain | & railway @setArgs | Out-Null
$exit = $LASTEXITCODE

# Clear plaintext ASAP
$plainLen = $plain.Length
if ($LocalEnv -and $exit -eq 0) {
  Set-LocalEnvKey -PlainKey $plain
}
$plain = $null
[GC]::Collect()

if ($exit -ne 0) {
  throw "railway variable set failed (exit $exit). Key was not confirmed."
}

# Also set the model default if missing (non-secret)
$modelKv = & railway variable list -s $Service -k 2>$null
if ($modelKv -notmatch '(?m)^GEMINI_MODEL=') {
  Write-Host 'Setting GEMINI_MODEL=gemini-3.1-flash-lite...' -ForegroundColor DarkGray
  $modelArgs = @('variable', 'set', 'GEMINI_MODEL=gemini-3.1-flash-lite', '-s', $Service)
  if ($SkipDeploy) { $modelArgs += '--skip-deploys' }
  & railway @modelArgs | Out-Null
}

$present = Test-GeminiKeyPresent -ServiceName $Service
if (-not $present) {
  throw 'Set reported success but GEMINI_API_KEY is not present on the service.'
}

Write-Host ''
Write-Host ("OK - GEMINI_API_KEY is set on Railway service '{0}' ({1} chars)." -f $Service, $plainLen) -ForegroundColor Green
if (-not $SkipDeploy) {
  Write-Host 'A redeploy was triggered so the new key is picked up.' -ForegroundColor DarkGray
} else {
  Write-Host 'Skipped redeploy (-SkipDeploy). Redeploy when ready.' -ForegroundColor DarkGray
}
Write-Host 'Verify (no secret): GET /health -> photoAi.classifyEnabled should be true after deploy.' -ForegroundColor DarkGray
Write-Host ''
