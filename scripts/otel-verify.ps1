<#
.SYNOPSIS
    Exercises the deployed MCP Azure Storage service to generate OpenTelemetry
    telemetry data across all tool categories.

.DESCRIPTION
    This script makes MCP JSON-RPC 2.0 calls over Streamable HTTP transport to
    the deployed service, covering blob, queue, table, file share, and utility
    tools. It includes both success and deliberate error cases so that traces,
    metrics, and logs are generated for every code path.

    All test resources are cleaned up at the end. A pass/fail summary is printed.

    Intended as a permanent project utility for verifying OTel instrumentation
    after deployments or configuration changes.

.PARAMETER Endpoint
    Full URL to the MCP endpoint, e.g.
    https://myapp.azurecontainerapps.io/mcp
    If omitted, the script attempts to read SERVICE_MCP_ENDPOINT_URL from
    `azd env get-values`.

.PARAMETER ApiKey
    Bearer token for API authentication. If omitted, reads MCP_API_KEY from
    the .env file in the repository root.

.EXAMPLE
    .\scripts\otel-verify.ps1 -Endpoint https://myapp.azurecontainerapps.io/mcp -ApiKey secret

.EXAMPLE
    # Uses azd env for endpoint, .env for API key
    .\scripts\otel-verify.ps1

.NOTES
    Requires PowerShell 5.1+ and network access to the deployed service.
    No additional modules or dependencies are needed.
#>

param(
    [Parameter(Mandatory=$false)]
    [string]$Endpoint,

    [Parameter(Mandatory=$false)]
    [string]$ApiKey
)

$ErrorActionPreference = "Continue"

# ── Colour output helpers ────────────────────────────────────────────────────
function Write-Info($msg)    { Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Write-Success($msg) { Write-Host "[PASS] $msg" -ForegroundColor Green }
function Write-Warn($msg)    { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg)     { Write-Host "[FAIL] $msg" -ForegroundColor Red }

# ── .env loader ──────────────────────────────────────────────────────────────
function Read-DotEnv {
    param([string]$Path = ".env")
    $vars = @{}
    if (-not (Test-Path $Path)) { return $vars }
    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#')) {
            $parts = $line -split '=', 2
            if ($parts.Count -eq 2) {
                $vars[$parts[0].Trim()] = $parts[1].Trim()
            }
        }
    }
    return $vars
}

# ── Resolve parameters ───────────────────────────────────────────────────────
if (-not $ApiKey) {
    $envVars = Read-DotEnv
    if ($envVars.ContainsKey('MCP_API_KEY')) {
        $ApiKey = $envVars['MCP_API_KEY']
        Write-Info "Read MCP_API_KEY from .env"
    }
}

if (-not $Endpoint) {
    # Try azd env get-values
    try {
        $azdOutput = & azd env get-values 2>$null
        if ($azdOutput) {
            $azdOutput | ForEach-Object {
                if ($_ -match '^SERVICE_MCP_ENDPOINT_URL="?([^"]+)"?$') {
                    $Endpoint = $Matches[1]
                }
            }
        }
    } catch {
        # azd not available, ignore
    }

    if ($Endpoint) {
        # Ensure it ends with /mcp
        if (-not $Endpoint.EndsWith('/mcp')) {
            $Endpoint = $Endpoint.TrimEnd('/') + '/mcp'
        }
        Write-Info "Resolved endpoint from azd: $Endpoint"
    }
}

if (-not $Endpoint -or -not $ApiKey) {
    Write-Host ""
    Write-Err "Missing required configuration."
    if (-not $Endpoint) { Write-Err "  Endpoint: provide -Endpoint or set SERVICE_MCP_ENDPOINT_URL in azd env" }
    if (-not $ApiKey)   { Write-Err "  ApiKey: provide -ApiKey or set MCP_API_KEY in .env" }
    Write-Host ""
    exit 1
}

