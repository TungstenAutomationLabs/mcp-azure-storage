<#
.SYNOPSIS
    Reads .env variables and deploys the MCP Azure Storage server via Azure Developer CLI.

.DESCRIPTION
    This script:
      1. Parses the .env file in the project root (skipping comments and blank lines)
      2. Syncs Azure deployment configuration (AZURE_ENV_NAME, AZURE_SUBSCRIPTION_ID,
         AZURE_LOCATION, AZURE_RESOURCE_GROUP) to azd if present in .env
      3. Syncs key variables (AZURE_STORAGE_ACCOUNT_NAME, AZURE_STORAGE_ACCOUNT_KEY,
         MCP_API_KEY) into the active azd environment using `azd env set`
      4. Optionally enables infrastructure features (lifecycle policy, OTel monitoring)
      5. Runs `azd up` to provision infrastructure and deploy the container

    This means you only need to maintain ONE .env file for both local dev and
    Azure deployment. No need to remember separate `azd env set` commands.

.PARAMETER EnvFile
    Path to the .env file. Defaults to ".env" in the script's directory.

.PARAMETER SkipProvision
    If set, runs `azd deploy` instead of `azd up` (skips infrastructure provisioning).
    Use this when you've only changed code, not infrastructure or env vars.

.PARAMETER LifecyclePolicy
    Controls automatic blob access-tier transitions on new storage accounts.
    Has no effect when using BYOSA (bring-your-own storage). Values:

      none     (default) No lifecycle rules. All blobs stay in Hot tier.
      one-way  Blobs move to Cold after 15 days, Archive after 90 days.
               Archived blobs must be manually rehydrated to read.
      smart    Blobs move to Cool after 30 days of inactivity, then
               automatically return to Hot when accessed. Does not use
               Archive tier. Enables access-time tracking on the account.

.PARAMETER EnableOTel
    When set, forces OTel monitoring ON regardless of .env. If omitted, the
    script reads ENABLE_OTEL from .env instead (true / false). When neither
    the switch nor .env sets a value, OTel defaults to disabled.

    Provisioning OTel deploys an OTel Collector sidecar container alongside
    the MCP server. The collector exports traces, metrics and logs to App
    Insights via the azure_monitor exporter.

    If ACR already exists (re-deployment), the collector image is built and
    pushed before azd up. On a first-time deploy, the script automatically
    splits azd up into azd provision (creates ACR) -> build/push collector
    image -> azd deploy.

.PARAMETER LogRetentionDays
    Log Analytics / Application Insights data retention in days. Applies to
    both Container Apps system logs and App Insights telemetry. Range: 30-730.
    Default: 30 days. Longer retention costs more.

.EXAMPLE
    .\deploy_to_azure.ps1
    # Full provision + deploy using .env values

.EXAMPLE
    .\deploy_to_azure.ps1 -SkipProvision
    # Code-only redeploy (faster, skips Bicep provisioning)

.EXAMPLE
    .\deploy_to_azure.ps1 -EnvFile ".env.production"
    # Use a different env file

.EXAMPLE
    .\deploy_to_azure.ps1 -LifecyclePolicy one-way
    # Provision with one-way tiering (Cold after 15d, Archive after 90d)

.EXAMPLE
    .\deploy_to_azure.ps1 -LifecyclePolicy smart
    # Provision with smart tiering (Cool after 30d inactivity, auto-reheat)

.EXAMPLE
    .\deploy_to_azure.ps1 -EnableOTel
    # Provision with OTel monitoring (App Insights + collector sidecar)

.EXAMPLE
    .\deploy_to_azure.ps1 -EnableOTel -LogRetentionDays 90
    # OTel monitoring with 90-day log retention
#>

[CmdletBinding()]
param(
    [string]$EnvFile = "",
    [switch]$SkipProvision,
    [ValidateSet("none", "one-way", "smart")]
    [string]$LifecyclePolicy = "none",
    [switch]$EnableOTel,
    [ValidateRange(30, 730)]
    [int]$LogRetentionDays = 30
)

