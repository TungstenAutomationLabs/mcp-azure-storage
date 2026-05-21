<#
.SYNOPSIS
    Create an Azure Container Registry for mcp-azure-storage.

.PARAMETER ResourceGroup
    Azure resource group name (required)

.PARAMETER Location
    Azure region (default: uksouth)

.PARAMETER Sku
    ACR SKU: Basic, Standard, or Premium (default: Basic)

.EXAMPLE
    .\scripts\setup-acr.ps1 -ResourceGroup rg-mcp-storage
#>
param(
    [Parameter(Mandatory)][string]$ResourceGroup,
    [string]$Location = "uksouth",
    [ValidateSet("Basic", "Standard", "Premium")][string]$Sku = "Basic"
)

$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot/..

try {
    . ./scripts/helpers/common.ps1

    Write-Info "=== MCP Azure Storage — ACR Setup ==="

    Load-EnvFile ".env"
    $AcrName = Get-EnvVar "ACR_NAME"
    if (-not $AcrName) {
        Write-Err "ACR_NAME not set in .env file"
        exit 1
    }

    Test-Prerequisites -Tools @("az")

    # Ensure resource group exists
    Write-Info "Ensuring resource group '$ResourceGroup' exists in '$Location'..."
    Invoke-Az "group create --name $ResourceGroup --location $Location --output none" -Silent

    # Create ACR
    Write-Info "Creating ACR '$AcrName' (SKU: $Sku)..."
    Invoke-Az "acr create --resource-group $ResourceGroup --name $AcrName --sku $Sku --admin-enabled false --output none"
    Write-Success "ACR '$AcrName' created successfully"

    $AcrServer = "$AcrName.azurecr.io"
    Write-Host ""
    Write-Success "=== Setup Complete ==="
    Write-Info "ACR: $AcrName"
    Write-Info "Server: $AcrServer"
    Write-Info "Next: Run .\scripts\push-to-acr.ps1 to build and push the image"
}
finally {
    Pop-Location
}
