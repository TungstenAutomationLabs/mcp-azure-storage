// =============================================================================
// MCP Azure Storage Server -- Infrastructure as Code (Bicep)
//
// Provisions all Azure resources needed to run the MCP server:
//   1. Log Analytics Workspace -- centralised logging for Container Apps
//   2. Azure Container Registry (ACR) -- stores the Docker image
//   3. User-Assigned Managed Identity -- shared identity for ACR pull + RBAC
//   4. RBAC Role Assignments -- AcrPull + Storage roles (before Container App)
//   5. Container Apps Environment -- managed Kubernetes hosting layer
//   6. Storage Account -- created OR referenced (bring-your-own)
//   7. Container App -- the running MCP server instance
//   8. Application Insights (optional) -- OTel telemetry sink
//
// Storage Account modes:
//   - Default: provisions a new Storage Account in the same Resource Group.
//   - Bring-your-own (BYOSA): set AZURE_STORAGE_ACCOUNT_NAME and
//     AZURE_STORAGE_ACCOUNT_KEY in your azd environment to connect to an
//     existing Storage Account (can be in any subscription/resource group).
//     No new Storage Account is created; RBAC roles are skipped (you supply
//     the key directly).
//
// Deployed via Azure Developer CLI:
//   azd up        -- provision infrastructure + build & deploy container
//   azd provision -- provision/update infrastructure only
//   azd deploy    -- rebuild & redeploy container only
//   azd down      -- tear down all resources
//
// The template uses a user-assigned managed identity created BEFORE the
// Container App. This breaks the circular dependency that exists with
// system-assigned identities (where the principalId is only available
// after the Container App is created, but ACR pull needs credentials
// during creation). The identity is granted AcrPull and (when provisioning
// a new storage account) Blob/Queue/Table Data Contributor roles before
// the Container App is provisioned.
// =============================================================================

targetScope = 'resourceGroup'

// -- Parameters ----------------------------------------------------------------
// location:                    Azure region; defaults to the resource group's location.
// environmentName:             Base name used to derive all child resource names.
// mcpApiKey:                   Bearer token clients must present to authenticate MCP requests.
// existingStorageAccountName:  (Optional) Use an existing Storage Account instead of creating one.
// existingStorageAccountKey:   (Optional) Access key for the existing Storage Account.

param location string = resourceGroup().location
param environmentName string

@secure()
param mcpApiKey string

// -- Bring-Your-Own Storage Account (BYOSA) ------------------------------------
// When both are set, the template skips creating a new Storage Account
// and uses the provided credentials directly. This lets you connect to
// a storage account in any subscription, resource group, or tenant.
param existingStorageAccountName string = ''

@secure()
param existingStorageAccountKey string = ''

// -- Storage Lifecycle Policy Mode ---------------------------------------------
// Controls automatic blob access-tier transitions to reduce storage costs.
// Only applies to new storage accounts (ignored when using BYOSA).
//
// Allowed values:
//   'none'    -- (default) No lifecycle rules. All blobs stay in Hot tier.
//   'one-way' -- Blobs transition to cheaper tiers based on modification date
//               and never automatically return to Hot:
//                 All block blobs  -> Cold tier after 15 days
//                 All block blobs  -> Archive tier after 90 days
//               Archived blobs must be manually rehydrated to read.
//   'smart'   -- Blobs transition to Cool after 30 days of no access, and
//               automatically promote back to Hot when accessed again.
//               Requires access-time tracking on the storage account.
//               Does NOT use Archive tier (archive cannot auto-rehydrate).
//
// Set via the deploy script: .\deploy_to_azure.ps1 -LifecyclePolicy one-way
@allowed([
  'none'
  'one-way'
  'smart'
])
param lifecyclePolicyMode string = 'none'

// -- Disabled Tools (optional) -------------------------------------------------
// Comma-separated list of tool names to disable at runtime.
// Disabled tools are omitted from tools/list and return a structured
// "forbidden" error when invoked. Case-insensitive. Empty string means
// all tools are enabled (default).
param disabledTools string = ''

// -- OpenTelemetry Monitoring (optional) ---------------------------------------
// When true, provisions Application Insights and deploys an OTel Collector
// sidecar container alongside the MCP server. The collector exports traces,
// metrics and logs to App Insights via the azure_monitor exporter.
param enableOtel bool = false

