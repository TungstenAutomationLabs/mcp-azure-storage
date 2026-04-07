// =============================================================================
// MCP Azure Storage Server — Infrastructure as Code (Bicep)
//
// Provisions all Azure resources needed to run the MCP server:
//   1. Log Analytics Workspace — centralised logging for Container Apps
//   2. Azure Container Registry (ACR) — stores the Docker image
//   3. User-Assigned Managed Identity — shared identity for ACR pull + RBAC
//   4. RBAC Role Assignments — AcrPull + Storage roles (before Container App)
//   5. Container Apps Environment — managed Kubernetes hosting layer
//   6. Storage Account — the Azure Storage account the MCP tools operate on
//   7. Container App — the running MCP server instance
//
// Deployed via Azure Developer CLI:
//   azd up        — provision infrastructure + build & deploy container
//   azd provision — provision/update infrastructure only
//   azd deploy    — rebuild & redeploy container only
//   azd down      — tear down all resources
//
// The template uses a user-assigned managed identity created BEFORE the
// Container App. This breaks the circular dependency that exists with
// system-assigned identities (where the principalId is only available
// after the Container App is created, but ACR pull needs credentials
// during creation). The identity is granted AcrPull, Blob/Queue/Table
// Data Contributor roles before the Container App is provisioned.
// =============================================================================

targetScope = 'resourceGroup'

// ── Parameters ────────────────────────────────────────────────
// location:        Azure region; defaults to the resource group's location.
// environmentName: Base name used to derive all child resource names.
// mcpApiKey:       Bearer token clients must present to authenticate MCP requests.

param location string = resourceGroup().location
param environmentName string

@secure()
param mcpApiKey string

// ── Placeholder Image ─────────────────────────────────────────
// During `azd provision`, the Container App always starts with this public
// placeholder image. The real application image is pushed to ACR and applied
// during `azd deploy` (the second phase of `azd up`).
//
// This avoids a common failure after `azd down --purge` + re-provision where
// a stale image tag (cached in .azure/<env>/.env) references a deleted ACR
// image, causing UNAUTHORIZED or "image not found" errors.
var placeholderImage = 'mcr.microsoft.com/k8se/quickstart:latest'

// ── Log Analytics (required by Container Apps Environment) ────
// Container Apps require a Log Analytics workspace for application and system
// logs. PerGB2018 pricing tier is the most common pay-as-you-go option.
// Logs are retained for 30 days to balance cost and debuggability.
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${environmentName}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ── Azure Container Registry ─────────────────────────────────
// Stores the MCP server Docker image. The Basic SKU is sufficient for low-
// throughput dev/test scenarios. Admin user is disabled — image pulls use
// the user-assigned managed identity via the AcrPull role assignment below.
resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: '${replace(environmentName, '-', '')}acr'
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
}

// ── User-Assigned Managed Identity ───────────────────────────
// Created as an independent resource BEFORE the Container App. This breaks
// the circular dependency that plagues system-assigned identities:
//   System-assigned: Container App → principalId → AcrPull role → pull image
//   User-assigned:   Identity → AcrPull role → Container App (can pull immediately)
//
// The identity is used for:
//   1. ACR image pull (via AcrPull role)
//   2. Storage RBAC (Blob/Queue/Table Data Contributor roles)
resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${environmentName}-identity'
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

// ── Role: AcrPull — let the identity pull images from ACR ────
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

// ── Container Apps Environment ───────────────────────────────
// The managed environment is the shared hosting plane for one or more
// Container Apps. It handles networking, DNS, and log routing. All apps
// in the same environment share the same virtual network and Log Analytics
// workspace.
resource containerAppEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${environmentName}-env'
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

// ── Storage Account ──────────────────────────────────────────
// The Azure Storage account that the MCP tools read from and write to.
// - Standard_LRS: locally-redundant storage (cheapest; upgrade to GRS for production).
// - StorageV2: supports Blob, Queue, Table, and File Share services.
// - HTTPS-only with TLS 1.2 minimum for security compliance.
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: '${replace(environmentName, '-', '')}stor'
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
  }
}

// ── Role: Storage Blob Data Contributor ──────────────────────
// Grants read/write/delete access to blob containers and blobs.
// Used by blob-tools.ts for container and blob operations.
resource blobRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, managedIdentity.id, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  scope: storageAccount
  properties: {
    principalId: managedIdentity.properties.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalType: 'ServicePrincipal'
  }
}

// ── Role: Storage Queue Data Contributor ─────────────────────
// Grants read/write/delete access to queues and messages.
// Used by queue-tools.ts for queue CRUD and message processing.
resource queueRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, managedIdentity.id, '974c5e8b-45b9-4653-ba55-5f855dd0fb88')
  scope: storageAccount
  properties: {
    principalId: managedIdentity.properties.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '974c5e8b-45b9-4653-ba55-5f855dd0fb88')
    principalType: 'ServicePrincipal'
  }
}