# Resolve EnvFile default -- $PSScriptRoot can be empty when invoked via -File
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

# -- Helper: Build and push OTel Collector sidecar image to ACR --
# Extracted into a function so it can be called either pre-deploy (when ACR
# already exists from a previous provision) or post-provision (first deploy).
function Build-And-PushOtelCollector {
    # Verify docker is available
    $dockerPath = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $dockerPath) {
        Write-Error "Docker is required to build the OTel Collector image but is not installed or not in PATH."
        exit 1
    }

    # Get ACR login server from azd env
    # NOTE: azd env get-value writes errors to stdout (not stderr), so
    # 2>$null alone is insufficient. We must also check $LASTEXITCODE.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $acrLoginServer = azd env get-value AZURE_CONTAINER_REGISTRY_ENDPOINT 2>$null
    $acrLookupExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP
    if ($acrLookupExit -ne 0 -or -not $acrLoginServer -or $acrLoginServer.ToString().StartsWith("ERROR:")) {
        Write-Error "ACR endpoint not found in azd environment. Cannot build OTel Collector image."
        exit 1
    }
    Write-Ok "ACR endpoint: $acrLoginServer"

    # Login to ACR -- extract registry name from login server FQDN
    $acrName = $acrLoginServer -replace '\.azurecr\.io$', ''
    Write-Ok "Logging into ACR: $acrName"

    # Use error-safe invocation for az acr login
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $acrLoginOutput = az acr login --name $acrName 2>&1
    $acrLoginExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP
    if ($acrLoginExit -ne 0) {
        Write-Warn "az acr login failed (exit code $acrLoginExit). Ensure you are logged into Azure CLI (az login)."
        Write-Host "   Output: $acrLoginOutput" -ForegroundColor DarkGray
        exit 1
    }
    Write-Ok "ACR login successful"

    # Build and push the collector image
    $collectorImage = "$acrLoginServer/otel-collector:latest"
    Write-Ok "Building collector image: $collectorImage"

    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    docker build -t $collectorImage ./otel 2>&1 | ForEach-Object { Write-Host "   $_" -ForegroundColor DarkGray }
    $buildExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP
    if ($buildExit -ne 0) {
        Write-Error "Docker build failed for OTel Collector image (exit code $buildExit)."
        exit 1
    }
    Write-Ok "Collector image built"

    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    docker push $collectorImage 2>&1 | ForEach-Object { Write-Host "   $_" -ForegroundColor DarkGray }
    $pushExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP
    if ($pushExit -ne 0) {
        Write-Error "Docker push failed for OTel Collector image (exit code $pushExit)."
        exit 1
    }
    Write-Ok "Collector image pushed to ACR"

    azd env set OTEL_COLLECTOR_IMAGE $collectorImage --no-prompt 2>$null
    return $collectorImage
}

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
        $rawValue = $Matches[2]
        # Handle quoted values (preserve content inside quotes, including # characters)
        if ($rawValue -match '^"(.*)"') {
            $value = $Matches[1]
        } elseif ($rawValue -match "^'(.*)'") {
            $value = $Matches[1]
        } else {
            # Unquoted: strip inline comments (space + hash) and trailing whitespace
            $value = ($rawValue -replace '\s+#.*$', '').Trim()
        }
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

# -- 3. Sync Azure deployment configuration from .env --
# If AZURE_ENV_NAME is set, ensure the azd environment exists and is selected
# BEFORE we query the active environment. This lets a single .env file drive
# the entire deployment without any manual `azd env new` / `azd env set` steps.

