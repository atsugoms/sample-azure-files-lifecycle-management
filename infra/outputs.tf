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

output "postgres_host" {
  description = "Private PostgreSQL hostname; null in SQLite mode."
  value       = local.postgres_enabled ? azurerm_postgresql_flexible_server.history[0].fqdn : null
}

output "postgres_bootstrap_sql" {
  description = "Review and run once as the configured Entra administrator over private networking, connected to postgres."
  value = local.postgres_enabled ? templatefile("${path.module}/bootstrap-postgres.sql.tftpl", {
    job_principal_id = azurerm_user_assigned_identity.job.principal_id
  }) : null
}

output "postgres_vnet_id" {
  description = "VNet for private bootstrap access; null in SQLite mode."
  value       = local.postgres_enabled ? azurerm_virtual_network.history[0].id : null
}

output "job_egress_ip" {
  description = "NAT outbound IP for PostgreSQL-mode jobs; does not itself permit access through external firewalls."
  value       = local.postgres_enabled ? azurerm_public_ip.egress[0].ip_address : null
}