Write-Info "Endpoint: $Endpoint"
Write-Info "ApiKey:   $($ApiKey.Substring(0, [Math]::Min(4, $ApiKey.Length)))****"

# ── MCP call helper ──────────────────────────────────────────────────────────
$script:callId = 0
$script:results = @()

function Invoke-McpTool {
    <#
    .SYNOPSIS
        Sends a JSON-RPC 2.0 tools/call request and parses the SSE response.
    #>
    param(
        [string]$ToolName,
        [hashtable]$Arguments = @{},
        [string]$Label = "",
        [switch]$ExpectError
    )

    $script:callId++
    $id = $script:callId
    if (-not $Label) { $Label = $ToolName }

    $body = @{
        jsonrpc = "2.0"
        id      = $id
        method  = "tools/call"
        params  = @{
            name      = $ToolName
            arguments = $Arguments
        }
    } | ConvertTo-Json -Depth 10 -Compress

    $headers = @{
        "Authorization" = "Bearer $ApiKey"
        "Content-Type"  = "application/json"
        "Accept"        = "application/json, text/event-stream"
    }

    $result = @{
        Label   = $Label
        Tool    = $ToolName
        Status  = "unknown"
        Detail  = ""
    }

    try {
        $response = Invoke-WebRequest `
            -Uri $Endpoint `
            -Method POST `
            -Headers $headers `
            -Body $body `
            -UseBasicParsing `
            -TimeoutSec 30 `
            -ErrorAction Stop

        $contentType = $response.Headers["Content-Type"]
        $rawBody = $response.Content

        # Parse response -- may be SSE or direct JSON
        $jsonPayload = $null

        if ($contentType -and $contentType -like "*text/event-stream*") {
            # SSE format: extract data lines and find the JSON-RPC response
            $lines = $rawBody -split "`n"
            foreach ($line in $lines) {
                $trimmed = $line.Trim()
                if ($trimmed.StartsWith("data:")) {
                    $dataContent = $trimmed.Substring(5).Trim()
                    if ($dataContent -and $dataContent.StartsWith("{")) {
                        try {
                            $candidate = $dataContent | ConvertFrom-Json
                            if ($null -ne $candidate.id -or $null -ne $candidate.result -or $null -ne $candidate.error) {
                                $jsonPayload = $candidate
                            }
                        } catch {
                            # Not valid JSON, skip
                        }
                    }
                }
            }
        } else {
            # Direct JSON response
            try {
                $jsonPayload = $rawBody | ConvertFrom-Json
            } catch {
                # Could not parse
            }
        }

        if ($null -eq $jsonPayload) {
            $result.Status = "error"
            $result.Detail = "No JSON-RPC response found in SSE stream"
        } elseif ($null -ne $jsonPayload.error) {
            if ($ExpectError) {
                $result.Status = "pass"
                $result.Detail = "Expected error: $($jsonPayload.error.message)"
            } else {
                $result.Status = "fail"
                $result.Detail = "RPC error: $($jsonPayload.error.message)"
            }
        } elseif ($null -ne $jsonPayload.result) {
            # Check for isError in MCP tool result
            $isError = $false
            if ($null -ne $jsonPayload.result.isError) {
                $isError = $jsonPayload.result.isError
            }

            if ($isError -and -not $ExpectError) {
                # Extract error text from content array
                $errText = ""
                if ($jsonPayload.result.content) {
                    foreach ($c in $jsonPayload.result.content) {
                        if ($c.type -eq "text") { $errText = $c.text; break }
                    }
                }
                $result.Status = "fail"
                $result.Detail = "Tool error: $errText"
            } elseif ($isError -and $ExpectError) {
                $result.Status = "pass"
                $result.Detail = "Expected error received"
            } else {
                $result.Status = "pass"
                $result.Detail = "OK"
            }
        } else {
            $result.Status = "error"
            $result.Detail = "Unexpected response shape"
        }
    } catch {
        $errMsg = $_.Exception.Message

        # For HTTP errors, try to get the response body
        if ($_.Exception.Response) {
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                $reader = New-Object System.IO.StreamReader($stream)
                $errBody = $reader.ReadToEnd()
                $reader.Close()
                $stream.Close()
                $errMsg = "$errMsg -- $errBody"
            } catch {
                # Could not read error body
            }
        }

        if ($ExpectError) {
            $result.Status = "pass"
            $result.Detail = "Expected error: $errMsg"
        } else {
            $result.Status = "fail"
            $result.Detail = $errMsg
        }
    }

    # Print inline result
    switch ($result.Status) {
        "pass" { Write-Success "$($result.Label): $($result.Detail)" }
        "fail" { Write-Err     "$($result.Label): $($result.Detail)" }
        default { Write-Warn   "$($result.Label): $($result.Detail)" }
    }

    $script:results += $result
    return $result
}