if ($envVars.ContainsKey("AZURE_ENV_NAME") -and -not [string]::IsNullOrEmpty($envVars["AZURE_ENV_NAME"])) {
    Write-Step "Syncing Azure deployment configuration from .env"

    $targetEnvName = $envVars["AZURE_ENV_NAME"]
    Write-Skip "Listing azd environments..."
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $envListJson = azd env list --output json --no-prompt 2>&1
    $ErrorActionPreference = $prevEAP
    # Separate stdout from stderr (azd may emit warnings)
    $envListStdout = @($envListJson | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
    $existingEnvs = @()
    if ($envListStdout) {
        try {
            # ForEach-Object { $_ } forces PS 5.1 to enumerate JSON array items
            # individually instead of passing the whole array as one pipeline object.
            $existingEnvs = @(($envListStdout | ConvertFrom-Json) | ForEach-Object { $_ })
        } catch {
            Write-Warn "Could not parse azd env list output: $envListStdout"
        }
    }
    $envExists = $existingEnvs | Where-Object { $_.Name -eq $targetEnvName } | Select-Object -First 1

    if ($envExists) {
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $selectOutput = azd env select $targetEnvName --no-prompt 2>&1
        $selectExit = $LASTEXITCODE
        $ErrorActionPreference = $prevEAP
        if ($selectExit -ne 0) {
            $selectErr = @($selectOutput | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] }) -join "`n"
            Write-Host "   [FAIL] Could not select azd environment '$targetEnvName': $selectErr" -ForegroundColor Red
            exit 1
        }
        Write-Ok "AZURE_ENV_NAME = $targetEnvName (selected existing environment)"
    } else {
        Write-Skip "Creating new azd environment: $targetEnvName"
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $newOutput = azd env new $targetEnvName --no-prompt 2>&1
        $newExit = $LASTEXITCODE
        $ErrorActionPreference = $prevEAP
        if ($newExit -ne 0) {
            $newErr = @($newOutput | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] }) -join "`n"
            Write-Host "   [FAIL] Could not create azd environment '$targetEnvName': $newErr" -ForegroundColor Red
            exit 1
        }
        Write-Ok "AZURE_ENV_NAME = $targetEnvName (created new environment)"
    }

    # Sync remaining deployment variables to azd env
    $azdDeployKeys = @("AZURE_SUBSCRIPTION_ID", "AZURE_LOCATION", "AZURE_RESOURCE_GROUP")
    foreach ($key in $azdDeployKeys) {
        if ($envVars.ContainsKey($key) -and -not [string]::IsNullOrEmpty($envVars[$key])) {
            $prevEAP = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            azd env set $key $envVars[$key] --no-prompt 2>&1 | Out-Null
            $ErrorActionPreference = $prevEAP
            if ($LASTEXITCODE -ne 0) {
                Write-Host "   [FAIL] Could not set $key in azd environment" -ForegroundColor Red
                exit 1
            }
            Write-Ok "$key = $($envVars[$key])"
        } else {
            Write-Skip "$key not set in .env (will use azd default)"
        }
    }
} elseif (
    ($envVars.ContainsKey("AZURE_SUBSCRIPTION_ID") -and -not [string]::IsNullOrEmpty($envVars["AZURE_SUBSCRIPTION_ID"])) -or
    ($envVars.ContainsKey("AZURE_LOCATION") -and -not [string]::IsNullOrEmpty($envVars["AZURE_LOCATION"])) -or
    ($envVars.ContainsKey("AZURE_RESOURCE_GROUP") -and -not [string]::IsNullOrEmpty($envVars["AZURE_RESOURCE_GROUP"]))
) {
    # AZURE_ENV_NAME not set, but other deployment vars are -- sync them to the
    # currently active azd environment.
    Write-Step "Syncing Azure deployment variables from .env (using active azd environment)"

    $azdDeployKeys = @("AZURE_SUBSCRIPTION_ID", "AZURE_LOCATION", "AZURE_RESOURCE_GROUP")
    foreach ($key in $azdDeployKeys) {
        if ($envVars.ContainsKey($key) -and -not [string]::IsNullOrEmpty($envVars[$key])) {
            $prevEAP = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            azd env set $key $envVars[$key] --no-prompt 2>&1 | Out-Null
            $ErrorActionPreference = $prevEAP
            if ($LASTEXITCODE -ne 0) {
                Write-Host "   [FAIL] Could not set $key in azd environment" -ForegroundColor Red
                exit 1
            }
            Write-Ok "$key = $($envVars[$key])"
        } else {
            Write-Skip "$key not set in .env (will use azd default)"
        }
    }
}

