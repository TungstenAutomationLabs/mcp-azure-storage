<#
.SYNOPSIS
    Reads .env variables and deploys the MCP Azure Storage server via Azure Developer CLI.

.DESCRIPTION
    This script:
      1. Parses the .env file in the project root (skipping comments and blank lines)
      2. Syncs key variables (AZURE_STORAGE_ACCOUNT_NAME, AZURE_STORAGE_ACCOUNT_KEY,
         MCP_API_KEY) into the active azd environment using `azd env set`
      3. Runs `azd up` to provision infrastructure and deploy the container

    This means you only need to maintain ONE .env file for both local dev and
    Azure deployment. No need to remember separate `azd env set` commands.

.PARAMETER EnvFile
    Path to the .env file. Defaults to ".env" in the script's directory.

.PARAMETER SkipProvision
    If set, runs `azd deploy` instead of `azd up` (skips infrastructure provisioning).
    Use this when you've only changed code, not infrastructure or env vars.

.EXAMPLE
    .\deploy_to_azure.ps1
    # Full provision + deploy using .env values

.EXAMPLE
    .\deploy_to_azure.ps1 -SkipProvision
    # Code-only redeploy (faster, skips Bicep provisioning)

.EXAMPLE
    .\deploy_to_azure.ps1 -EnvFile ".env.production"
    # Use a different env file
#>

[CmdletBinding()]
param(
    [string]$EnvFile = "",
    [switch]$SkipProvision
)

# Resolve EnvFile default — $PSScriptRoot can be empty when invoked via -File
if ([string]::IsNullOrEmpty($EnvFile)) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
    $EnvFile = Join-Path $scriptDir ".env"
}

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# -- Helper functions for coloured output --
function Write-Step  { param([string]$msg) Write-Host "`n>> $msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$msg) Write-Host "   [OK] $msg" -ForegroundColor Green }
function Write-Skip  { param([string]$msg) Write-Host "   [--] $msg" -ForegroundColor DarkGray }
function Write-Warn  { param([string]$msg) Write-Host "   [!!] $msg" -ForegroundColor Yellow }

# -- 1. Parse .env file --
Write-Step "Reading $EnvFile"

if (-not (Test-Path $EnvFile)) {
    Write-Error "Environment file not found: $EnvFile"
    exit 1
}

$envVars = @{}
Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    # Skip blank lines and comments (lines starting with #)
    if ([string]::IsNullOrEmpty($line) -or $line.StartsWith('#')) { return }
    # Parse KEY=VALUE (supports optional quoting)
    if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
        $key = $Matches[1]
        $value = $Matches[2].Trim('"').Trim("'")
        $envVars[$key] = $value
    }
}

Write-Ok "Parsed $($envVars.Count) variable(s) from .env"

# -- 2. Verify azd is available --
Write-Step "Checking azd CLI"
$azdPath = Get-Command azd -ErrorAction SilentlyContinue
if (-not $azdPath) {
    Write-Error "Azure Developer CLI (azd) is not installed or not in PATH. Install from: https://aka.ms/azd-install"
    exit 1
}
Write-Ok "azd found at $($azdPath.Source)"

# -- 3. Show current azd environment --
Write-Step "Current azd environment"
$currentEnv = azd env list --output json 2>$null | ConvertFrom-Json | Where-Object { $_.IsDefault -eq $true }
if ($currentEnv) {
    Write-Ok "Active environment: $($currentEnv.Name)"
} else {
    Write-Warn "No default azd environment found. Run 'azd init' first."
    exit 1
}

# -- 4. Sync variables to azd environment --
Write-Step "Syncing .env variables to azd environment '$($currentEnv.Name)'"

# Variables to sync from .env -> azd env
$syncKeys = @(
    "AZURE_STORAGE_ACCOUNT_NAME",
    "AZURE_STORAGE_ACCOUNT_KEY",
    "MCP_API_KEY"
)

foreach ($key in $syncKeys) {
    if ($envVars.ContainsKey($key) -and -not [string]::IsNullOrEmpty($envVars[$key])) {
        # Mask sensitive values in output
        if ($key -match "KEY|SECRET") {
            $displayValue = $envVars[$key].Substring(0, [Math]::Min(6, $envVars[$key].Length)) + "..."
        } else {
            $displayValue = $envVars[$key]
        }
        azd env set $key $envVars[$key] 2>$null
        Write-Ok "$key = $displayValue"
    } else {
        Write-Skip "$key not set in .env (will use azd/Bicep default)"
    }
}

# -- 5. Show summary before deploying --
Write-Step "Deployment summary"
Write-Host "  Environment:     $($currentEnv.Name)" -ForegroundColor White
if ($envVars.ContainsKey("AZURE_STORAGE_ACCOUNT_NAME") -and -not [string]::IsNullOrEmpty($envVars["AZURE_STORAGE_ACCOUNT_NAME"])) {
    Write-Host "  Storage Account: $($envVars['AZURE_STORAGE_ACCOUNT_NAME']) (BYOSA - bring your own)" -ForegroundColor White
} else {
    Write-Host "  Storage Account: (auto-provisioned by Bicep)" -ForegroundColor White
}
if ($SkipProvision) {
    Write-Host "  Mode:            Deploy only (azd deploy)" -ForegroundColor White
} else {
    Write-Host "  Mode:            Full provision + deploy (azd up)" -ForegroundColor White
}

# -- 6. Confirm --
Write-Host ""
$confirm = Read-Host "Proceed with deployment? (y/N)"
if ($confirm -notin @('y', 'Y', 'yes', 'Yes')) {
    Write-Warn "Deployment cancelled."
    exit 0
}

# -- 7. Deploy --
if ($SkipProvision) {
    Write-Step "Running azd deploy (code only, no infrastructure changes)"
    azd deploy
} else {
    Write-Step "Running azd up (provision infrastructure + deploy code)"
    azd up
}

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "====================================================" -ForegroundColor Green
    Write-Host "  Deployment completed successfully!" -ForegroundColor Green
    Write-Host "====================================================" -ForegroundColor Green

    # Show the MCP endpoint
    Write-Step "Retrieving deployment outputs"
    $mcpEndpoint = azd env get-value mcpEndpoint 2>$null
    if ($mcpEndpoint) {
        Write-Host ""
        Write-Host "  MCP Endpoint: $mcpEndpoint" -ForegroundColor Yellow
    }
} else {
    Write-Host ""
    Write-Host "====================================================" -ForegroundColor Red
    Write-Host "  Deployment failed! Check the output above for errors." -ForegroundColor Red
    Write-Host "====================================================" -ForegroundColor Red
    exit 1
}
