targetScope = 'resourceGroup'

param location string = resourceGroup().location
@minLength(3)
@maxLength(18)
param prefix string
param tenantId string = tenant().tenantId
param operatorObjectId string
param operatorName string

var suffix = take(uniqueString(resourceGroup().id, prefix), 6)
var tags = { purpose: 'archive-console-verification' }

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  tags: tags
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}
resource appsNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${prefix}-apps-nsg'
  location: location
  tags: tags
}
resource endpointsNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${prefix}-endpoints-nsg'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'PrivateServices'
        properties: {
          priority: 100, direction: 'Inbound', access: 'Allow', protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork', sourcePortRange: '*'
          destinationAddressPrefix: '*', destinationPortRanges: ['443', '5432']
        }
      }
      {
        name: 'DenyOtherInbound'
        properties: {
          priority: 110, direction: 'Inbound', access: 'Deny', protocol: '*'
          sourceAddressPrefix: '*', sourcePortRange: '*'
          destinationAddressPrefix: '*', destinationPortRange: '*'
        }
      }
    ]
  }
}
resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${prefix}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.46.0.0/16'] }
    subnets: [
      {
        name: 'container-apps'
        properties: {
          addressPrefix: '10.46.0.0/23'
          defaultOutboundAccess: true
          networkSecurityGroup: { id: appsNsg.id }
          delegations: [{ name: 'container-apps', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      {
        name: 'endpoints'
        properties: {
          addressPrefix: '10.46.2.0/24'
          networkSecurityGroup: { id: endpointsNsg.id }
          privateEndpointNetworkPolicies: 'Enabled'
          defaultOutboundAccess: false
        }
      }
    ]
  }
}
resource appsEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: '${prefix}-env'
  location: location
  tags: tags
  properties: {
    vnetConfiguration: { infrastructureSubnetId: network.properties.subnets[0].id, internal: false }
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey }
    }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: '${replace(prefix, '-', '')}acr${suffix}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false, publicNetworkAccess: 'Enabled' }
}
resource config 'Microsoft.AppConfiguration/configurationStores@2024-05-01' = {
  name: '${prefix}-config-${suffix}'
  location: location
  tags: tags
  sku: { name: 'free' }
  properties: { disableLocalAuth: true, publicNetworkAccess: 'Enabled' }
}
resource jobIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-job-mi'
  location: location
  tags: tags
}
resource webIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-web-mi'
  location: location
  tags: tags
}
resource jobPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, jobIdentity.id, 'pull')
  scope: registry
  properties: {
    principalId: jobIdentity.properties.principalId, principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}
resource webPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, webIdentity.id, 'pull')
  scope: registry
  properties: {
    principalId: webIdentity.properties.principalId, principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}
resource configReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(config.id, jobIdentity.id, 'read')
  scope: config
  properties: {
    principalId: jobIdentity.properties.principalId, principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '516239f1-63e1-4d78-a4de-a74fb236a071')
  }
}
resource configOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(config.id, webIdentity.id, 'owner')
  scope: config
  properties: {
    principalId: webIdentity.properties.principalId, principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5ae67dd6-50cb-40e7-96ff-dc2bfa4b606b')
  }
}
resource operatorConfig 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(config.id, operatorObjectId, 'owner')
  scope: config
  properties: {
    principalId: operatorObjectId, principalType: 'User'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5ae67dd6-50cb-40e7-96ff-dc2bfa4b606b')
  }
}
resource database 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${prefix}-pg-${suffix}'
  location: location
  tags: tags
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '16'
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    authConfig: { activeDirectoryAuth: 'Enabled', passwordAuth: 'Disabled', tenantId: tenantId }
    network: { publicNetworkAccess: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
  }
}
resource databaseAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = {
  parent: database
  name: operatorObjectId
  properties: { principalName: operatorName, principalType: 'User', tenantId: tenantId }
}
resource historyDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: database
  name: 'executionlog'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
  dependsOn: [databaseAdmin]
}
resource databaseTls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: database
  name: 'require_secure_transport'
  properties: { value: 'on', source: 'user-override' }
  dependsOn: [historyDatabase]
}
resource databaseMinimumTls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: database
  name: 'ssl_min_protocol_version'
  properties: { value: 'TLSv1.2', source: 'user-override' }
  dependsOn: [databaseTls]
}
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: '${replace(prefix, '-', '')}${suffix}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    accessTier: 'Hot', minimumTlsVersion: 'TLS1_2', supportsHttpsTrafficOnly: true
    allowSharedKeyAccess: false, allowBlobPublicAccess: false, publicNetworkAccess: 'Disabled'
    networkAcls: { defaultAction: 'Deny', bypass: 'None' }
  }
}
resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}
resource sourceShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: 'source'
  properties: { enabledProtocols: 'SMB', shareQuota: 5 }
}
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}
resource archiveContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'archive'
  properties: { publicAccess: 'None' }
}
// FileREST OAuth uses a distinct fileshares RBAC path; this isolated test account
// contains only synthetic data and grants its job identity FileREST privileges.
resource fileRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, jobIdentity.id, 'files')
  scope: storage
  properties: {
    principalId: jobIdentity.properties.principalId, principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '69566ab7-960f-475b-8e7c-b3118f30c6bd')
  }
}
resource blobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(archiveContainer.id, jobIdentity.id, 'blob')
  scope: archiveContainer
  properties: {
    principalId: jobIdentity.properties.principalId, principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  }
}
var endpoints = [
  { name: 'postgres', group: 'postgresqlServer', zone: 'privatelink.postgres.database.azure.com', id: database.id }
  { name: 'file', group: 'file', zone: 'privatelink.file.${environment().suffixes.storage}', id: storage.id }
  { name: 'blob', group: 'blob', zone: 'privatelink.blob.${environment().suffixes.storage}', id: storage.id }
]
resource zones 'Microsoft.Network/privateDnsZones@2024-06-01' = [for endpoint in endpoints: {
  name: endpoint.zone
  location: 'global'
}]
resource links 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (endpoint, i) in endpoints: {
  parent: zones[i]
  name: prefix
  location: 'global'
  properties: { virtualNetwork: { id: network.id }, registrationEnabled: false }
}]
resource privateEndpoints 'Microsoft.Network/privateEndpoints@2024-05-01' = [for endpoint in endpoints: {
  name: '${prefix}-${endpoint.name}-pe'
  location: location
  properties: {
    subnet: { id: network.properties.subnets[1].id }
    privateLinkServiceConnections: [{
      name: endpoint.name
      properties: { privateLinkServiceId: endpoint.id, groupIds: [endpoint.group] }
    }]
  }
}]
resource zoneGroups 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = [for (endpoint, i) in endpoints: {
  parent: privateEndpoints[i]
  name: 'default'
  properties: { privateDnsZoneConfigs: [{ name: endpoint.name, properties: { privateDnsZoneId: zones[i].id } }] }
}]

output environmentId string = appsEnvironment.id
output domain string = appsEnvironment.properties.defaultDomain
output registryName string = registry.name
output registryServer string = registry.properties.loginServer
output configEndpoint string = config.properties.endpoint
output configName string = config.name
output databaseHost string = database.properties.fullyQualifiedDomainName
output storageName string = storage.name
output jobIdentityId string = jobIdentity.id
output jobClientId string = jobIdentity.properties.clientId
output jobPrincipalId string = jobIdentity.properties.principalId
output webIdentityId string = webIdentity.id
output webClientId string = webIdentity.properties.clientId
output webPrincipalId string = webIdentity.properties.principalId
