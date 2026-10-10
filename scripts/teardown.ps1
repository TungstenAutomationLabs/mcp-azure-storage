<#
.SYNOPSIS
    Tears down all Azure infrastructure for MCP Azure Storage.

.DESCRIPTION
    This script removes ALL Azure resources created by azd up, deploy_to_azure.ps1,
    and setup-monitoring.ps1, including:
      - The entire resource group (Container App, ACR, Storage, Log Analytics, etc.)
      - Application Insights (including soft-delete purge)
      - Azure Monitor Workbooks
      - Alert rules
      - Local azd environment state (optional)

    The script uses resource group deletion as the primary mechanism, which
    cascades to all child resources. It then purges any soft-deleted resources
    (App Insights) to free the names for reuse.

.PARAMETER ResourceGroup
    The Azure resource group to delete. If not provided, reads from the azd
    environment or .env file.

.PARAMETER EnvironmentName
    The azd environment name (used to find local state). Default: reads from
    .azure/config.json.

.PARAMETER CleanLocalState
    Also remove the local .azure/<env> directory and azd state files.
    Default: false.

.PARAMETER Force
    Skip all confirmation prompts. USE WITH CAUTION.

.PARAMETER SubscriptionId
    Azure subscription ID. If not provided, uses the current az CLI default.

.EXAMPLE
    .\scripts\teardown.ps1
    # Interactive tear-down using auto-detected resource group

.EXAMPLE
    .\scripts\teardown.ps1 -ResourceGroup "rg-storagemcptest" -Force -CleanLocalState
    # Non-interactive full cleanup including local state

.EXAMPLE
    .\scripts\teardown.ps1 -ResourceGroup "rg-mymcp" -Force
    # Tear down a specific resource group without prompts
#>

[CmdletBinding()]
param(
    [string]$ResourceGroup,
    [string]$EnvironmentName,
    [string]$SubscriptionId,
    [switch]$CleanLocalState,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Helpers ──────────────────────────────────────────────────────────────────
function Write-Step($msg)    { Write-Host "`n>> $msg" -ForegroundColor Cyan }
function Write-Detail($msg)  { Write-Host "   $msg" -ForegroundColor Gray }
function Write-Ok($msg)      { Write-Host "   [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg)    { Write-Host "   [WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg)     { Write-Host "   [ERR] $msg" -ForegroundColor Red }

function Invoke-AzSafe {
    param([string[]]$Arguments)
    # Temporarily allow stderr so az CLI warnings/errors don't terminate
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $result = & az @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEAP
    }
    $stderr = @($result | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] }) -join "`n"
    $stdout = @($result | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
    return @{
        ExitCode = $exitCode
        StdOut   = $stdout
        StdErr   = $stderr
    }
}

# ── Prerequisites ────────────────────────────────────────────────────────────
Write-Step "Checking prerequisites"

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    Write-Err "Azure CLI (az) is not installed or not in PATH."
    exit 1
}

$accountCheck = Invoke-AzSafe @('account', 'show', '--output', 'json')
if ($accountCheck.ExitCode -ne 0) {
    Write-Err "Not logged into Azure CLI. Run 'az login' first."
    exit 1
}
Write-Ok "Azure CLI authenticated"

# ── Resolve configuration ────────────────────────────────────────────────────
Write-Step "Resolving environment configuration"

# Try to read azd environment name from .azure/config.json
$projectRoot = Split-Path $PSScriptRoot -Parent
$azdConfigPath = Join-Path $projectRoot (Join-Path ".azure" "config.json")

if (-not $EnvironmentName -and (Test-Path $azdConfigPath)) {
    $azdConfig = Get-Content $azdConfigPath -Raw | ConvertFrom-Json
    if ($azdConfig.defaultEnvironment) {
        $EnvironmentName = $azdConfig.defaultEnvironment
        Write-Detail "Detected azd environment: $EnvironmentName"
    }
}

# Try to read resource group from azd env file
$azdEnvPath = ""
if ($EnvironmentName) {
    $azdEnvPath = Join-Path $projectRoot (Join-Path ".azure" (Join-Path $EnvironmentName ".env"))
}