# -- 4. Show current azd environment --
Write-Step "Current azd environment"
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$currentEnvJson = azd env list --output json --no-prompt 2>&1
$ErrorActionPreference = $prevEAP
$currentEnvStdout = @($currentEnvJson | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
$currentEnv = $null
if ($currentEnvStdout) {
    try {
        # ForEach-Object { $_ } forces PS 5.1 to enumerate JSON array items
        # individually instead of passing the whole array as one pipeline object.
        $allEnvs = @(($currentEnvStdout | ConvertFrom-Json) | ForEach-Object { $_ })
        Write-Host "   [debug] azd env list returned $($allEnvs.Count) environment(s)" -ForegroundColor DarkGray
        $defaultEnvs = @($allEnvs | Where-Object { $_.IsDefault -eq $true })
        if ($defaultEnvs.Count -gt 1) {
            Write-Warn "Multiple default environments detected ($($defaultEnvs.Count)). Using the first one."
            $defaultEnvs | ForEach-Object { Write-Host "   [debug]   - $($_.Name) (IsDefault=$($_.IsDefault))" -ForegroundColor DarkGray }
        }
        $currentEnv = $defaultEnvs | Select-Object -First 1
    } catch {
        Write-Warn "Could not parse azd env list output"
    }
}
# Extract environment name as a guaranteed [string] scalar.
# $currentEnv.Name can resolve to Object[] when PS 5.1 wraps ConvertFrom-Json
# output in a nested array. Casting to [string] prevents System.Object[] errors
# in Join-Path, string interpolation, and azd commands downstream.
[string]$envName = if ($currentEnv) { [string]$currentEnv.Name } else { "" }
if ($envName) {
    Write-Ok "Active environment: $envName"
    Write-Host "   [debug] envName type: $($envName.GetType().FullName)" -ForegroundColor DarkGray
} else {
    Write-Warn "No default azd environment found. Run 'azd init' first."
    exit 1
}

# -- 5. Sync application variables to azd environment --
Write-Step "Syncing .env application variables to azd environment '$envName'"

# Variables to sync from .env -> azd env
$syncKeys = @(
    "AZURE_STORAGE_ACCOUNT_NAME",
    "AZURE_STORAGE_ACCOUNT_KEY",
    "MCP_API_KEY",
    "DISABLED_TOOLS"
)

# Resolve the azd env file path so we can clear stale values directly.
# azd env set does not support setting empty values, so we edit the file.
$azdEnvFilePath = ""
if ($currentEnv) {
    $azdEnvFilePath = Join-Path $PSScriptRoot (Join-Path ".azure" (Join-Path $envName ".env"))
    if (-not (Test-Path $azdEnvFilePath)) {
        # Try without script root (run from project root)
        $azdEnvFilePath = Join-Path ".azure" (Join-Path $envName ".env")
    }
}

foreach ($key in $syncKeys) {
    if ($envVars.ContainsKey($key) -and -not [string]::IsNullOrEmpty($envVars[$key])) {
        # Mask sensitive values in output
        if ($key -match "KEY|SECRET") {
            $displayValue = $envVars[$key].Substring(0, [Math]::Min(6, $envVars[$key].Length)) + "..."
        } else {
            $displayValue = $envVars[$key]
        }
        azd env set $key $envVars[$key] --no-prompt 2>$null
        Write-Ok "$key = $displayValue"
    } else {
        # Explicitly clear stale values by editing the azd env file directly.
        # azd env set does not support empty values (errors with "invalid key=value").
        if ($azdEnvFilePath -and (Test-Path $azdEnvFilePath)) {
            $envFileContent = Get-Content $azdEnvFilePath
            $filtered = @($envFileContent | Where-Object { $_ -notmatch "^\s*$key\s*=" })
            # Write BOM-free UTF-8 (PS5's -Encoding UTF8 adds a BOM which azd rejects)
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            [System.IO.File]::WriteAllLines((Resolve-Path $azdEnvFilePath).Path, $filtered, $utf8NoBom)
        }
        Write-Skip "$key not set in .env (cleared stale value)"
    }
}

# -- 5b. Set optional infrastructure flags --
azd env set LIFECYCLE_POLICY_MODE $LifecyclePolicy --no-prompt 2>$null
switch ($LifecyclePolicy) {
    "none"    { Write-Skip "Lifecycle policy: none (all blobs stay Hot)" }
    "one-way" { Write-Ok   "Lifecycle policy: one-way (Cold after 15d, Archive after 90d)" }
    "smart"   { Write-Ok   "Lifecycle policy: smart (Cool after 30d inactivity, auto-reheat on access)" }
}

# -- 5c. Set log retention --
azd env set LOG_RETENTION_DAYS $LogRetentionDays.ToString() --no-prompt 2>$null
if ($LogRetentionDays -ne 30) {
    Write-Ok "Log retention: $LogRetentionDays days"
} else {
    Write-Skip "Log retention: 30 days (default)"
}

# -- 5d. OTel monitoring configuration --
# Resolve enablement: -EnableOTel switch overrides, then .env, then default off.
# This avoids the footgun where omitting -EnableOTel on a code-only redeploy
# silently disables a previously-enabled OTel deployment.
$resolvedEnableOtel = $false
$otelSource = "default"

if ($EnableOTel) {
    $resolvedEnableOtel = $true
    $otelSource = "switch (-EnableOTel)"
} elseif ($envVars.ContainsKey("ENABLE_OTEL") -and $envVars["ENABLE_OTEL"] -eq "true") {
    $resolvedEnableOtel = $true
    $otelSource = ".env (ENABLE_OTEL=true)"
}

# Track whether the OTel collector build must be deferred until after provisioning.
# AZURE_CONTAINER_REGISTRY_ENDPOINT is a Bicep output -- it only exists in the
# azd environment after a successful `azd provision` (or `azd up`). On a first-time
# deploy (or after `azd down --purge`), the key does not exist yet and the build
# must wait until after provisioning creates the ACR.
$otelBuildDeferred = $false

if ($resolvedEnableOtel) {
    # Verify docker is available early -- fail fast before any provisioning
    $dockerPath = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $dockerPath) {
        Write-Error "Docker is required to build the OTel Collector image but is not installed or not in PATH."
        exit 1
    }

    azd env set ENABLE_OTEL 'true' --no-prompt 2>$null

    # Check whether ACR endpoint already exists (re-deployment / previous provision)
    # NOTE: azd env get-value writes errors to stdout (not stderr), so
    # 2>$null alone is insufficient. We must also check $LASTEXITCODE.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $existingAcrEndpoint = azd env get-value AZURE_CONTAINER_REGISTRY_ENDPOINT 2>$null
    $acrLookupExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP
    if ($acrLookupExit -eq 0 -and $existingAcrEndpoint -and -not $existingAcrEndpoint.ToString().StartsWith("ERROR:")) {
        Write-Step "Building OTel Collector sidecar image (ACR already provisioned)"
        $collectorImage = Build-And-PushOtelCollector
        Write-Ok "OTel monitoring: ENABLED via $otelSource (collector image pushed to ACR)"
    } else {
        # ACR does not exist yet -- defer build until after azd provision
        $otelBuildDeferred = $true
        Write-Step "OTel Collector sidecar build deferred"
        Write-Warn "AZURE_CONTAINER_REGISTRY_ENDPOINT not found in azd environment."
        Write-Ok "The collector image will be built after 'azd provision' creates the ACR."
        Write-Ok "OTel monitoring: ENABLED via $otelSource (build deferred to post-provision)"
    }
} else {
    # Only write 'false' to azd env if ENABLE_OTEL was explicitly mentioned in
    # .env (set to a non-true value like 'false' or empty). When .env omits the
    # key entirely, leave the existing azd env value untouched so a previous
    # -EnableOTel deployment is not silently reverted on code-only redeploys.
    if ($envVars.ContainsKey("ENABLE_OTEL")) {
        azd env set ENABLE_OTEL 'false' --no-prompt 2>$null
        Write-Skip "OTel monitoring: disabled (ENABLE_OTEL=$($envVars['ENABLE_OTEL']) in .env)"
    } else {
        Write-Skip "OTel monitoring: unchanged (not set in .env or switch)"
    }
}

