output "resource_group_name" {
  description = "Resource group containing the job foundations."
  value       = azurerm_resource_group.main.name
}

output "container_registry_name" {
  description = "ACR name for image build/push commands."
  value       = azurerm_container_registry.main.name
}

output "container_registry_login_server" {
  description = "ACR hostname (without protocol)."
  value       = azurerm_container_registry.main.login_server
}

output "container_image" {
  description = "Complete image reference expected by the job."
  value       = local.container_image
}

output "app_configuration_name" {
  description = "App Configuration store name."
  value       = azurerm_app_configuration.main.name
}

output "app_config_endpoint" {
  description = "HTTPS endpoint passed as APP_CONFIG_ENDPOINT."
  value       = azurerm_app_configuration.main.endpoint
}

output "job_identity_client_id" {
  description = "User-assigned managed identity client ID passed as AZURE_CLIENT_ID."
  value       = azurerm_user_assigned_identity.job.client_id
}

output "job_identity_principal_id" {
  description = "Managed identity service principal object ID for RBAC diagnostics."
  value       = azurerm_user_assigned_identity.job.principal_id
}

output "job_environment" {
  description = "Non-secret job environment contract, available before job creation."
  value       = local.job_environment
}

output "job_name" {
  description = "Job name; null until create_job is enabled."
  value       = try(azurerm_container_app_job.main[0].name, null)
}

output "job_id" {
  description = "Job resource ID; null until create_job is enabled."
  value       = try(azurerm_container_app_job.main[0].id, null)
}

output "log_analytics_workspace_id" {
  description = "Workspace ARM ID for operational console/system logs (30-day retention)."
  value       = azurerm_log_analytics_workspace.main.id
}
