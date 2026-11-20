targetScope = 'resourceGroup'

param location string = resourceGroup().location
param prefix string
param environmentId string
param registryServer string
param imageTag string
param identityId string
param clientId string
param databaseHost string
param configEndpoint string
param storageName string
param databaseUser string = 'archive_job'
param jobPrincipalId string
param webPrincipalId string
param adminName string
@allowed(['bootstrap', 'seed', 'verify', 'web-check'])
param mode string
@secure()
param adminToken string = ''

resource helper 'Microsoft.App/jobs@2025-01-01' = {
  name: '${prefix}-helper'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identityId}': {} } }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 300
      replicaRetryLimit: 0
      manualTriggerConfig: { replicaCompletionCount: 1, parallelism: 1 }
      registries: [{ server: registryServer, identity: identityId }]
      secrets: empty(adminToken) ? [] : [{ name: 'database-admin-token', value: adminToken }]
    }
    template: {
      containers: [{
        name: 'helper'
        image: '${registryServer}/archive-console:${imageTag}'
        command: ['node']
        args: ['../job/scripts/azure-web-demo.mjs', mode]
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: concat([
          { name: 'AUTH_MODE', value: 'managed-identity' }
          { name: 'AZURE_CLIENT_ID', value: clientId }
          { name: 'DB_DRIVER', value: 'postgres' }
          { name: 'PGHOST', value: databaseHost }
          { name: 'PGDATABASE', value: 'executionlog' }
          { name: 'PGUSER', value: databaseUser }
          { name: 'ADMIN_NAME', value: adminName }
          { name: 'JOB_PRINCIPAL_ID', value: jobPrincipalId }
          { name: 'WEB_PRINCIPAL_ID', value: webPrincipalId }
          { name: 'TEST_STORAGE_ACCOUNT', value: storageName }
          { name: 'APP_CONFIG_ENDPOINT', value: configEndpoint }
        ], empty(adminToken) ? [] : [{ name: 'DB_ADMIN_TOKEN', secretRef: 'database-admin-token' }])
      }]
    }
  }
}
output helperName string = helper.name