# -- 5e. OTel telemetry level and log severity --
# Read from .env or default to 'detailed' / '9' (INFO).
$otelTelemetryLevel = if ($envVars.ContainsKey("OTEL_TELEMETRY_LEVEL") -and -not [string]::IsNullOrEmpty($envVars["OTEL_TELEMETRY_LEVEL"])) {
    $envVars["OTEL_TELEMETRY_LEVEL"]
} else {
    'detailed'
}
azd env set OTEL_TELEMETRY_LEVEL $otelTelemetryLevel --no-prompt 2>$null
Write-Ok "OTel telemetry level: $otelTelemetryLevel"

$otelLogMinSeverity = if ($envVars.ContainsKey("OTEL_LOG_MIN_SEVERITY") -and -not [string]::IsNullOrEmpty($envVars["OTEL_LOG_MIN_SEVERITY"])) {
    $envVars["OTEL_LOG_MIN_SEVERITY"]
} else {
    '9'
}
azd env set OTEL_LOG_MIN_SEVERITY $otelLogMinSeverity --no-prompt 2>$null
Write-Ok "OTel log min severity: $otelLogMinSeverity"

$otelScrubPii = if ($envVars.ContainsKey("OTEL_SCRUB_PII") -and -not [string]::IsNullOrEmpty($envVars["OTEL_SCRUB_PII"])) {
    $envVars["OTEL_SCRUB_PII"]
} else {
    'true'
}
azd env set OTEL_SCRUB_PII $otelScrubPii --no-prompt 2>$null
Write-Ok "OTel PII scrubbing: $otelScrubPii"

