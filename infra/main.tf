locals {
  suffix = substr(sha1("${lower(var.subscription_id)}:${var.name_prefix}"), 0, 8)
  # FileREST OAuth uses "fileshares" scopes, unlike control-plane "shares" IDs.
  file_share_scopes = toset([
    for id in setunion(var.source_file_share_resource_ids, var.destination_file_share_resource_ids) :
    replace(lower(id), "fileservices/default/shares/", "fileservices/default/fileshares/")
  ])
  blob_container_scopes = toset([for id in var.destination_blob_container_resource_ids : lower(id)])
  container_image       = "${azurerm_container_registry.main.login_server}/files-archive:${var.image_tag}"
  job_environment = {
    AZURE_CLIENT_ID     = azurerm_user_assigned_identity.job.client_id
    APP_CONFIG_ENDPOINT = azurerm_app_configuration.main.endpoint
    APP_CONFIG_KEY      = var.app_config_key
    APP_CONFIG_LABEL    = var.app_config_label
    AUTH_MODE           = "managed-identity"
    JOB_TIMEOUT_SECONDS = tostring(var.job_timeout_seconds)
  }
}

resource "azurerm_resource_group" "main" {
  name     = coalesce(var.resource_group_name, "${var.name_prefix}-rg")
  location = var.location
  tags     = var.tags
}

resource "azurerm_log_analytics_workspace" "main" {
  name                = "${var.name_prefix}-logs"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = var.tags
}

resource "azurerm_container_app_environment" "main" {
  name                       = "${var.name_prefix}-env"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
  tags                       = var.tags

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
    minimum_count         = 0
    maximum_count         = 0
  }
}

resource "azurerm_container_registry" "main" {
  name                          = "${replace(var.name_prefix, "-", "")}acr${local.suffix}"
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  sku                           = "Basic"
  admin_enabled                 = false
  public_network_access_enabled = true
  tags                          = var.tags
}

resource "azurerm_app_configuration" "main" {
  name                       = "${var.name_prefix}-config-${local.suffix}"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  sku                        = var.app_configuration_sku
  local_auth_enabled         = false
  public_network_access      = "Enabled"
  purge_protection_enabled   = var.app_configuration_purge_protection_enabled
  soft_delete_retention_days = var.app_configuration_sku == "standard" ? 7 : null
  tags                       = var.tags
}

resource "azurerm_user_assigned_identity" "job" {
  name                = "${var.name_prefix}-job-mi"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                            = azurerm_container_registry.main.id
  role_definition_name             = "AcrPull"
  principal_id                     = azurerm_user_assigned_identity.job.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "configuration_reader" {
  scope                            = azurerm_app_configuration.main.id
  role_definition_name             = "App Configuration Data Reader"
  principal_id                     = azurerm_user_assigned_identity.job.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "file_contributor" {
  for_each                         = local.file_share_scopes
  scope                            = each.value
  role_definition_name             = "Storage File Data Privileged Contributor"
  principal_id                     = azurerm_user_assigned_identity.job.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "blob_contributor" {
  for_each                         = local.blob_container_scopes
  scope                            = each.value
  role_definition_name             = "Storage Blob Data Contributor"
  principal_id                     = azurerm_user_assigned_identity.job.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "configuration_operator" {
  for_each             = toset([for id in var.configuration_operator_object_ids : lower(id)])
  scope                = azurerm_app_configuration.main.id
  role_definition_name = "App Configuration Data Owner"
  principal_id         = each.value
}

resource "azurerm_container_app_job" "main" {
  count                        = var.create_job ? 1 : 0
  name                         = "${var.name_prefix}-job"
  location                     = azurerm_resource_group.main.location
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = var.replica_timeout_seconds
  replica_retry_limit          = 0
  tags                         = var.tags

  dynamic "manual_trigger_config" {
    for_each = var.enable_schedule ? [] : [1]
    content {
      parallelism              = 1
      replica_completion_count = 1
    }
  }

  dynamic "schedule_trigger_config" {
    for_each = var.enable_schedule ? [1] : []
    content {
      cron_expression          = "0 18 * * *"
      parallelism              = 1
      replica_completion_count = 1
    }
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.job.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.job.id
  }

  template {
    container {
      name   = "archive"
      image  = local.container_image
      cpu    = 0.5
      memory = "1Gi"

      dynamic "env" {
        for_each = local.job_environment
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }

  depends_on = [
    azurerm_role_assignment.acr_pull,
    azurerm_role_assignment.configuration_reader,
    azurerm_role_assignment.file_contributor,
    azurerm_role_assignment.blob_contributor,
  ]
}
