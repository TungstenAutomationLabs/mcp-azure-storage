<#
.SYNOPSIS
    Build, scan, and push the mcp-azure-storage Docker image to Azure Container Registry.

.PARAMETER Tag
    Image tag (default: latest)

.PARAMETER SkipBuild
    Skip Docker build (reuse existing local image)

.PARAMETER SkipScan
    Skip Trivy vulnerability scan

.EXAMPLE
    .\scripts\push-to-acr.ps1
    .\scripts\push-to-acr.ps1 -Tag v1.0.0
    .\scripts\push-to-acr.ps1 -SkipScan
#>
param(
    [string]$Tag = "latest",
    [switch]$SkipBuild,
    [switch]$SkipScan
)

$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot/..

try {
    # Load helpers
    . ./scripts/helpers/common.ps1

    Write-Info "=== MCP Azure Storage — ACR Push ==="

    # Load .env and read ACR_NAME
    Load-EnvFile ".env"
    $AcrName = Get-EnvVar "ACR_NAME"
    if (-not $AcrName) {
        Write-Err "ACR_NAME not set in .env file"
        exit 1
    }
    $AcrServer = "$AcrName.azurecr.io"
    $ImageName = "mcp-azure-storage"
    $FullTag = "$AcrServer/${ImageName}:${Tag}"

    # Check prerequisites
    $tools = @("az", "docker")
    if (-not $SkipScan) { $tools += "trivy" }
    Test-Prerequisites -Tools $tools

    # Login to ACR
    Write-Info "Logging into ACR: $AcrName"
    Invoke-Az "acr login --name $AcrName"

    # Build
    if (-not $SkipBuild) {
        Write-Info "Building image: $FullTag"
        docker build --target production -t $FullTag -f Dockerfile .
        if ($LASTEXITCODE -ne 0) {
            Write-Err "Docker build failed"
            exit 1
        }
        Write-Success "Image built: $FullTag"
    } else {
        Write-Warn "Skipping build (reusing existing image)"
    }

    # Scan with Trivy
    if (-not $SkipScan) {
        Write-Info "Scanning image with Trivy..."
        trivy image --severity CRITICAL --exit-code 1 $FullTag
        if ($LASTEXITCODE -ne 0) {
            Write-Err "Trivy found CRITICAL vulnerabilities. Fix them before pushing."
            exit 1
        }
        Write-Success "Trivy scan passed (no CRITICAL vulnerabilities)"
    } else {
        Write-Warn "Skipping Trivy scan"
    }

    # Push
    Write-Info "Pushing image: $FullTag"
    docker push $FullTag
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Docker push failed"
        exit 1
    }
    Write-Success "Image pushed: $FullTag"

    # Summary
    Write-Host ""
    Write-Success "=== Push Complete ==="
    Write-Info "Image: $FullTag"
    Write-Info "Registry: $AcrServer"
}
finally {
    Pop-Location
}