# ── Test resource names ──────────────────────────────────────────────────────
$containerName = "otel-verify"
$blobName      = "test-blob.txt"
$queueName     = "otel-verify-queue"
$tableName     = "otelverify"

# ══════════════════════════════════════════════════════════════════════════════
# Test Execution
# ══════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "======================================================================" -ForegroundColor White
Write-Host " OTel Verification - MCP Azure Storage" -ForegroundColor White
Write-Host " $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss UTC' -AsUTC)" -ForegroundColor Gray
Write-Host "======================================================================" -ForegroundColor White
Write-Host ""

# ── 1. Discovery ─────────────────────────────────────────────────────────────
Write-Info "--- Utility ---"
Invoke-McpTool -ToolName "store-info" -Label "1. store-info (discovery)"

# ── 2-8. Blob operations ─────────────────────────────────────────────────────
Write-Host ""
Write-Info "--- Blob ---"

Invoke-McpTool -ToolName "blob-container-create" `
    -Arguments @{ containerName = $containerName } `
    -Label "2. blob-container-create"

Invoke-McpTool -ToolName "util-to-base64" `
    -Arguments @{ text = "Hello from otel-verify script!" } `
    -Label "   util-to-base64 (prep)"

# We need the base64 value -- use a known encoding
$testContentBase64 = [Convert]::ToBase64String(
    [System.Text.Encoding]::UTF8.GetBytes("Hello from otel-verify script!")
)

Invoke-McpTool -ToolName "blob-create" `
    -Arguments @{
        containerName = $containerName
        blobName      = $blobName
        contentBase64 = $testContentBase64
    } `
    -Label "3. blob-create"

Invoke-McpTool -ToolName "blob-list" `
    -Arguments @{ containerName = $containerName } `
    -Label "4. blob-list"

Invoke-McpTool -ToolName "blob-read" `
    -Arguments @{ containerName = $containerName; blobName = $blobName } `
    -Label "5. blob-read"

Invoke-McpTool -ToolName "blob-head" `
    -Arguments @{ containerName = $containerName; blobName = $blobName } `
    -Label "6. blob-head"

Invoke-McpTool -ToolName "blob-set-metadata" `
    -Arguments @{
        containerName = $containerName
        blobName      = $blobName
        metadata      = @{ source = "otel-verify"; verified = "true" }
    } `
    -Label "7. blob-set-metadata"

Invoke-McpTool -ToolName "blob-get-sas-url" `
    -Arguments @{ containerName = $containerName; blobName = $blobName } `
    -Label "8. blob-get-sas-url"

# ── 9-11. Queue operations ───────────────────────────────────────────────────
Write-Host ""
Write-Info "--- Queue ---"

Invoke-McpTool -ToolName "queue-create" `
    -Arguments @{ queueName = $queueName } `
    -Label "9. queue-create"

Invoke-McpTool -ToolName "queue-send-message" `
    -Arguments @{ queueName = $queueName; message = '{"source":"otel-verify","timestamp":"' + (Get-Date -Format o) + '"}' } `
    -Label "10. queue-send-message"

