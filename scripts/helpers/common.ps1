# =============================================================================
# Shared PowerShell utilities for MCP Azure Storage scripts.
# Dot-source this file at the top of any script:  . ./scripts/helpers/common.ps1
# =============================================================================

# ── Colour output helpers ────────────────────────────────────────────────────
function Write-Info($msg)    { Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Write-Success($msg) { Write-Host "[OK]   $msg" -ForegroundColor Green }
function Write-Warn($msg)    { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg)     { Write-Host "[ERR]  $msg" -ForegroundColor Red }

# ── .env file loader ─────────────────────────────────────────────────────────
# Reads KEY=VALUE pairs into a script-scoped hashtable.
$script:EnvVars = @{}

function Load-EnvFile {
    param([string]$Path = ".env")
    if (-not (Test-Path $Path)) {
        Write-Warn "No .env file found at $Path"
        return
    }
    $script:EnvVars = @{}
    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#')) {
            $parts = $line -split '=', 2
            if ($parts.Count -eq 2) {
                $script:EnvVars[$parts[0].Trim()] = $parts[1].Trim()
            }
        }
    }
}

function Get-EnvVar {
    param([string]$Name, [string]$Default = "")
    if ($script:EnvVars.ContainsKey($Name)) { return $script:EnvVars[$Name] }
    return $Default
}

# ── Azure CLI wrapper ────────────────────────────────────────────────────────
# Handles stderr warnings gracefully so they don't trigger terminating errors.
function Invoke-Az {
    param([string]$Arguments, [switch]$Silent)
    $cmd = "az $Arguments"
    if (-not $Silent) { Write-Info "Running: $cmd" }
    $result = Invoke-Expression $cmd 2>&1
    $stderr = ($result | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] }) -join "`n"
    $stdout = ($result | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
    if ($LASTEXITCODE -ne 0 -and $stderr -notmatch "WARNING") {
        Write-Err "Azure CLI failed: $stderr"
        exit 1
    }
    return $stdout
}

# ── Prerequisites checker ────────────────────────────────────────────────────
function Test-Prerequisites {
    param([string[]]$Tools = @("az", "docker"))
    foreach ($tool in $Tools) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
            Write-Err "'$tool' is not installed or not in PATH"
            exit 1
        }
    }
    # Verify az login
    $account = az account show 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Not logged into Azure CLI. Run 'az login' first."
        exit 1
    }
    Write-Success "All prerequisites met"
}
