mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      tenant_id = "00000000-0000-0000-0000-000000000003"
    }
  }
}

variables {
  subscription_id = "00000000-0000-0000-0000-000000000000"
  source_file_share_resource_ids = [
    "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/storage-rg/providers/Microsoft.Storage/storageAccounts/sourceacct/fileServices/default/shares/source"
  ]
  destination_blob_container_resource_ids = [
    "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/storage-rg/providers/Microsoft.Storage/storageAccounts/destacct/blobServices/default/containers/archive"
  ]
  postgres_admin_object_id      = "00000000-0000-0000-0000-000000000002"
  postgres_admin_principal_name = "Archive DB Operators"
}

run "sqlite_preserves_existing_infrastructure" {
  command = plan
  assert {
    condition     = length(azurerm_postgresql_flexible_server.history) == 0 && length(azurerm_virtual_network.history) == 0 && length(azurerm_nat_gateway.history) == 0
    error_message = "The default SQLite configuration must not create PostgreSQL or networking resources."
  }
  assert {
    condition     = local.job_environment.HISTORY_DB_PROVIDER == "sqlite" && !contains(keys(local.job_environment), "HISTORY_POSTGRES_AUTH_MODE")
    error_message = "SQLite must not require Azure database authentication."
  }
}

run "private_postgres_foundations" {
  command = plan
  variables {
    history_db_provider = "postgres"
  }
  assert {
    condition     = length(azurerm_postgresql_flexible_server.history) == 1 && length(azurerm_postgresql_flexible_server_database.history) == 1 && length(azurerm_container_app_job.main) == 0
    error_message = "Provision the database foundations without starting the job."
  }
  assert {
    condition     = !azurerm_postgresql_flexible_server.history[0].public_network_access_enabled && !azurerm_postgresql_flexible_server.history[0].authentication[0].password_auth_enabled && azurerm_postgresql_flexible_server.history[0].authentication[0].active_directory_auth_enabled
    error_message = "PostgreSQL must be private and use Entra-only authentication."
  }
  assert {
    condition     = azurerm_postgresql_flexible_server_database.history[0].name == "archive_history" && azurerm_postgresql_flexible_server.history[0].version == "16"
    error_message = "Use the documented PostgreSQL version and history database."
  }
  assert {
    condition     = azurerm_subnet.job[0].address_prefixes == tolist(["10.42.0.0/23"]) && azurerm_subnet.postgres[0].address_prefixes == tolist(["10.42.2.0/27"])
    error_message = "Job and PostgreSQL must have separate, non-overlapping delegated subnets."
  }
  assert {
    condition     = length(azurerm_subnet_nat_gateway_association.job) == 1 && length(azurerm_subnet_nat_gateway_association.postgres) == 1 && !azurerm_subnet.job[0].default_outbound_access_enabled && !azurerm_subnet.postgres[0].default_outbound_access_enabled
    error_message = "Use explicit NAT egress rather than implicit default outbound access."
  }
  assert {
    condition     = azurerm_postgresql_flexible_server_active_directory_administrator.history[0].object_id == var.postgres_admin_object_id
    error_message = "The administrator must be the configured operator, not the job identity."
  }
  assert {
    condition     = local.job_environment.HISTORY_POSTGRES_AUTH_MODE == "entra" && local.job_environment.HISTORY_POSTGRES_TLS == "verify-full" && local.job_environment.HISTORY_POSTGRES_USER == "archive_job" && local.job_environment.HISTORY_POSTGRES_DATABASE == "archive_history" && local.job_environment.HISTORY_POSTGRES_SCHEMA == "archive"
    error_message = "Terraform must supply the application's documented Entra connection contract."
  }
  assert {
    condition     = !contains(keys(local.job_environment), "HISTORY_POSTGRES_URL") && !contains(keys(local.job_environment), "PGPASSWORD")
    error_message = "No database passwords or token values belong in the job environment or Terraform state."
  }
}

run "postgres_job_after_bootstrap" {
  command = plan
  variables {
    history_db_provider          = "postgres"
    create_job                   = true
    postgres_bootstrap_completed = true
  }
  assert {
    condition     = length(azurerm_container_app_job.main) == 1 && length(azurerm_container_app_job.main[0].manual_trigger_config) == 1
    error_message = "Create a manual PostgreSQL job only after principal bootstrap."
  }
}

run "reject_job_before_postgres_bootstrap" {
  command = plan
  variables {
    history_db_provider = "postgres"
    create_job          = true
  }
  expect_failures = [var.postgres_bootstrap_completed]
}

run "reject_missing_postgres_admin" {
  command = plan
  variables {
    history_db_provider           = "postgres"
    postgres_admin_object_id      = ""
    postgres_admin_principal_name = ""
  }
  expect_failures = [var.postgres_admin_object_id, var.postgres_admin_principal_name]
}

run "reject_unknown_history_provider" {
  command = plan
  variables {
    history_db_provider = "unknown"
  }
  expect_failures = [var.history_db_provider]
}

run "reject_invalid_postgres_network" {
  command = plan
  variables {
    postgres_vnet_cidr = "10.42.1.0/24"
  }
  expect_failures = [var.postgres_vnet_cidr]
}

run "reject_invalid_postgres_admin_type" {
  command = plan
  variables {
    postgres_admin_principal_type = "Application"
  }
  expect_failures = [var.postgres_admin_principal_type]
}
