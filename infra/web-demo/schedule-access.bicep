targetScope = 'resourceGroup'

param jobName string
param webPrincipalId string

resource job 'Microsoft.App/jobs@2025-01-01' existing = { name: jobName }
resource scheduleRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, job.name, 'archive-schedule-editor')
  properties: {
    roleName: '${jobName} schedule editor'
    description: 'Read, update and start the designated archive job only.'
    type: 'CustomRole'
    permissions: [{
      actions: [
        'Microsoft.App/jobs/read'
        'Microsoft.App/jobs/write'
        'Microsoft.App/jobs/start/action'
        'Microsoft.App/jobs/executions/read'
      ]
      notActions: [], dataActions: [], notDataActions: []
    }]
    assignableScopes: [resourceGroup().id]
  }
}
resource scheduleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(job.id, webPrincipalId, scheduleRole.id)
  scope: job
  properties: {
    principalId: webPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', scheduleRole.name)
  }
}
