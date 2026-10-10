<#
.SYNOPSIS
    Idempotent Azure Monitor provisioning and verification for MCP Azure Storage.

.DESCRIPTION
    This script can:
      1. Create a Log Analytics workspace (if -WorkspaceName is provided)
      2. Create an Application Insights resource linked to the workspace
      3. Print the App Insights connection string for use with the OTel Collector
      4. Run verification KQL queries to check telemetry is flowing

    All resource creation is idempotent (uses PUT semantics -- creates or updates).
    Use -VerifyOnly to skip creation and just run diagnostic queries.

.PARAMETER ResourceGroup
    The Azure resource group to create resources in (must already exist).

.PARAMETER AppInsightsName
    Name for the Application Insights resource.

.PARAMETER Location
    Azure region for new resources. Default: uksouth.

.PARAMETER WorkspaceName
    (Optional) Name for a Log Analytics workspace. If not provided, looks for
    an existing workspace in the resource group.

.PARAMETER RetentionDays
    Data retention in days for both Log Analytics and App Insights. Range: 30-730.
    Default: 30.

.PARAMETER VerifyOnly
    Skip resource creation and only run verification queries against the
    specified App Insights resource.

.EXAMPLE
    .\scripts\setup-monitoring.ps1 -ResourceGroup "rg-mcp" -AppInsightsName "mcp-appi"
    # Create App Insights (finds existing workspace in the resource group)

.EXAMPLE
    .\scripts\setup-monitoring.ps1 -ResourceGroup "rg-mcp" -AppInsightsName "mcp-appi" -WorkspaceName "mcp-logs"
    # Create both workspace and App Insights

.EXAMPLE
    .\scripts\setup-monitoring.ps1 -ResourceGroup "rg-mcp" -AppInsightsName "mcp-appi" -VerifyOnly
    # Only run verification queries (no resource changes)
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ResourceGroup,

    [Parameter(Mandatory)]
    [string]$AppInsightsName,

    [string]$Location = "uksouth",

    [string]$WorkspaceName = "",

    [ValidateRange(30, 730)]
    [int]$RetentionDays = 30,

    [switch]$VerifyOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# -- Helper functions -----------------------------------------------------------