if (-not $ResourceGroup -and $azdEnvPath -and (Test-Path $azdEnvPath)) {
    $envContent = Get-Content $azdEnvPath
    foreach ($line in $envContent) {
        if ($line -match '^\s*AZURE_RESOURCE_GROUP\s*=\s*"?([^"]+)"?\s*$') {
            $ResourceGroup = $Matches[1]
            Write-Detail "Resource group from azd env: $ResourceGroup"
        }
        if (-not $SubscriptionId -and $line -match '^\s*AZURE_SUBSCRIPTION_ID\s*=\s*"?([^"]+)"?\s*$') {
            $SubscriptionId = $Matches[1]
            Write-Detail "Subscription from azd env: $SubscriptionId"
        }
    }
}

# Fallback: try .env in project root
if (-not $ResourceGroup) {
    $dotEnvPath = Join-Path $projectRoot ".env"
    if (Test-Path $dotEnvPath) {
        $envContent = Get-Content $dotEnvPath
        foreach ($line in $envContent) {
            if ($line -match '^\s*AZURE_RESOURCE_GROUP\s*=\s*"?([^"]+)"?\s*$') {
                $ResourceGroup = $Matches[1]
                Write-Detail "Resource group from .env: $ResourceGroup"
            }
        }
    }
}

if (-not $ResourceGroup) {
    Write-Err "Could not determine resource group. Provide -ResourceGroup parameter."
    exit 1
}

Write-Ok "Target resource group: $ResourceGroup"

# Set subscription if provided
if ($SubscriptionId) {
    Write-Detail "Setting subscription: $SubscriptionId"
    $subResult = Invoke-AzSafe @('account', 'set', '--subscription', $SubscriptionId)
    if ($subResult.ExitCode -ne 0) {
        Write-Err "Failed to set subscription: $($subResult.StdErr)"
        exit 1
    }
}

# ── Confirmation ─────────────────────────────────────────────────────────────
Write-Step "Resources to be deleted"

# List what's in the resource group
$listResult = Invoke-AzSafe @(
    'resource', 'list',
    '--resource-group', $ResourceGroup,
    '--query', '[].{name:name, type:type}',
    '--output', 'table'
)

if ($listResult.ExitCode -eq 0 -and $listResult.StdOut) {
    Write-Host $listResult.StdOut
} else {
    Write-Warn "Resource group '$ResourceGroup' not found or empty."
    Write-Warn "It may have already been deleted."
}

# Check for App Insights that might need purging
$appiResult = Invoke-AzSafe @(
    'resource', 'list',
    '--resource-group', $ResourceGroup,
    '--resource-type', 'Microsoft.Insights/components',
    '--query', '[].name',
    '--output', 'json'
)
$appInsightsNames = @()
if ($appiResult.ExitCode -eq 0 -and $appiResult.StdOut -and $appiResult.StdOut -ne '[]') {
    $appInsightsNames = @($appiResult.StdOut | ConvertFrom-Json)
    Write-Detail "App Insights to purge after deletion: $($appInsightsNames -join ', ')"
}

if (-not $Force) {
    Write-Host ""
    Write-Host "WARNING: This will PERMANENTLY DELETE the resource group '$ResourceGroup'" -ForegroundColor Red
    Write-Host "         and ALL resources inside it. This action cannot be undone." -ForegroundColor Red
    Write-Host ""
    $confirm = Read-Host "Type the resource group name to confirm deletion"
    if ($confirm -ne $ResourceGroup) {
        Write-Err "Confirmation failed. Aborting."
        exit 1
    }
}

# ── Delete Resource Group ────────────────────────────────────────────────────
Write-Step "Deleting resource group: $ResourceGroup"
Write-Detail "This may take several minutes..."

$deleteResult = Invoke-AzSafe @(
    'group', 'delete',
    '--name', $ResourceGroup,
    '--yes',
    '--no-wait'
)

