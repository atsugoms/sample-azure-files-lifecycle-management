targetScope = 'resourceGroup'

param location string = resourceGroup().location
param prefix string
param environmentId string
param domain string
param registryServer string
param imageTag string
param configEndpoint string
param databaseHost string
param jobIdentityId string
param jobClientId string
param webIdentityId string
param webClientId string
param webPrincipalId string
param allowedUserId string
param tenantId string = tenant().tenantId
param authenticationClientId string
@secure()
param authenticationClientSecret string

var image = '${registryServer}/archive-console:${imageTag}'
var origin = 'https://${prefix}-web.${domain}'
var common = [
  { name: 'AUTH_MODE', value: 'managed-identity' }
  { name: 'APP_CONFIG_ENDPOINT', value: configEndpoint }
  { name: 'APP_CONFIG_KEY', value: 'archive:settings' }
  { name: 'APP_CONFIG_LABEL', value: 'validation' }
  { name: 'DB_DRIVER', value: 'postgres' }
  { name: 'PGHOST', value: databaseHost }
  { name: 'PGDATABASE', value: 'executionlog' }
]

resource web 'Microsoft.App/containerApps@2025-01-01' = {
  name: '${prefix}-web'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${webIdentityId}': {} } }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: [{ name: 'entra-client-secret', value: authenticationClientSecret }]
      registries: [{ server: registryServer, identity: webIdentityId }]
      ingress: { external: true, targetPort: 8080, transport: 'http', allowInsecure: false }
    }
    template: {
      containers: [{
        name: 'web'
        image: image
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: concat(common, [
          { name: 'AZURE_CLIENT_ID', value: webClientId }
          { name: 'PGUSER', value: 'archive_web' }
          { name: 'WEB_HOST_MODE', value: 'container-apps' }
          { name: 'WEB_PUBLIC_ORIGIN', value: origin }
          { name: 'WEB_AUTH_TENANT_ID', value: tenantId }
          { name: 'WEB_AUTH_ALLOWED_OBJECT_IDS', value: allowedUserId }
          { name: 'PORT', value: '8080' }
          { name: 'WEB_SCHEDULE_JOB_RESOURCE_ID', value: resourceId('Microsoft.App/jobs', '${prefix}-job') }
        ])
        probes: [
          {
            type: 'Liveness'
            httpGet: { path: '/healthz', port: 8080, scheme: 'HTTP' }
            initialDelaySeconds: 30
            periodSeconds: 30
          }
          {
            type: 'Readiness'
            httpGet: { path: '/healthz', port: 8080, scheme: 'HTTP' }
            initialDelaySeconds: 5
            periodSeconds: 10
          }
        ]
      }]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}
resource auth 'Microsoft.App/containerApps/authConfigs@2025-01-01' = {
  parent: web
  name: 'current'
  properties: {
    platform: { enabled: true }
    globalValidation: {
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
      excludedPaths: ['/healthz']
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: authenticationClientId
          clientSecretSettingName: 'entra-client-secret'
          openIdIssuer: '${environment().authentication.loginEndpoint}${tenantId}/v2.0'
        }
        validation: { allowedAudiences: [authenticationClientId, 'api://${authenticationClientId}'] }
      }
    }
    httpSettings: { requireHttps: true }
  }
}
resource job 'Microsoft.App/jobs@2025-01-01' = {
  name: '${prefix}-job'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${jobIdentityId}': {} } }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: { replicaCompletionCount: 1, parallelism: 1 }
      registries: [{ server: registryServer, identity: jobIdentityId }]
    }
    template: {
      containers: [{
        name: 'archive'
        image: image
        command: ['node']
        args: ['../job/dist/src/index.js']
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: concat(common, [
          { name: 'AZURE_CLIENT_ID', value: jobClientId }
          { name: 'PGUSER', value: 'archive_job' }
          { name: 'JOB_TIMEOUT_SECONDS', value: '540' }
        ])
      }]
    }
  }
}
module scheduleAccess './schedule-access.bicep' = {
  name: '${prefix}-schedule-access'
  params: { jobName: job.name, webPrincipalId: webPrincipalId }
}
output webUrl string = origin
output jobName string = job.name