// ── Role: Storage Table Data Contributor ─────────────────────
// Grants read/write/delete access to tables and entities.
// Used by table-tools.ts for table CRUD and entity queries.
resource tableRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, managedIdentity.id, '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
  scope: storageAccount
  properties: {
    principalId: managedIdentity.properties.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
    principalType: 'ServicePrincipal'
  }
}

// ── Container App ────────────────────────────────────────────
// The main application resource. Runs the MCP server Docker image as a
// serverless container with automatic HTTPS and auto-scaling.
//
// Uses a user-assigned managed identity for passwordless ACR pull and
// Storage RBAC. The AcrPull role assignment is completed BEFORE this
// resource is created (via dependsOn), eliminating the circular dependency
// that previously caused UNAUTHORIZED errors on first provision.
resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${environmentName}-mcp'
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
    blobRoleAssignment       // Ensure storage roles are ready when app starts
    queueRoleAssignment
    tableRoleAssignment
  ]
  properties: {
    managedEnvironmentId: containerAppEnv.id
    configuration: {
      // ── Ingress ──
      // External ingress exposes the app on a public *.azurecontainerapps.io URL
      // with automatic HTTPS and a managed TLS certificate.
      //
      // Note: Sticky sessions (session affinity) are not enabled here because
      // Azure Container Apps has limited API support for the feature across
      // revision modes. The MCP server handles this at the application layer:
      //  - Stateful mode: sessions are keyed by Mcp-Session-Id header
      //  - Stateless mode: each request is self-contained (no affinity needed)
      // For production with multiple replicas, consider adding external session
      // state (e.g. Redis) or enabling sticky sessions if your API version supports it.
      ingress: {
        external: true
        targetPort: 3000         // Must match the Express PORT in Dockerfile
        transport: 'http'        // Container speaks plain HTTP; the platform terminates TLS
      }
      // ── Registry ──
      // ACR is configured here using the user-assigned managed identity.
      // Because the AcrPull role is assigned via dependsOn BEFORE this resource
      // is created, the Container App can authenticate to ACR from its first revision.
      registries: [
        {
          server: containerRegistry.properties.loginServer
          identity: managedIdentity.id
        }
      ]
      // ── Secrets ──
      // Secrets are encrypted at rest and injected as env vars via secretRef.
      // They are NOT exposed in template definitions or Azure Portal UI.
      secrets: [
        {
          name: 'mcp-api-key'
          value: mcpApiKey
        }
        {
          name: 'storage-account-key'
          value: storageAccount.listKeys().keys[0].value
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'mcp-server'
          image: placeholderImage       // Always uses public placeholder during provision;
                                        // azd deploy updates to the real ACR image after push
          resources: {
            cpu: json('0.5')           // 0.5 vCPU per replica (min for Container Apps)
            memory: '1Gi'              // 1 GiB RAM per replica
          }
          // ── Environment Variables ──
          // Plain values and secret references are injected into the container.
          // The MCP server reads these in src/config.ts via getStorageConfig().
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'                  // Ensures production-mode behaviour even if Dockerfile ENV is overridden
            }
            {
              name: 'AZURE_STORAGE_ACCOUNT_NAME'
              value: storageAccount.name
            }
            {
              name: 'AZURE_STORAGE_ACCOUNT_KEY'
              secretRef: 'storage-account-key'   // Injected from secrets array above
            }
            {
              name: 'MCP_API_KEY'
              secretRef: 'mcp-api-key'           // Injected from secrets array above
            }
          ]
          // ── Health Probes ──
          // Note: Custom health probes are intentionally omitted. During the
          // initial `azd provision`, the Container App runs a placeholder image
          // that does NOT expose /health on port 3000. Health probes against
          // the placeholder would fail for 20+ minutes until the revision times
          // out, blocking deployment.
          //
          // Azure Container Apps provides built-in TCP health checks automatically.
          // The MCP server exposes GET /health for manual monitoring and external
          // health checks (e.g., Azure Front Door, uptime monitors).
        }
      ]
      // ── Auto-scaling ──
      // minReplicas: 0 allows scale-to-zero when idle (cost saving).
      // maxReplicas: 5 caps horizontal scaling.
      // HTTP rule: add a replica when concurrent requests per replica exceed 20.
      scale: {
        minReplicas: 0
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

// ── Outputs ──────────────────────────────────────────────────
// These values are captured by azd and stored in .azure/<env>/.env for
// subsequent commands. They are also displayed in `azd show` output.

// AZURE_CONTAINER_REGISTRY_ENDPOINT: azd uses this to know where to push
// Docker images during `azd deploy`. Must be an output with this exact name.
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = containerRegistry.properties.loginServer

// mcpEndpoint: the full URL clients use to connect to the MCP server.
output mcpEndpoint string = 'https://${containerApp.properties.configuration.ingress.fqdn}/mcp'

// storageAccountName: the provisioned storage account name (useful for
// local development configuration in .env files).
output storageAccountName string = storageAccount.name
