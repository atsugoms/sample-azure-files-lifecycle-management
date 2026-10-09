mock_provider "azurerm" {}

variables {
  subscription_id = "00000000-0000-0000-0000-000000000000"
  source_file_share_resource_ids = [
    "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/storage-rg/providers/Microsoft.Storage/storageAccounts/sourceacct/fileServices/default/shares/source"
  ]
  destination_blob_container_resource_ids = [
    "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/storage-rg/providers/Microsoft.Storage/storageAccounts/destacct/blobServices/default/containers/archive"
  ]
}

run "foundations_only_by_default" {
  command = plan

  assert {
    condition     = length(azurerm_container_app_job.main) == 0
    error_message = "Bootstrap must not create a job before image/configuration publication."
  }
  assert {
    condition     = azurerm_container_registry.main.admin_enabled == false && azurerm_app_configuration.main.local_auth_enabled == false
    error_message = "Local credential authentication must remain disabled."
  }
  assert {
    condition     = length(azurerm_role_assignment.file_contributor) == 1 && length(azurerm_role_assignment.blob_contributor) == 1
    error_message = "Only the explicitly supplied Storage scopes should receive permissions."
  }
  assert {
    condition = toset([for role in azurerm_role_assignment.file_contributor : role.scope]) == toset([
      "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/storage-rg/providers/microsoft.storage/storageaccounts/sourceacct/fileservices/default/fileshares/source"
    ])
    error_message = "Files OAuth role scopes must use the data-plane /fileshares/ path, not /shares/."
  }
  assert {
    condition = toset([for role in azurerm_role_assignment.blob_contributor : role.scope]) == toset([
      "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/storage-rg/providers/microsoft.storage/storageaccounts/destacct/blobservices/default/containers/archive"
    ])
    error_message = "Files scope conversion must not change blob container scope paths."
  }
}

run "normalize_source_and_destination_files_scopes" {
  command = plan
  variables {
    destination_file_share_resource_ids = [
      "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/storage-rg/providers/Microsoft.Storage/storageAccounts/SOURCEACCT/fileServices/default/shares/source",
      "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/storage-rg/providers/Microsoft.Storage/storageAccounts/destacct/fileServices/default/shares/archive"
    ]
    destination_blob_container_resource_ids = []
  }
  assert {
    condition = toset([for role in azurerm_role_assignment.file_contributor : role.scope]) == toset([
      "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/storage-rg/providers/microsoft.storage/storageaccounts/sourceacct/fileservices/default/fileshares/source",
      "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/storage-rg/providers/microsoft.storage/storageaccounts/destacct/fileservices/default/fileshares/archive"
    ])
    error_message = "Normalize both source and destination Files scopes and deduplicate case-insensitive IDs."
  }
}

run "manual_job_before_schedule" {
  command = plan
  variables {
    create_job = true
  }

  assert {
    condition     = length(azurerm_container_app_job.main[0].manual_trigger_config) == 1 && length(azurerm_container_app_job.main[0].schedule_trigger_config) == 0
    error_message = "An explicitly created job must default to manual execution."
  }
  assert {
    condition     = azurerm_container_app_job.main[0].replica_retry_limit == 0 && azurerm_container_app_job.main[0].replica_timeout_in_seconds == 3600
    error_message = "The default job must have no retry and a one-hour replica timeout."
  }
  assert {
    condition     = azurerm_container_app_job.main[0].workload_profile_name == "Consumption" && one(azurerm_container_app_environment.main.workload_profile).name == "Consumption"
    error_message = "Explicit Consumption profiles must match Azure defaults to avoid post-apply drift."
  }
  assert {
    condition = alltrue([
      for env in azurerm_container_app_job.main[0].template[0].container[0].env :
      env.name != "JOB_TIMEOUT_SECONDS" || env.value == "3300"
    ])
    error_message = "The application timeout must leave time before platform termination."
  }
  assert {
    condition = length([
      for env in azurerm_container_app_job.main[0].template[0].container[0].env :
      env if env.name == "APP_CONFIG_KEY" && env.value == "archive:settings"
      ]) == 1 && alltrue([
      for env in azurerm_container_app_job.main[0].template[0].container[0].env :
      env.name != "APP_CONFIG_PREFIX"
    ])
    error_message = "The job must read one JSON setting, not a prefix of split keys."
  }
}

run "exact_resource_group_name" {
  command = plan
  variables {
    resource_group_name = "custom-validation-rg"
  }
  assert {
    condition     = azurerm_resource_group.main.name == "custom-validation-rg"
    error_message = "The explicit resource group name must override the generated name."
  }
}

run "explicit_daily_schedule" {
  command = plan
  variables {
    create_job      = true
    enable_schedule = true
  }
  assert {
    condition     = length(azurerm_container_app_job.main[0].manual_trigger_config) == 0 && azurerm_container_app_job.main[0].schedule_trigger_config[0].cron_expression == "0 18 * * *"
    error_message = "The enabled schedule must run at 18:00 UTC (03:00 JST)."
  }
}

run "reject_account_wide_storage_scope" {
  command = plan
  variables {
    source_file_share_resource_ids = [
      "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/storage-rg/providers/Microsoft.Storage/storageAccounts/sourceacct"
    ]
  }
  expect_failures = [var.source_file_share_resource_ids]
}

run "reject_missing_destination" {
  command = plan
  variables {
    destination_blob_container_resource_ids = []
  }
  expect_failures = [var.destination_blob_container_resource_ids]
}

run "reject_timeout_without_shutdown_headroom" {
  command = plan
  variables {
    job_timeout_seconds = 3600
  }
  expect_failures = [var.job_timeout_seconds]
}

run "reject_schedule_without_job" {
  command = plan
  variables {
    enable_schedule = true
  }
  expect_failures = [var.enable_schedule]
}

run "reject_purge_protection_on_free_sku" {
  command = plan
  variables {
    app_configuration_purge_protection_enabled = true
  }
  expect_failures = [var.app_configuration_purge_protection_enabled]
}

run "reject_empty_configuration_key" {
  command = plan
  variables {
    app_config_key = " "
  }
  expect_failures = [var.app_config_key]
}