// Log Analytics data retention in days. Applies to both Container Apps
// system logs and Application Insights telemetry (which uses the same
// workspace). Longer retention costs more. Range: 30-730 days.
@minValue(30)
@maxValue(730)
param logRetentionDays int = 30

// OTel Collector sidecar image. Set by the deploy script after building
// and pushing the custom collector image to ACR. Empty string is valid
// when enableOtel is false (the image is never referenced).
param otelCollectorImage string = ''

@description('OTel telemetry level: off, basic, detailed, full')
param otelTelemetryLevel string = 'detailed'

@description('Minimum log severity for the OTel Collector log filter (9=INFO, 13=WARN)')
param otelLogMinSeverity string = '9'

// Computed flag: true when the user is bringing their own storage account.
var useExistingStorage = !empty(existingStorageAccountName) && !empty(existingStorageAccountKey)

// Normalise the environment name to lowercase so every derived resource name
// is valid. Azure Container Apps, Storage Accounts, and ACR all reject names
// that contain uppercase characters.
var envName = toLower(environmentName)

// -- Placeholder Image ----------------------------------------------------------
// During `azd provision`, the Container App always starts with this public
// placeholder image. The real application image is pushed to ACR and applied
// during `azd deploy` (the second phase of `azd up`).
//
// This avoids a common failure after `azd down --purge` + re-provision where
// a stale image tag (cached in .azure/<env>/.env) references a deleted ACR
// image, causing UNAUTHORIZED or "image not found" errors.
var placeholderImage = 'mcr.microsoft.com/k8se/quickstart:latest'

// -- Log Analytics (required by Container Apps Environment) ---------------------
// Container Apps require a Log Analytics workspace for application and system
// logs. PerGB2018 pricing tier is the most common pay-as-you-go option.
// Retention is controlled by the logRetentionDays parameter (default 30 days).
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${envName}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: logRetentionDays
  }
}

// -- Application Insights (conditional on enableOtel) --------------------------
// Provides the telemetry sink for traces, metrics, and logs exported by the
// OTel Collector sidecar. Reuses the existing Log Analytics workspace so all
// telemetry and Container Apps system logs live in one place.
resource appInsights 'Microsoft.Insights/components@2020-02-02' = if (enableOtel) {
  name: '${envName}-appi'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    RetentionInDays: logRetentionDays
  }
}

// -- Azure Workbook: MCP Storage Monitoring Dashboard --
// Deployed as a Bicep resource using loadTextContent. The workbook JSON
// is kept in its own file for maintainability (trap 11: serializedData
// is a JSON string, not an object).
resource workbook 'Microsoft.Insights/workbooks@2022-04-01' = if (enableOtel) {
  // Deterministic GUID so re-deployments update the same workbook
  // rather than creating duplicates (trap 10).
  name: guid(resourceGroup().id, 'mcp-storage-monitoring')
  location: location
  kind: 'shared'
  properties: {
    displayName: 'MCP Azure Storage Monitoring'
    serializedData: string(union(json(loadTextContent('../otel/workbook.json')), {
      fallbackResourceIds: [appInsights.id]
    }))
    version: '1.0'
    sourceId: appInsights.id
    category: 'workbook'
  }
}