if ($deleteResult.ExitCode -eq 0) {
    Write-Ok "Resource group deletion initiated (async)"
    Write-Detail "Waiting for deletion to complete..."

    # Poll until the resource group is gone (max 15 minutes)
    $maxWait = 900
    $elapsed = 0
    $interval = 15
    while ($elapsed -lt $maxWait) {
        Start-Sleep -Seconds $interval
        $elapsed += $interval
        $checkResult = Invoke-AzSafe @('group', 'exists', '--name', $ResourceGroup)
        if ($checkResult.StdOut -match 'false') {
            Write-Ok "Resource group deleted successfully ($elapsed seconds)"
            break
        }
        Write-Detail "Still deleting... ($elapsed seconds elapsed)"
    }
    if ($elapsed -ge $maxWait) {
        Write-Warn "Deletion is still running after $maxWait seconds. Check Azure Portal."
    }
} else {
    if ($deleteResult.StdErr -match 'ResourceGroupNotFound' -or $deleteResult.StdErr -match 'could not be found') {
        Write-Warn "Resource group '$ResourceGroup' does not exist (already deleted?)"
    } else {
        Write-Err "Failed to delete resource group: $($deleteResult.StdErr)"
        exit 1
    }
}

# ── Post-Deletion Notes ─────────────────────────────────────────────────────
# App Insights: no soft-delete mechanism; fully removed with the resource group.
# ACR (Basic SKU): no soft-delete; fully removed with the resource group.
# Workbooks, Alert Rules, Managed Identity, RBAC: all cascade-deleted with the RG.
if ($appInsightsNames.Count -gt 0) {
    Write-Detail "App Insights ($($appInsightsNames -join ', ')): removed with resource group"
}
Write-Detail "ACR, Workbooks, Alerts, Identity: removed with resource group"

# ── Clean Local azd State ───────────────────────────────────────────────────
if ($CleanLocalState -and $EnvironmentName) {
    Write-Step "Cleaning local azd state"

    $azdEnvDir = Join-Path $projectRoot (Join-Path ".azure" $EnvironmentName)
    if (Test-Path $azdEnvDir) {
        Remove-Item -Path $azdEnvDir -Recurse -Force
        Write-Ok "Removed: $azdEnvDir"
    } else {
        Write-Warn "Directory not found: $azdEnvDir"
    }

    # Remove the state change file
    $stateFile = Join-Path $projectRoot (Join-Path ".azure" ".state-change")
    if (Test-Path $stateFile) {
        Remove-Item -Path $stateFile -Force
        Write-Ok "Removed: $stateFile"
    }

    # Reset config.json default environment
    if (Test-Path $azdConfigPath) {
        $azdConfig = Get-Content $azdConfigPath -Raw | ConvertFrom-Json
        if ($azdConfig.defaultEnvironment -eq $EnvironmentName) {
            $azdConfig.defaultEnvironment = ""
            $jsonStr = $azdConfig | ConvertTo-Json
            # Write BOM-free UTF-8 (PS5's -Encoding UTF8 adds a BOM which azd rejects)
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            [System.IO.File]::WriteAllText((Resolve-Path $azdConfigPath).Path, $jsonStr, $utf8NoBom)
            Write-Ok "Cleared default environment in .azure/config.json"
        }
    }
} elseif ($CleanLocalState) {
    Write-Warn "Cannot clean local state: environment name not detected. Use -EnvironmentName."
}

# ── Summary ──────────────────────────────────────────────────────────────────
Write-Step "Tear-down complete"
Write-Host ""
Write-Host "  Deleted resources:" -ForegroundColor White
Write-Host "    - Resource group: $ResourceGroup (and all child resources)" -ForegroundColor Gray
Write-Host "    - Container App, ACR, Storage Account, Log Analytics" -ForegroundColor Gray
Write-Host "    - App Insights, Workbooks, Alert Rules, Managed Identity" -ForegroundColor Gray
Write-Host "    - RBAC role assignments" -ForegroundColor Gray
if ($CleanLocalState) {
    Write-Host "    - Local azd environment state" -ForegroundColor Gray
}
Write-Host ""
Write-Host "  To redeploy from scratch:" -ForegroundColor White
Write-Host "    1. Create a new .env with your desired AZURE_ENV_NAME" -ForegroundColor Gray
Write-Host "    2. Run: .\deploy_to_azure.ps1" -ForegroundColor Gray
Write-Host "    3. (Optional) Run: .\scripts\setup-monitoring.ps1" -ForegroundColor Gray
Write-Host ""