Invoke-McpTool -ToolName "queue-peek-messages" `
    -Arguments @{ queueName = $queueName; count = 5 } `
    -Label "11. queue-peek-messages"

# ── 12-14. Table operations ──────────────────────────────────────────────────
Write-Host ""
Write-Info "--- Table ---"

Invoke-McpTool -ToolName "table-create" `
    -Arguments @{ tableName = $tableName } `
    -Label "12. table-create"

Invoke-McpTool -ToolName "table-entity-upsert" `
    -Arguments @{
        tableName    = $tableName
        partitionKey = "otel-verify"
        rowKey       = "test-001"
        entity       = @{ source = "otel-verify"; score = 100; verified = $true }
    } `
    -Label "13. table-entity-upsert"

Invoke-McpTool -ToolName "table-entity-query" `
    -Arguments @{ tableName = $tableName; filter = "PartitionKey eq 'otel-verify'" } `
    -Label "14. table-entity-query"

# ── 15. Error case ───────────────────────────────────────────────────────────
Write-Host ""
Write-Info "--- Error Case ---"

Invoke-McpTool -ToolName "blob-read" `
    -Arguments @{ containerName = $containerName; blobName = "does-not-exist.txt" } `
    -Label "15. blob-read (non-existent, expect error)" `
    -ExpectError

# ── 16-19. Cleanup ───────────────────────────────────────────────────────────
Write-Host ""
Write-Info "--- Cleanup ---"

Invoke-McpTool -ToolName "blob-delete" `
    -Arguments @{ containerName = $containerName; blobName = $blobName } `
    -Label "16. blob-delete (cleanup)"

Invoke-McpTool -ToolName "blob-container-delete" `
    -Arguments @{ containerName = $containerName } `
    -Label "17. blob-container-delete (cleanup)"

Invoke-McpTool -ToolName "queue-delete" `
    -Arguments @{ queueName = $queueName } `
    -Label "18. queue-delete (cleanup)"

Invoke-McpTool -ToolName "table-delete" `
    -Arguments @{ tableName = $tableName } `
    -Label "19. table-delete (cleanup)"

# ══════════════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "======================================================================" -ForegroundColor White
Write-Host " Summary" -ForegroundColor White
Write-Host "======================================================================" -ForegroundColor White

$passCount = ($script:results | Where-Object { $_.Status -eq "pass" }).Count
$failCount = ($script:results | Where-Object { $_.Status -eq "fail" }).Count
$errorCount = ($script:results | Where-Object { $_.Status -eq "error" }).Count
$totalCount = $script:results.Count

Write-Host ""
Write-Host "  Total:   $totalCount" -ForegroundColor White
Write-Host "  Passed:  $passCount" -ForegroundColor Green
if ($failCount -gt 0) {
    Write-Host "  Failed:  $failCount" -ForegroundColor Red
} else {
    Write-Host "  Failed:  0" -ForegroundColor Green
}
if ($errorCount -gt 0) {
    Write-Host "  Errors:  $errorCount" -ForegroundColor Yellow
}

# List failures if any
if ($failCount -gt 0 -or $errorCount -gt 0) {
    Write-Host ""
    Write-Host "  Failures:" -ForegroundColor Red
    $script:results | Where-Object { $_.Status -ne "pass" } | ForEach-Object {
        Write-Host "    - $($_.Label): $($_.Detail)" -ForegroundColor Red
    }
}

Write-Host ""

if ($failCount -eq 0 -and $errorCount -eq 0) {
    Write-Host "All $totalCount tool calls completed successfully." -ForegroundColor Green
    Write-Host "Check your Application Insights / OTel collector for traces, metrics, and logs." -ForegroundColor Cyan
    exit 0
} else {
    Write-Host "$($failCount + $errorCount) of $totalCount tool calls had issues." -ForegroundColor Red
    exit 1
}