// -- Alert Rule: High Error Rate --
// Fires when the error rate exceeds 10% over a 5-minute window.
// Requires at least 10 requests in the window to avoid false positives
// on low-traffic deployments. Must breach for 2 consecutive periods.
resource alertHighErrorRate 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = if (enableOtel) {
  name: '${envName}-alert-high-error-rate'
  location: location
  properties: {
    displayName: 'MCP Storage: High Error Rate'
    description: 'Fires when the error rate exceeds 10% over a 5-minute window.'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    scopes: [appInsights.id]
    criteria: {
      allOf: [
        {
          query: '''
            requests
            | where timestamp > ago(5m)
            | summarize Total = count(), Errors = countif(tobool(success) == false)
                by timestamp = bin(timestamp, 5m)
            | where Total >= 10
            | where (Errors * 100.0 / Total) > 10
            | project timestamp, Total, Errors, ErrorPct = round(Errors * 100.0 / Total, 1)
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 2
            minFailingPeriodsToAlert: 2
          }
        }
      ]
    }
    actions: {
      actionGroups: []
    }
  }
}

// -- Alert Rule: Latency Degradation --
// Fires when recent P95 latency exceeds 3 standard deviations above
// the 1-hour baseline. Uses overrideQueryTimeRange to decouple the
// query lookback (1h) from the evaluation window (5m). Sample-size
// guards (n >= 30, m >= 5, sigma > 0) prevent cold-start false positives.
resource alertLatencyDegradation 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = if (enableOtel) {
  name: '${envName}-alert-latency-degradation'
  location: location
  properties: {
    displayName: 'MCP Storage: Latency Degradation'
    description: 'Fires when recent P95 latency exceeds 3 standard deviations above the 1-hour baseline.'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    overrideQueryTimeRange: 'PT1H'
    scopes: [appInsights.id]
    criteria: {
      allOf: [
        {
          query: '''
            let population = requests
                | where timestamp > ago(1h)
                | extend v = duration;
            let baseline = population
                | summarize mu = avg(v), sigma = stdev(v), n = count();
            population
            | where timestamp > ago(10m)
            | summarize short_mu = avg(v), m = count()
                by timestamp = bin(timestamp, 5m)
            | extend joinkey = 1
            | join kind=inner (baseline | extend joinkey = 1) on joinkey
            | where n >= 30 and m >= 5 and sigma > 0
            | where short_mu > mu + 3 * sigma
            | project timestamp, short_mu, mu, sigma, n, m
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 2
            minFailingPeriodsToAlert: 2
          }
        }
      ]
    }
    actions: {
      actionGroups: []
    }
  }
}

// -- Azure Container Registry --------------------------------------------------
// Stores the MCP server Docker image. The Basic SKU is sufficient for low-
// throughput dev/test scenarios. Admin user is disabled -- image pulls use
// the user-assigned managed identity via the AcrPull role assignment below.
resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: '${replace(envName, '-', '')}acr'
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
}

// -- User-Assigned Managed Identity --------------------------------------------
// Created as an independent resource BEFORE the Container App. This breaks
// the circular dependency that plagues system-assigned identities:
//   System-assigned: Container App -> principalId -> AcrPull role -> pull image
//   User-assigned:   Identity -> AcrPull role -> Container App (can pull immediately)
//
// The identity is used for:
//   1. ACR image pull (via AcrPull role)
//   2. Storage RBAC (Blob/Queue/Table Data Contributor roles) -- only when
//      provisioning a new storage account (not for BYOSA)
resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${envName}-identity'
  location: location
}

// =============================================================================
// RBAC Role Assignments
//
// Assigned BEFORE the Container App is created (via dependsOn on the Container
// App resource). The user-assigned identity receives all roles upfront so the
// Container App can pull images and access storage from its first revision.
//
// Role GUIDs are well-known Azure built-in role definition IDs:
//   7f951dda-...  = AcrPull
//   ba92f5b4-...  = Storage Blob Data Contributor
//   974c5e8b-...  = Storage Queue Data Contributor
//   0a9a7e1f-...  = Storage Table Data Contributor
// =============================================================================

// -- Role: AcrPull -- let the identity pull images from ACR ---
// Without this, the container runtime cannot download the Docker image from
// our private registry. Scoped to the ACR resource only.
resource acrPullRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(containerRegistry.id, managedIdentity.id, '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  scope: containerRegistry
  properties: {
    principalId: managedIdentity.properties.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalType: 'ServicePrincipal'
  }
}

// -- Container Apps Environment ------------------------------------------------
// The managed environment is the shared hosting plane for one or more
// Container Apps. It handles networking, DNS, and log routing. All apps
// in the same environment share the same virtual network and Log Analytics
// workspace.
resource containerAppEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${envName}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// =============================================================================
// Storage Account -- conditional on BYOSA mode
//
// When useExistingStorage is false (default): provisions a new Storage Account
// and grants the managed identity RBAC roles for Blob, Queue, and Table.
//
// When useExistingStorage is true: no storage resources are created. The
// Container App uses the provided account name and key directly. RBAC roles
// are skipped because the existing account may be in a different resource
// group, subscription, or tenant where Bicep cannot assign roles.
// =============================================================================

// -- Storage Account (new, only when NOT using BYOSA) --------------------------
// When lifecyclePolicyMode is 'smart', access-time tracking is enabled so
// lifecycle rules can use daysAfterLastAccessTimeGreaterThan filters and
// enableAutoTierToHotFromCool to auto-promote blobs back to Hot on access.
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = if (!useExistingStorage) {
  name: '${replace(envName, '-', '')}stor'
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
  }
}

