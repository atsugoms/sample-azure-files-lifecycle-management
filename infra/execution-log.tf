data "azurerm_client_config" "current" {}

resource "azurerm_virtual_network" "job" {
  name                = "${var.name_prefix}-vnet"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  address_space       = [var.job_vnet_address_space]
  tags                = var.tags
}

resource "azurerm_subnet" "job" {
  name                 = "container-apps"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.job.name
  address_prefixes     = [cidrsubnet(var.job_vnet_address_space, 7, 0)]

  delegation {
    name = "container-apps"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "database" {
  name                              = "database-endpoints"
  resource_group_name               = azurerm_resource_group.main.name
  virtual_network_name              = azurerm_virtual_network.job.name
  address_prefixes                  = [cidrsubnet(var.job_vnet_address_space, 8, 2)]
  private_endpoint_network_policies = "Enabled"
}

resource "azurerm_network_security_group" "job" {
  name                = "${var.name_prefix}-job-nsg"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  tags                = var.tags
}

resource "azurerm_subnet_network_security_group_association" "job" {
  subnet_id                 = azurerm_subnet.job.id
  network_security_group_id = azurerm_network_security_group.job.id
}

resource "azurerm_network_security_group" "database" {
  name                = "${var.name_prefix}-database-nsg"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  tags                = var.tags

  security_rule {
    name                       = "PostgreSQLFromPrivateNetwork"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "5432"
    source_address_prefix      = "VirtualNetwork"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "DenyOtherInbound"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "database" {
  subnet_id                 = azurerm_subnet.database.id
  network_security_group_id = azurerm_network_security_group.database.id
}

resource "azurerm_postgresql_flexible_server" "history" {
  #checkov:skip=CKV_AZURE_136:Single-region sample uses seven-day local backups; production DR requires a separate backup design.
  name                          = "${var.name_prefix}-psql-${local.suffix}"
  resource_group_name           = azurerm_resource_group.main.name
  location                      = azurerm_resource_group.main.location
  version                       = "16"
  sku_name                      = var.postgres_sku_name
  storage_mb                    = 32768
  backup_retention_days         = 7
  geo_redundant_backup_enabled  = false
  public_network_access_enabled = false
  tags                          = var.tags

  authentication {
    active_directory_auth_enabled = true
    password_auth_enabled         = false
    tenant_id                     = data.azurerm_client_config.current.tenant_id
  }

  lifecycle {
    # Keep Azure's assigned zone; clearing it on a later apply is unsupported.
    ignore_changes = [zone]
  }
}

resource "azurerm_postgresql_flexible_server_database" "history" {
  name      = "executionlog"
  server_id = azurerm_postgresql_flexible_server.history.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

resource "azurerm_postgresql_flexible_server_active_directory_administrator" "history" {
  server_name         = azurerm_postgresql_flexible_server.history.name
  resource_group_name = azurerm_resource_group.main.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  object_id           = var.postgres_admin_object_id
  principal_name      = var.postgres_admin_principal_name
  principal_type      = var.postgres_admin_principal_type
}

resource "azurerm_postgresql_flexible_server_configuration" "require_tls" {
  name      = "require_secure_transport"
  server_id = azurerm_postgresql_flexible_server.history.id
  value     = "on"
}

resource "azurerm_postgresql_flexible_server_configuration" "minimum_tls" {
  name      = "ssl_min_protocol_version"
  server_id = azurerm_postgresql_flexible_server.history.id
  value     = "TLSv1.2"
}

resource "azurerm_private_dns_zone" "postgres" {
  name                = "privatelink.postgres.database.azure.com"
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  name                  = "${var.name_prefix}-postgres"
  resource_group_name   = azurerm_resource_group.main.name
  private_dns_zone_name = azurerm_private_dns_zone.postgres.name
  virtual_network_id    = azurerm_virtual_network.job.id
  registration_enabled  = false
  tags                  = var.tags
}

resource "azurerm_private_endpoint" "postgres" {
  name                = "${var.name_prefix}-postgres-pe"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  subnet_id           = azurerm_subnet.database.id
  tags                = var.tags

  private_service_connection {
    name                           = "postgres"
    private_connection_resource_id = azurerm_postgresql_flexible_server.history.id
    subresource_names              = ["postgresqlServer"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "postgres"
    private_dns_zone_ids = [azurerm_private_dns_zone.postgres.id]
  }
}

resource "azurerm_monitor_diagnostic_setting" "postgres" {
  name                       = "execution-log-diagnostics"
  target_resource_id         = azurerm_postgresql_flexible_server.history.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "PostgreSQLLogs"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}