function Write-Step  { param([string]$msg) Write-Host "`n>> $msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$msg) Write-Host "   [OK] $msg" -ForegroundColor Green }
function Write-Skip  { param([string]$msg) Write-Host "   [--] $msg" -ForegroundColor DarkGray }
function Write-Warn  { param([string]$msg) Write-Host "   [!!] $msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$msg) Write-Host "   [ERR] $msg" -ForegroundColor Red }

# Safe Azure CLI wrapper -- avoids terminating errors from stderr warnings.
# Returns $null on failure so callers can check and handle gracefully.
function Invoke-AzSafe {
    param([string[]]$Arguments)
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = & az @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $prevPref
    if ($exitCode -ne 0) {
        $errorText = ($output | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] }) -join "`n"
        Write-Warn "az $($Arguments[0..1] -join ' ') failed (exit code $exitCode)"
        if ($errorText) {
            Write-Host "   $errorText" -ForegroundColor DarkGray
        }
        return $null
    }
    $stdout = ($output | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
    return $stdout
}

# -- Prerequisites check -------------------------------------------------------

Write-Step "Checking prerequisites"

$azPath = Get-Command az -ErrorAction SilentlyContinue
if (-not $azPath) {
    Write-Err "Azure CLI (az) is not installed or not in PATH."
    exit 1
}
Write-Ok "az CLI found at $($azPath.Source)"

# Check for application-insights extension
$extListJson = Invoke-AzSafe @('extension', 'list', '--output', 'json')
$hasAppiExt = $false
if ($extListJson) {
    $extList = @($extListJson | ConvertFrom-Json)
    $hasAppiExt = @($extList | Where-Object { $_.name -eq 'application-insights' }).Count -gt 0
}
if (-not $hasAppiExt) {
    Write-Warn "Required extension 'application-insights' not found. Installing..."
    $installResult = Invoke-AzSafe @('extension', 'add', '--name', 'application-insights', '--output', 'none')
    if ($null -eq $installResult -and $LASTEXITCODE -ne 0) {
        Write-Err "Failed to install 'application-insights' extension. Install manually: az extension add --name application-insights"
        exit 1
    }
    Write-Ok "Extension 'application-insights' installed"
} else {
    Write-Ok "Extension 'application-insights' is installed"
}

# Verify login
$accountJson = Invoke-AzSafe @('account', 'show', '--output', 'json')
if (-not $accountJson) {
    Write-Err "Not logged into Azure CLI. Run 'az login' first."
    exit 1
}
$account = $accountJson | ConvertFrom-Json
Write-Ok "Logged in as $($account.user.name) (subscription: $($account.name))"

# -- Verify resource group exists -----------------------------------------------

Write-Step "Verifying resource group '$ResourceGroup'"
$rgJson = Invoke-AzSafe @('group', 'show', '--name', $ResourceGroup, '--output', 'json')
if (-not $rgJson) {
    Write-Err "Resource group '$ResourceGroup' not found. Create it first or check the name."
    exit 1
}
Write-Ok "Resource group exists"

# -- Skip to verification if -VerifyOnly ---------------------------------------

if ($VerifyOnly) {
    Write-Step "VerifyOnly mode -- skipping resource creation"
} else {

    # -- Create or update Log Analytics workspace (optional) --------------------

    $workspaceId = ""

    if (-not [string]::IsNullOrEmpty($WorkspaceName)) {
        Write-Step "Creating/updating Log Analytics workspace '$WorkspaceName'"
        $wsJson = Invoke-AzSafe @(
            'monitor', 'log-analytics', 'workspace', 'create',
            '--resource-group', $ResourceGroup,
            '--workspace-name', $WorkspaceName,
            '--location', $Location,
            '--retention-time', $RetentionDays.ToString(),
            '--output', 'json'
        )
        if (-not $wsJson) {
            Write-Err "Failed to create Log Analytics workspace."
            exit 1
        }
        $ws = $wsJson | ConvertFrom-Json
        $workspaceId = $ws.id
        Write-Ok "Workspace ready: $workspaceId"
    } else {
        Write-Step "Looking for existing Log Analytics workspace in '$ResourceGroup'"
        $wsListJson = Invoke-AzSafe @(
            'monitor', 'log-analytics', 'workspace', 'list',
            '--resource-group', $ResourceGroup,
            '--output', 'json'
        )
        if ($wsListJson) {
            $wsList = $wsListJson | ConvertFrom-Json
            if ($wsList.Count -gt 0) {
                $workspaceId = $wsList[0].id
                Write-Ok "Found existing workspace: $($wsList[0].name)"
            } else {
                Write-Warn "No workspace found. Provide -WorkspaceName to create one."
                exit 1
            }
        } else {
            Write-Err "Failed to list workspaces."
            exit 1
        }
    }

    # -- Create or update Application Insights ----------------------------------

    Write-Step "Creating/updating Application Insights '$AppInsightsName'"
    # Note: --retention-time cannot be used when linked to a Log Analytics workspace;
    # retention is managed at the workspace level instead.
    $appiArgs = @(
        'monitor', 'app-insights', 'component', 'create',
        '--app', $AppInsightsName,
        '--resource-group', $ResourceGroup,
        '--location', $Location,
        '--kind', 'web',
        '--application-type', 'web',
        '--workspace', $workspaceId,
        '--output', 'json'
    )
    $appiJson = Invoke-AzSafe $appiArgs
    if (-not $appiJson) {
        Write-Err "Failed to create Application Insights resource."
        exit 1
    }
    $appi = $appiJson | ConvertFrom-Json
    Write-Ok "Application Insights ready: $($appi.name)"

    # -- Print connection string ------------------------------------------------

    Write-Step "Application Insights connection string"
    $connStr = $appi.connectionString
    if ($connStr) {
        Write-Host ""
        Write-Host "  $connStr" -ForegroundColor Yellow
        Write-Host ""
        Write-Ok "Use this value for APPLICATIONINSIGHTS_CONNECTION_STRING"
    } else {
        Write-Warn "Connection string not found in response. Check the resource in Azure Portal."
    }
    # -- Deploy Azure Monitor Workbook via Bicep --------------------------------

    Write-Step "Deploying Azure Monitor Workbook"
    $bicepPath = Join-Path (Join-Path (Join-Path $PSScriptRoot "..") "otel") "workbook.bicep"
    if (Test-Path $bicepPath) {
        $wbResult = Invoke-AzSafe @(
            'deployment', 'group', 'create',
            '--resource-group', $ResourceGroup,
            '--template-file', $bicepPath,
            '--parameters', "appInsightsName=$AppInsightsName",
            '--parameters', "workbookDisplayName=MCP Azure Storage - $AppInsightsName",
            '--parameters', "location=$Location",
            '--query', 'properties.outputs',
            '--output', 'json'
        )
        if ($wbResult) {
            $wbOutputs = $wbResult | ConvertFrom-Json
            Write-Ok "Workbook deployed"
            if ($wbOutputs.portalUrl.value) {
                Write-Host ""
                Write-Host "  Open in Portal: $($wbOutputs.portalUrl.value)" -ForegroundColor Yellow
                Write-Host ""
            }
        } else {
            Write-Warn "Workbook deployment failed."
            Write-Host "   Manual import: Portal > App Insights > Workbooks > New > Advanced Editor > paste otel/workbook.json" -ForegroundColor DarkGray
        }
    } else {
        Write-Skip "Workbook Bicep template not found at $bicepPath"
    }
}

# -- Verification queries -------------------------------------------------------

Write-Step "Running verification queries against '$AppInsightsName'"

# Get the App Insights app ID for querying
$appiShowJson = Invoke-AzSafe @(
    'monitor', 'app-insights', 'component', 'show',
    '--app', $AppInsightsName,
    '--resource-group', $ResourceGroup,
    '--output', 'json'
)
if (-not $appiShowJson) {
    Write-Warn "Cannot find App Insights resource '$AppInsightsName' for verification."
    exit 1
}
$appiShow = $appiShowJson | ConvertFrom-Json
$appId = $appiShow.appId

if (-not $appId) {
    Write-Warn "App Insights appId not found. Queries require the appId."
    exit 1
}

Write-Ok "App Insights appId: $appId"

# Define verification queries
$queries = @(
    @{ Name = "Requests by cloud role";    Query = "requests | summarize count() by cloud_RoleName | order by count_ desc" }
    @{ Name = "Dependencies by name";      Query = "dependencies | summarize count() by name | order by count_ desc" }
    @{ Name = "Custom metrics by name";    Query = "customMetrics | summarize count() by name | order by count_ desc" }
    @{ Name = "Traces by severity level";  Query = "traces | summarize count() by severityLevel | order by severityLevel asc" }
    @{ Name = "Exceptions total";          Query = "exceptions | summarize totalExceptions=count()" }
)

$anyData = $false

foreach ($q in $queries) {
    Write-Host ""
    Write-Host "  Query: $($q.Name)" -ForegroundColor White

    $queryResult = Invoke-AzSafe @(
        'monitor', 'app-insights', 'query',
        '--app', $appId,
        '--analytics-query', $q.Query,
        '--output', 'json'
    )

    if ($queryResult) {
        $parsed = $queryResult | ConvertFrom-Json
        if ($parsed.tables -and $parsed.tables[0].rows.Count -gt 0) {
            $anyData = $true
            $cols = $parsed.tables[0].columns | ForEach-Object { $_.name }
            Write-Host "  Columns: $($cols -join ', ')" -ForegroundColor DarkGray
            foreach ($row in $parsed.tables[0].rows) {
                Write-Host "    $($row -join '  |  ')" -ForegroundColor Green
            }
        } else {
            Write-Host "    (no data)" -ForegroundColor DarkGray
        }
    } else {
        Write-Host "    (query failed)" -ForegroundColor DarkGray
    }
}

# -- Summary --------------------------------------------------------------------

Write-Host ""
Write-Host "====================================================" -ForegroundColor Cyan
if ($anyData) {
    Write-Host "  Telemetry is flowing! Verification complete." -ForegroundColor Green
} else {
    Write-Host "  No telemetry data found yet." -ForegroundColor Yellow
    Write-Host "  This is normal if:" -ForegroundColor Yellow
    Write-Host "    - The app was just deployed (allow 2-5 minutes)" -ForegroundColor Yellow
    Write-Host "    - No requests have been made to the MCP server" -ForegroundColor Yellow
    Write-Host "    - OTel is not enabled on the Container App" -ForegroundColor Yellow
}
Write-Host "====================================================" -ForegroundColor Cyan