// -- Blob Service Properties (access-time tracking for smart mode) --
// Access-time tracking records the last time each blob was read. This is
// required for lifecycle rules that use daysAfterLastAccessTimeGreaterThan
// and enableAutoTierToHotFromCool. Only enabled when 'smart' mode is selected
// because tracking incurs a small per-operation cost.
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = if (!useExistingStorage && lifecyclePolicyMode == 'smart') {
  parent: storageAccount
  name: 'default'
  properties: {
    lastAccessTimeTrackingPolicy: {
      enable: true
      blobType: [
        'blockBlob'
      ]
    }
  }
}

// -- Storage RBAC (only for newly-provisioned storage accounts) --
// Skipped in BYOSA mode because:
//   a) The existing account may be in a different resource group/subscription
//   b) The user provides a shared key, so RBAC is not required for data access

resource blobRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!useExistingStorage) {
  name: guid(storageAccount.id, managedIdentity.id, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  scope: storageAccount
  properties: {
    principalId: managedIdentity.properties.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalType: 'ServicePrincipal'
  }
}

resource queueRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!useExistingStorage) {
  name: guid(storageAccount.id, managedIdentity.id, '974c5e8b-45b9-4653-ba55-5f855dd0fb88')
  scope: storageAccount
  properties: {
    principalId: managedIdentity.properties.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '974c5e8b-45b9-4653-ba55-5f855dd0fb88')
    principalType: 'ServicePrincipal'
  }
}

resource tableRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!useExistingStorage) {
  name: guid(storageAccount.id, managedIdentity.id, '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
  scope: storageAccount
  properties: {
    principalId: managedIdentity.properties.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
    principalType: 'ServicePrincipal'
  }
}

// -- Lifecycle Management Policies (only for newly-provisioned storage) --
// Automatically transition blobs between access tiers to reduce storage
// costs without any application code changes.
//
// Only applies to new storage accounts. BYOSA customers manage their own
// lifecycle policies.
//
// 'one-way' mode -- blobs move to cheaper tiers and never auto-return:
//   Rule 1: All block blobs -> Cold tier after 15 days (no modification)
//   Rule 2: All block blobs -> Archive tier after 90 days (no modification)
//   Archived blobs must be manually rehydrated via blob-set-tier tool.
resource lifecyclePolicyOneWay 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = if (lifecyclePolicyMode == 'one-way' && !useExistingStorage) {
  parent: storageAccount
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'cold-after-15-days'
          enabled: true
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: {
                tierToCold: {
                  daysAfterModificationGreaterThan: 15
                }
              }
            }
            filters: {
              blobTypes: [
                'blockBlob'
              ]
            }
          }
        }
        {
          name: 'archive-after-90-days'
          enabled: true
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: {
                tierToArchive: {
                  daysAfterModificationGreaterThan: 90
                }
              }
            }
            filters: {
              blobTypes: [
                'blockBlob'
              ]
            }
          }
        }
      ]
    }
  }
}

// 'smart' mode -- blobs cool down after inactivity and auto-reheat on access:
//   Rule 1: All block blobs -> Cool tier after 30 days with no access
//   Rule 2: Auto-promote Cool blobs back to Hot when accessed
//   Does NOT use Archive tier (archive cannot auto-rehydrate).
//   Requires access-time tracking (enabled via blobService resource above).
resource lifecyclePolicySmart 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = if (lifecyclePolicyMode == 'smart' && !useExistingStorage) {
  parent: storageAccount
  name: 'default'
  dependsOn: [
    blobService    // Access-time tracking must be enabled first
  ]
  properties: {
    policy: {
      rules: [
        {
          name: 'cool-after-30-days-inactive'
          enabled: true
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: {
                tierToCool: {
                  daysAfterLastAccessTimeGreaterThan: 30
                }
                enableAutoTierToHotFromCool: true
              }
            }
            filters: {
              blobTypes: [
                'blockBlob'
              ]
            }
          }
        }
      ]
    }
  }
}

// -- Resolved storage values ---------------------------------------------------
// These variables select between BYOSA and newly-provisioned values.
// Used by the Container App's env vars and secrets.
var resolvedStorageAccountName = useExistingStorage ? existingStorageAccountName : storageAccount.name
var resolvedStorageAccountKey = useExistingStorage ? existingStorageAccountKey : storageAccount.listKeys().keys[0].value

