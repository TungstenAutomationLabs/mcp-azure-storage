# Multi-Environment Deployment Guide

This project uses the [Azure Developer CLI (`azd`)](https://learn.microsoft.com/en-us/azure/developer/azure-developer-cli/) which has **built-in multi-environment support**. Each environment is a named configuration stored in `.azure/<env-name>/.env` — containing the subscription, region, API keys, and all Bicep parameters for that deployment. You can create as many environments as you need (dev, test, staging, prod) and switch between them with a single command.

---

## Table of Contents

- [How azd Environments Work](#how-azd-environments-work)
- [Quick Start: Create Dev and Test Environments](#quick-start-create-dev-and-test-environments)
- [Switching Between Environments](#switching-between-environments)
- [Deploy to a Specific Environment](#deploy-to-a-specific-environment)
- [Using Different Azure Subscriptions](#using-different-azure-subscriptions)
- [Bring Your Own Storage Account (BYOSA) per Environment](#bring-your-own-storage-account-byosa-per-environment)
- [Environment Variable Reference](#environment-variable-reference)
- [Convenience Scripts](#convenience-scripts)
- [Viewing and Comparing Environments](#viewing-and-comparing-environments)
- [Tearing Down an Environment](#tearing-down-an-environment)
- [CI/CD with Multiple Environments](#cicd-with-multiple-environments)
- [Directory Structure](#directory-structure)
- [Troubleshooting](#troubleshooting)

---

## How azd Environments Work

Each `azd` environment is a named directory under `.azure/` containing an `.env` file:

```
.azure/
├── mcp-storage-dev/
│   └── .env          ← dev subscription, region, secrets
├── mcp-storage-test/
│   └── .env          ← test subscription, region, secrets
└── config.json       ← tracks which environment is currently active
```

The active environment determines which `.env` file is read when you run `azd provision`, `azd deploy`, or `azd up`. All `azd env set` commands write to the **currently selected** environment.

> **Key principle:** The same Bicep infrastructure code ([`infra/main.bicep`](infra/main.bicep)) and application code are deployed to every environment — only the **parameters** (subscription, region, secrets, storage account) differ.

---

## Quick Start: Create Dev and Test Environments

### Step 1 — Login to Azure

```bash
az login
azd auth login
```

### Step 2 — Create the `dev` environment

```bash
# Create and select the dev environment
azd env new mcp-storage-dev

# Configure subscription and region
azd env set AZURE_SUBSCRIPTION_ID "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
azd env set AZURE_LOCATION "uksouth"

# Set required secrets
azd env set MCP_API_KEY "dev-api-key-change-me"
```

### Step 3 — Create the `test` environment

```bash
# Create and select the test environment (switches active environment)
azd env new mcp-storage-test

# Use a DIFFERENT subscription and/or region
azd env set AZURE_SUBSCRIPTION_ID "ffffffff-1111-2222-3333-444444444444"
azd env set AZURE_LOCATION "northeurope"

# Set different secrets for test
azd env set MCP_API_KEY "test-api-key-change-me"
```

### Step 4 — Deploy to dev

```bash
azd env select mcp-storage-dev
azd up
```
Or
```bash
azd up --environment mcp-storage-dev
```

### Step 5 — Deploy to test

```bash
azd env select mcp-storage-test
azd up
```
Or
```bash
azd up --environment mcp-storage-test
```

That's it — two fully independent deployments, each in its own subscription and resource group, managed by the same codebase.

---

## Switching Between Environments

```bash
# See which environment is currently active
azd env list

# Switch to the dev environment
azd env select mcp-storage-dev

# Switch to the test environment
azd env select mcp-storage-test
```

After `azd env select`, all subsequent `azd` commands (provision, deploy, up, down, env set, env get-values) operate on the selected environment.

---

## Deploy to a Specific Environment

### Option A — Select then deploy (recommended)

```bash
azd env select mcp-storage-dev
azd up
```

### Option B — One-liner with `--environment` flag

Every `azd` command accepts `--environment` (or `-e`) to target a specific environment without changing the default selection:

```bash
# Deploy to dev without switching the active environment
azd up --environment mcp-storage-dev

# Deploy to test without switching the active environment
azd up --environment mcp-storage-test
```

### Option C — Deploy only (skip provision)

If infrastructure hasn't changed, skip provisioning and just redeploy the application:

```bash
azd deploy --environment mcp-storage-dev
```

---

## Using Different Azure Subscriptions

Each environment can target a **completely different** Azure subscription. This is the standard way to isolate dev from test:

```bash
# Dev environment → Dev subscription
azd env select mcp-storage-dev
azd env set AZURE_SUBSCRIPTION_ID "dev-subscription-id-here"

# Test environment → Test subscription
azd env select mcp-storage-test
azd env set AZURE_SUBSCRIPTION_ID "test-subscription-id-here"
```

> **Tip:** List your available subscriptions with:
> ```bash
> az account list --query "[].{name:name, id:id, isDefault:isDefault}" -o table
> ```

If the subscriptions belong to different tenants, you may also need to log in to each tenant:

```bash
az login --tenant <tenant-id>
azd auth login --tenant-id <tenant-id>
```

---

## Bring Your Own Storage Account (BYOSA) per Environment

You can connect each environment to a different existing storage account — useful when dev and test data live in separate accounts:

```bash
# Dev → uses a dev storage account
azd env select mcp-storage-dev
azd env set AZURE_STORAGE_ACCOUNT_NAME "devstorageaccount"
azd env set AZURE_STORAGE_ACCOUNT_KEY "$(az storage account keys list --account-name devstorageaccount --query '[0].value' -o tsv)"

# Test → uses a test storage account
azd env select mcp-storage-test
azd env set AZURE_STORAGE_ACCOUNT_NAME "teststorageaccount"
azd env set AZURE_STORAGE_ACCOUNT_KEY "$(az storage account keys list --account-name teststorageaccount --query '[0].value' -o tsv)"
```

Leave both `AZURE_STORAGE_ACCOUNT_NAME` and `AZURE_STORAGE_ACCOUNT_KEY` **unset** if you want Bicep to provision a new storage account automatically for that environment.

---

## Environment Variable Reference

Each environment's `.azure/<env-name>/.env` file can contain:

| Variable | Required | Set by | Description |
|----------|----------|--------|-------------|
| `AZURE_ENV_NAME` | Yes | `azd env new` | Environment name (used as prefix for all resource names) |
| `AZURE_SUBSCRIPTION_ID` | Yes | `azd init` or `azd env set` | Target Azure subscription |
| `AZURE_LOCATION` | Yes | `azd init` or `azd env set` | Azure region (e.g. `uksouth`, `northeurope`) |
| `MCP_API_KEY` | **Yes** | `azd env set` | API key for client authentication |
| `AZURE_STORAGE_ACCOUNT_NAME` | No | `azd env set` | Existing storage account name (BYOSA) |
| `AZURE_STORAGE_ACCOUNT_KEY` | No | `azd env set` | Existing storage account key (BYOSA) |
| `CORS_ENABLED` | No | `azd env set` | Enable CORS (`true`/`false`, default: `true`) |
| `AZURE_CONTAINER_REGISTRY_ENDPOINT` | — | Bicep output | Auto-populated after `azd provision` |
| `mcpEndpoint` | — | Bicep output | Auto-populated after `azd provision` |
| `storageAccountName` | — | Bicep output | Auto-populated after `azd provision` |
| `SERVICE_MCP_SERVER_IMAGE_NAME` | — | `azd deploy` | Auto-populated after `azd deploy` |

---

## Convenience Scripts

The project includes npm scripts that wrap common multi-environment workflows. These use the `--environment` flag so you don't need to manually switch:

```bash
# Deploy to dev
npm run azd:dev

# Deploy to test
npm run azd:test

# Provision-only (no app deploy)
npm run azd:dev:provision
npm run azd:test:provision

# Deploy-only (skip provisioning)
npm run azd:dev:deploy
npm run azd:test:deploy
```

> **Note:** These scripts assume environments named `mcp-storage-dev` and `mcp-storage-test`. Edit `package.json` if you used different names.

---

## Viewing and Comparing Environments

### List all environments

```bash
azd env list
```

Output shows each environment, its subscription, and which is currently selected:

```
NAME                 DEFAULT  SUBSCRIPTION
mcp-storage-dev      true     Dev Subscription (aaaa...)
mcp-storage-test     false    Test Subscription (ffff...)
```

### View settings for the active environment

```bash
azd env get-values
```

### View settings for a specific environment

```bash
azd env get-values --environment mcp-storage-test
```

### Compare two environments side-by-side (PowerShell)

```powershell
# Quick diff of environment configs
diff (azd env get-values -e mcp-storage-dev) (azd env get-values -e mcp-storage-test)
```

### Compare two environments side-by-side (bash)

```bash
diff <(azd env get-values -e mcp-storage-dev) <(azd env get-values -e mcp-storage-test)
```

---

## Tearing Down an Environment

Remove all Azure resources for a specific environment without affecting others:

```bash
# Tear down test (keeps dev intact)
azd down --environment mcp-storage-test

# Tear down and purge soft-deleted resources
azd down --environment mcp-storage-test --purge
```

To also delete the local environment configuration:

```bash
# Remove the local .azure/mcp-storage-test/ directory
azd env delete mcp-storage-test
```

> **Warning:** `azd down` is destructive. All resources and data in the target environment's resource group will be permanently deleted. Other environments are not affected.

---

## CI/CD with Multiple Environments

### GitHub Actions Example

Use the `--environment` flag in your CI/CD workflow to deploy to specific environments:

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches:
      - main        # → deploy to dev
      - release/**  # → deploy to test

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install azd
        uses: Azure/setup-azd@v2

      - name: Azure Login
        uses: azure/login@v2
        with:
          creds: ${{ secrets.AZURE_CREDENTIALS }}

      - name: Set target environment
        id: env
        run: |
          if [[ "${{ github.ref }}" == "refs/heads/main" ]]; then
            echo "name=mcp-storage-dev" >> $GITHUB_OUTPUT
          else
            echo "name=mcp-storage-test" >> $GITHUB_OUTPUT
          fi

      - name: Deploy
        run: azd up --environment ${{ steps.env.outputs.name }} --no-prompt
        env:
          AZURE_ENV_NAME: ${{ steps.env.outputs.name }}
          AZURE_SUBSCRIPTION_ID: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
          AZURE_LOCATION: ${{ vars.AZURE_LOCATION }}
          MCP_API_KEY: ${{ secrets.MCP_API_KEY }}
```

### Storing Environment Configs in CI

For CI/CD, you typically **don't** check in `.azure/` directories. Instead, set environment variables via:
- **GitHub Secrets** — for sensitive values (`MCP_API_KEY`, `AZURE_STORAGE_ACCOUNT_KEY`)
- **GitHub Variables** — for non-sensitive values (`AZURE_LOCATION`)
- **`azd env set`** in the workflow — to configure the environment before deploy

---

## Directory Structure

After creating both environments, your `.azure/` directory looks like:

```
.azure/
├── config.json                    ← {"defaultEnvironment": "mcp-storage-dev"}
├── mcp-storage-dev/
│   └── .env                       ← AZURE_SUBSCRIPTION_ID, AZURE_LOCATION, MCP_API_KEY, ...
└── mcp-storage-test/
    └── .env                       ← different subscription, region, secrets
```

The `.azure/` directory is gitignored (it contains secrets). Each developer creates their own environments locally.

---

## Troubleshooting

### "Environment not found"

```bash
# List available environments
azd env list

# Create the missing environment
azd env new mcp-storage-dev
```

### Wrong subscription targeted

```bash
# Check which subscription the active environment uses
azd env get-values | findstr AZURE_SUBSCRIPTION_ID

# Fix it
azd env set AZURE_SUBSCRIPTION_ID "correct-subscription-id"
```

### Resource name conflicts between environments

All Azure resource names are derived from `AZURE_ENV_NAME` (set during `azd env new`). As long as your environment names are unique, resources won't conflict:

| Environment | Resource Group | Container App | Storage Account | ACR |
|---|---|---|---|---|
| `mcp-storage-dev` | `rg-mcp-storage-dev` | `mcp-storage-dev-mcp` | `mcpstoragedevstor` | `mcpstoragedevacr` |
| `mcp-storage-test` | `rg-mcp-storage-test` | `mcp-storage-test-mcp` | `mcpstorageteststor` | `mcpstoragetestacr` |

### Stale image after `azd down --purge` + re-provision

If you tear down and re-create an environment, the cached `SERVICE_MCP_SERVER_IMAGE_NAME` in `.azure/<env>/.env` may reference a deleted ACR image. The Bicep template handles this by always using a [placeholder image](infra/main.bicep:76) during provisioning — the real image is pushed during `azd deploy`.

If you still hit issues, delete the stale value:

```bash
azd env set SERVICE_MCP_SERVER_IMAGE_NAME ""
azd up
```

### Multiple Azure tenants

If your dev and test subscriptions are in different Azure AD tenants, log in to the correct tenant before deploying:

```bash
az login --tenant <tenant-id>
azd auth login --tenant-id <tenant-id>
azd env select mcp-storage-test
azd up
```