# -- 6. Show summary before deploying --
Write-Step "Deployment summary"
Write-Host "  Environment:     $envName" -ForegroundColor White
if ($envVars.ContainsKey("AZURE_LOCATION") -and -not [string]::IsNullOrEmpty($envVars["AZURE_LOCATION"])) {
    Write-Host "  Location:        $($envVars['AZURE_LOCATION'])" -ForegroundColor White
}
if ($envVars.ContainsKey("AZURE_RESOURCE_GROUP") -and -not [string]::IsNullOrEmpty($envVars["AZURE_RESOURCE_GROUP"])) {
    Write-Host "  Resource Group:  $($envVars['AZURE_RESOURCE_GROUP']) (override)" -ForegroundColor White
}
if ($envVars.ContainsKey("AZURE_STORAGE_ACCOUNT_NAME") -and -not [string]::IsNullOrEmpty($envVars["AZURE_STORAGE_ACCOUNT_NAME"])) {
    Write-Host "  Storage Account: $($envVars['AZURE_STORAGE_ACCOUNT_NAME']) (BYOSA - bring your own)" -ForegroundColor White
} else {
    Write-Host "  Storage Account: (auto-provisioned by Bicep)" -ForegroundColor White
}
if ($SkipProvision) {
    Write-Host "  Mode:            Deploy only (azd deploy)" -ForegroundColor White
} elseif ($otelBuildDeferred) {
    Write-Host "  Mode:            Provision -> OTel build -> Deploy (split for first-time ACR)" -ForegroundColor White
} else {
    Write-Host "  Mode:            Full provision + deploy (azd up)" -ForegroundColor White
}
switch ($LifecyclePolicy) {
    "none"    { Write-Host "  Lifecycle Policy: None (all blobs stay Hot)"                               -ForegroundColor DarkGray }
    "one-way" { Write-Host "  Lifecycle Policy: One-way (Cold after 15d, Archive after 90d)"             -ForegroundColor White }
    "smart"   { Write-Host "  Lifecycle Policy: Smart (Cool after 30d inactivity, auto-reheat on access)" -ForegroundColor White }
}
if ($resolvedEnableOtel) {
    Write-Host "  OTel Monitoring:  Enabled via $otelSource (collector sidecar + App Insights)" -ForegroundColor White
} else {
    Write-Host "  OTel Monitoring:  Disabled" -ForegroundColor DarkGray
}
Write-Host "  Log Retention:   $LogRetentionDays days" -ForegroundColor White
Write-Host "  OTel Level:      $otelTelemetryLevel" -ForegroundColor White
Write-Host "  OTel Log Filter: severity >= $otelLogMinSeverity" -ForegroundColor White

