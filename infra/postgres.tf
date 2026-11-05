locals {
  postgres_enabled = var.history_db_provider == "postgres"
}

data "azurerm_client_config" "current" {
  count = local.postgres_enabled ? 1 : 0
}

resource "azurerm_virtual_network" "history" {
  count               = local.postgres_enabled ? 1 : 0
  name                = "${var.name_prefix}-vnet"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  address_space       = [var.postgres_vnet_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "job" {
  count                           = local.postgres_enabled ? 1 : 0
  name                            = "container-apps"
  resource_group_name             = azurerm_resource_group.main.name
  virtual_network_name            = azurerm_virtual_network.history[0].name
  address_prefixes                = [cidrsubnet(var.postgres_vnet_cidr, 7, 0)]
  default_outbound_access_enabled = false

  delegation {
    name = "container-apps"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "postgres" {
  count                           = local.postgres_enabled ? 1 : 0
  name                            = "postgres"
  resource_group_name             = azurerm_resource_group.main.name
  virtual_network_name            = azurerm_virtual_network.history[0].name
  address_prefixes                = [cidrsubnet(var.postgres_vnet_cidr, 11, 16)]
  default_outbound_access_enabled = false
  service_endpoints               = ["Microsoft.Storage"]

  delegation {
    name = "postgres"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_public_ip" "egress" {
  count               = local.postgres_enabled ? 1 : 0
  name                = "${var.name_prefix}-egress"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

resource "azurerm_nat_gateway" "history" {
  count               = local.postgres_enabled ? 1 : 0
  name                = "${var.name_prefix}-nat"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku_name            = "Standard"
  tags                = var.tags
}

resource "azurerm_nat_gateway_public_ip_association" "history" {
  count                = local.postgres_enabled ? 1 : 0
  nat_gateway_id       = azurerm_nat_gateway.history[0].id
  public_ip_address_id = azurerm_public_ip.egress[0].id
}

resource "azurerm_subnet_nat_gateway_association" "job" {
  count          = local.postgres_enabled ? 1 : 0
  subnet_id      = azurerm_subnet.job[0].id
  nat_gateway_id = azurerm_nat_gateway.history[0].id
  depends_on     = [azurerm_nat_gateway_public_ip_association.history]
}

resource "azurerm_subnet_nat_gateway_association" "postgres" {
  count          = local.postgres_enabled ? 1 : 0
  subnet_id      = azurerm_subnet.postgres[0].id
  nat_gateway_id = azurerm_nat_gateway.history[0].id
  depends_on     = [azurerm_nat_gateway_public_ip_association.history]
}

resource "azurerm_private_dns_zone" "postgres" {
  count               = local.postgres_enabled ? 1 : 0
  name                = "${var.name_prefix}.postgres.database.azure.com"
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  count                 = local.postgres_enabled ? 1 : 0
  name                  = "${var.name_prefix}-postgres"
  resource_group_name   = azurerm_resource_group.main.name
  private_dns_zone_name = azurerm_private_dns_zone.postgres[0].name
  virtual_network_id    = azurerm_virtual_network.history[0].id
  registration_enabled  = false
  tags                  = var.tags
}

resource "azurerm_postgresql_flexible_server" "history" {
  count                         = local.postgres_enabled ? 1 : 0
  name                          = "${var.name_prefix}-pg-${local.suffix}"
  resource_group_name           = azurerm_resource_group.main.name
  location                      = azurerm_resource_group.main.location
  version                       = "16"
  sku_name                      = var.postgres_sku_name
  storage_mb                    = 32768
  auto_grow_enabled             = true
  backup_retention_days         = 7
  geo_redundant_backup_enabled  = false
  public_network_access_enabled = false
  delegated_subnet_id           = azurerm_subnet.postgres[0].id
  private_dns_zone_id           = azurerm_private_dns_zone.postgres[0].id
  tags                          = var.tags

  authentication {
    active_directory_auth_enabled = true
    password_auth_enabled         = false
    tenant_id                     = data.azurerm_client_config.current[0].tenant_id
  }

  lifecycle {
    ignore_changes = [storage_mb]
  }

  depends_on = [
    azurerm_private_dns_zone_virtual_network_link.postgres,
    azurerm_subnet_nat_gateway_association.postgres,
  ]
}

resource "azurerm_postgresql_flexible_server_database" "history" {
  count     = local.postgres_enabled ? 1 : 0
  name      = "archive_history"
  server_id = azurerm_postgresql_flexible_server.history[0].id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

resource "azurerm_postgresql_flexible_server_active_directory_administrator" "history" {
  count               = local.postgres_enabled ? 1 : 0
  server_name         = azurerm_postgresql_flexible_server.history[0].name
  resource_group_name = azurerm_resource_group.main.name
  tenant_id           = data.azurerm_client_config.current[0].tenant_id
  object_id           = var.postgres_admin_object_id
  principal_name      = var.postgres_admin_principal_name
  principal_type      = var.postgres_admin_principal_type

  lifecycle {
    precondition {
      condition     = lower(var.postgres_admin_object_id) != lower(azurerm_user_assigned_identity.job.principal_id)
      error_message = "The job identity must not be the PostgreSQL administrator."
    }
  }
}
