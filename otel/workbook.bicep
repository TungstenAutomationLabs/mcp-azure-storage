// workbook.bicep -- Deploy the MCP Azure Storage observability workbook.
//
// Deployed by scripts/setup-monitoring.ps1. Run the script first to
// create the Application Insights resource this targets.
//
// Two mechanics worth knowing before editing this file:
//
//   1. The workbook resource NAME must be a GUID. It is derived
//      deterministically from the resource group id, so redeploying
//      UPDATES the same workbook. Using newGuid() here would create a
//      fresh workbook on every deployment instead.
//
//   2. properties.serializedData is a JSON *string*, not an object.
//      The payload lives in workbook.json and is loaded, parsed,
//      augmented with the target resource id, and re-serialised here.
//      This keeps workbook.json clean of any subscription-specific
//      values, so the same file deploys anywhere.

@description('Name of the existing Application Insights resource to bind the workbook to.')
param appInsightsName string

@description('Display name shown in the workbook gallery.')
param workbookDisplayName string = 'MCP Azure Storage -- Observability'

@description('Region for the workbook resource. Defaults to the resource group location.')
param location string = resourceGroup().location

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

// Parse the payload, then inject the target resource so every query
// item resolves against it without workbook.json naming a subscription.
var workbookPayload = json(loadTextContent('workbook.json'))

var workbookWithScope = {
  version: workbookPayload.version
  items: workbookPayload.items
  fallbackResourceIds: [
    appInsights.id
  ]
}

resource workbook 'Microsoft.Insights/workbooks@2022-04-01' = {
  // Deterministic, so this is an update-in-place on re-deploy.
  name: guid(resourceGroup().id, 'mcp-storage-observability')
  location: location
  kind: 'shared'
  properties: {
    displayName: workbookDisplayName
    serializedData: string(workbookWithScope)
    version: '1.0'
    sourceId: appInsights.id
    category: 'workbook'
  }
}

output workbookResourceId string = workbook.id
output appInsightsResourceId string = appInsights.id
output portalUrl string = 'https://portal.azure.com/#@/resource${workbook.id}'