# -- 7. Confirm --
Write-Host ""
$confirm = Read-Host "Proceed with deployment? (y/N)"
if ($confirm -notin @('y', 'Y', 'yes', 'Yes')) {
    Write-Warn "Deployment cancelled."
    exit 0
}

# -- 8. Deploy --
if ($SkipProvision) {
    Write-Step "Running azd deploy (code only, no infrastructure changes)"
    azd deploy
} elseif ($otelBuildDeferred) {
    # OTel is enabled but ACR does not exist yet. Split azd up into three phases:
    #   1. azd provision -- creates infrastructure including ACR (Container App
    #      launches WITHOUT the OTel sidecar because OTEL_COLLECTOR_IMAGE is empty)
    #   2. Build & push OTel collector image to the new ACR
    #   3. azd provision -- re-provisions with OTEL_COLLECTOR_IMAGE now set, so
    #      the Bicep template adds the sidecar container to the Container App
    #   4. azd deploy    -- pushes the MCP server application image
    Write-Step "Running azd provision (infrastructure only -- ACR needed for OTel collector)"
    azd provision
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "====================================================" -ForegroundColor Red
        Write-Host "  Provisioning failed! Check the output above." -ForegroundColor Red
        Write-Host "====================================================" -ForegroundColor Red
        exit 1
    }
    Write-Ok "Infrastructure provisioned successfully"

    # Now AZURE_CONTAINER_REGISTRY_ENDPOINT should be populated by Bicep outputs
    Write-Step "Building OTel Collector sidecar image (post-provision)"
    $collectorImage = Build-And-PushOtelCollector
    Write-Ok "OTel collector image ready: $collectorImage"

    # Re-provision so the Bicep template picks up OTEL_COLLECTOR_IMAGE and adds
    # the sidecar container to the Container App definition. azd deploy alone
    # only updates the application image -- it does not re-run the Bicep template,
    # so the sidecar would never be added without this second provision step.
    Write-Step "Running azd provision (adding OTel sidecar to Container App)"
    azd provision
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "====================================================" -ForegroundColor Red
        Write-Host "  Re-provisioning with OTel sidecar failed!" -ForegroundColor Red
        Write-Host "====================================================" -ForegroundColor Red
        exit 1
    }
    Write-Ok "Container App updated with OTel sidecar"

    Write-Step "Running azd deploy (deploying MCP server application image)"
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

    # Show App Insights connection string when OTel is enabled
    if ($resolvedEnableOtel) {
        $appiConnStr = azd env get-value appInsightsConnectionString 2>$null
        if ($appiConnStr) {
            $truncLen = [Math]::Min(40, $appiConnStr.Length)
            Write-Host "  App Insights: $($appiConnStr.Substring(0, $truncLen))..." -ForegroundColor Yellow
        }
        $appiName = azd env get-value appInsightsName 2>$null
        if ($appiName) {
            Write-Host "  App Insights Resource: $appiName" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host ""
    Write-Host "====================================================" -ForegroundColor Red
    Write-Host "  Deployment failed! Check the output above for errors." -ForegroundColor Red
    Write-Host "====================================================" -ForegroundColor Red
    exit 1
}