// =============================================================================
// Container App -- Container definitions
//
// The containers array is built using variables so we can conditionally include
// the OTel Collector sidecar. Bicep does not support conditional items inside
// array literals, so we compose the array from separate variable definitions.
// =============================================================================

// -- MCP server container (always present) -------------------------------------
var mcpServerEnv = [
  {
    name: 'NODE_ENV'
    value: 'production'
  }
  {
    name: 'AZURE_STORAGE_ACCOUNT_NAME'
    value: resolvedStorageAccountName
  }
  {
    name: 'AZURE_STORAGE_ACCOUNT_KEY'
    secretRef: 'storage-account-key'
  }
  {
    name: 'MCP_API_KEY'
    secretRef: 'mcp-api-key'
  }
  {
    // Set to 'true' to use DefaultAzureCredential (managed identity)
    // instead of StorageSharedKeyCredential for data operations.
    // When enabled, AZURE_STORAGE_ACCOUNT_KEY is still used for SAS
    // token generation; data ops use the Container App's identity.
    name: 'AZURE_USE_MANAGED_IDENTITY'
    value: 'false'
  }
  {
    // Hard byte limit for streaming multipart uploads via /upload.
    // Default: 5 GiB (5368709120). Files beyond this are rejected
    // with a 413 response containing a write SAS URL hint.
    name: 'MAX_UPLOAD_BYTES'
    value: '5368709120'
  }
  {
    // Hard byte limit for JSON request bodies on /mcp.
    // Default: 50 MiB (52428800). Controls express.json({ limit }).
    name: 'MAX_JSON_BODY_BYTES'
    value: '52428800'
  }
  {
    // Maximum visibility timeout (lease duration) in seconds for
    // queue-update-message and queue-renew-lease. Default: 3600 (1h).
    name: 'MAX_QUEUE_VISIBILITY_SECONDS'
    value: '3600'
  }
  {
    // Comma-separated list of tool names to disable at runtime.
    // Disabled tools are omitted from tools/list and return a
    // structured "forbidden" error when invoked. Case-insensitive.
    // Empty string (default) means all tools are enabled.
    name: 'DISABLED_TOOLS'
    value: disabledTools
  }
  {
    // Maximum allowed SAS token lifetime in minutes.
    // Default: 1440 (24 hours). Requests exceeding this ceiling
    // receive a structured "invalid" error instead of silent clamping.
    name: 'SAS_MAX_EXPIRY_MINUTES'
    value: '1440'
  }
  {
    // SAS protocol selection: "https" (default, production-safe) or
    // "https,http" (required for Azurite / local emulator which uses HTTP).
    name: 'SAS_PROTOCOL'
    value: 'https'
  }
]

// -- OTel instrumentation env vars (only meaningful when monitoring is enabled) --
// When enableOtel is false, OTEL_EXPORTER_OTLP_ENDPOINT is empty which causes
// the instrumentation.cjs activation guard to exit immediately -- zero overhead.
var otelInstrumentationEnv = [
  {
    name: 'OTEL_EXPORTER_OTLP_ENDPOINT'
    value: enableOtel ? 'http://localhost:4318' : ''
  }
  {
    name: 'OTEL_SERVICE_NAME'
    value: 'mcp-azure-storage'
  }
  {
    name: 'OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE'
    value: 'delta'
  }
  {
    name: 'OTEL_TELEMETRY_LEVEL'
    value: otelTelemetryLevel
  }
]

var mcpContainer = {
  name: 'mcp-server'
  image: placeholderImage       // Always uses public placeholder during provision;
                                // azd deploy updates to the real ACR image after push
  resources: {
    cpu: json('0.5')           // 0.5 vCPU per replica (min for Container Apps)
    memory: '1Gi'              // 1 GiB RAM per replica
  }
  env: concat(mcpServerEnv, otelInstrumentationEnv)
}

// -- OTel Collector sidecar container (only when enableOtel is true) ------------
// Runs the custom collector image (built from otel/Dockerfile) which includes
// the azure_monitor exporter. Receives telemetry from the MCP server on
// localhost:4318 (OTLP/HTTP) and forwards it to Application Insights.
var otelCollectorContainer = {
  name: 'otel-collector'
  image: otelCollectorImage
  resources: {
    cpu: json('0.25')
    memory: '0.5Gi'
  }
  env: [
    {
      name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
      secretRef: 'appinsights-connection-string'
    }
    {
      // Collector log severity: WARN=13, INFO=9, DEBUG=5.
      // Configurable via otelLogMinSeverity parameter.
      name: 'OTEL_LOG_MIN_SEVERITY'
      value: otelLogMinSeverity
    }
    {
      name: 'OTEL_DEPLOYMENT_ENV'
      value: 'production'
    }
  ]
}

// Conditional containers array -- includes the sidecar only when OTel is enabled
var containers = enableOtel ? [mcpContainer, otelCollectorContainer] : [mcpContainer]

// -- Secrets array (conditional App Insights connection string) -----------------
var baseSecrets = [
  {
    name: 'mcp-api-key'
    value: mcpApiKey
  }
  {
    name: 'storage-account-key'
    value: resolvedStorageAccountKey
  }
]

var otelSecrets = enableOtel ? [
  {
    name: 'appinsights-connection-string'
    value: appInsights.properties.ConnectionString
  }
] : []

var allSecrets = concat(baseSecrets, otelSecrets)

// -- Container App -------------------------------------------------------------
// The main application resource. Runs the MCP server Docker image as a
// serverless container with automatic HTTPS and auto-scaling.
//
// Uses a user-assigned managed identity for passwordless ACR pull and
// (when not using BYOSA) Storage RBAC. The AcrPull role assignment is
// completed BEFORE this resource is created (via dependsOn), eliminating
// the circular dependency that previously caused UNAUTHORIZED errors.
resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${envName}-mcp'
  location: location
  tags: {
    'azd-service-name': 'mcp-server'   // Required: maps this resource to the service in azure.yaml
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentity.id}': {}
    }
  }
  dependsOn: [
    acrPullRoleAssignment    // Ensure ACR pull permission exists before first image pull
    blobRoleAssignment       // Ensure storage roles are ready when app starts (no-op if BYOSA)
    queueRoleAssignment
    tableRoleAssignment
  ]
  properties: {
    managedEnvironmentId: containerAppEnv.id
    configuration: {
      // -- Revision Mode --
      // Sticky sessions require Single revision mode (explicitly set here).
      // In Single mode, only one active revision receives traffic at a time,
      // and the ingress can pin clients to specific replicas via session
      // affinity cookies.
      activeRevisionsMode: 'Single'
      // -- Ingress --
      // External ingress exposes the app on a public *.azurecontainerapps.io URL
      // with automatic HTTPS and a managed TLS certificate.
      ingress: {
        external: true
        targetPort: 3000         // Must match the Express PORT in Dockerfile
        transport: 'http'        // Container speaks plain HTTP; the platform terminates TLS
        // -- Sticky Sessions --
        // MCP stateful sessions store state in-memory on a specific replica.
        // Without affinity, the load balancer may route subsequent requests
        // (carrying the same Mcp-Session-Id) to a different replica that has
        // no knowledge of that session, causing "session not found" errors.
        // Sticky sessions use a cookie to pin a client to the same replica
        // for the duration of the session.
        stickySessions: {
          affinity: 'sticky'
        }
      }
      // -- Registry --
      // ACR is configured here using the user-assigned managed identity.
      // Because the AcrPull role is assigned via dependsOn BEFORE this resource
      // is created, the Container App can authenticate to ACR from its first revision.
      registries: [
        {
          server: containerRegistry.properties.loginServer
          identity: managedIdentity.id
        }
      ]
      // -- Secrets --
      // Secrets are encrypted at rest and injected as env vars via secretRef.
      // They are NOT exposed in template definitions or Azure Portal UI.
      // When OTel is enabled, the App Insights connection string is added.
      secrets: allSecrets
    }
    template: {
      containers: containers
      // -- Auto-scaling --
      scale: {
        minReplicas: 1
        maxReplicas: 5
        rules: [
          {
            name: 'http-scaling'
            http: {
              metadata: {
                concurrentRequests: '20'
              }
            }
          }
        ]
      }
    }
  }
}

// -- Outputs -------------------------------------------------------------------
// These values are captured by azd and stored in .azure/<env>/.env for
// subsequent commands. They are also displayed in `azd show` output.

output AZURE_CONTAINER_REGISTRY_ENDPOINT string = containerRegistry.properties.loginServer
output mcpEndpoint string = 'https://${containerApp.properties.configuration.ingress.fqdn}/mcp'
output storageAccountName string = resolvedStorageAccountName
output appInsightsConnectionString string = enableOtel ? appInsights.properties.ConnectionString : ''
output appInsightsName string = enableOtel ? appInsights.name : ''
