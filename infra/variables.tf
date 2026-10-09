variable "subscription_id" {
  description = "Subscription in which to create the job foundations."
  type        = string
  nullable    = false
  validation {
    condition     = can(regex("(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.subscription_id))
    error_message = "subscription_id must be a subscription UUID."
  }
}

variable "resource_group_name" {
  description = "Optional exact resource group name; defaults to <name_prefix>-rg."
  type        = string
  default     = null
  validation {
    condition     = var.resource_group_name == null ? true : can(regex("^[a-zA-Z0-9._()-]{1,90}$", var.resource_group_name))
    error_message = "Use a valid Azure resource group name (1-90 characters)."
  }
}

variable "location" {
  description = "Azure region for all new resources."
  type        = string
  default     = "japaneast"
  nullable    = false
}

variable "name_prefix" {
  description = "Lowercase resource prefix (3-18 characters); change for independent environments."
  type        = string
  default     = "filesarchive"
  nullable    = false
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,16}[a-z0-9]$", var.name_prefix)) && !strcontains(var.name_prefix, "--")
    error_message = "Use 3-18 lowercase letters, digits or single hyphens; start with a letter and end with a letter or digit."
  }
}

variable "create_job" {
  description = "Create the job only after pushing the image and publishing configuration."
  type        = bool
  default     = false
  nullable    = false
}

variable "enable_schedule" {
  description = "Enable the daily 18:00 UTC (03:00 JST) schedule; false creates a manual job."
  type        = bool
  default     = false
  nullable    = false
  validation {
    condition     = !var.enable_schedule || var.create_job
    error_message = "enable_schedule requires create_job = true."
  }
}

variable "image_tag" {
  description = "Already-pushed image tag in the files-archive repository. Use a new immutable tag for each release."
  type        = string
  default     = "v1"
  nullable    = false
  validation {
    condition     = can(regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.image_tag))
    error_message = "image_tag must be a valid container image tag."
  }
}

variable "app_config_key" {
  description = "App Configuration key holding the complete settings JSON."
  type        = string
  default     = "archive:settings"
  nullable    = false
  validation {
    condition     = length(trimspace(var.app_config_key)) > 0
    error_message = "app_config_key must not be empty."
  }
}

variable "app_config_label" {
  description = "App Configuration label read by the job."
  type        = string
  default     = "production"
  nullable    = false
  validation {
    condition     = length(trimspace(var.app_config_label)) > 0
    error_message = "app_config_label must not be empty."
  }
}

variable "app_configuration_sku" {
  description = "Free is suitable for a sample; standard supports production protection and higher limits."
  type        = string
  default     = "free"
  nullable    = false
  validation {
    condition     = contains(["free", "standard"], var.app_configuration_sku)
    error_message = "app_configuration_sku must be free or standard."
  }
}

variable "app_configuration_purge_protection_enabled" {
  description = "Irreversible purge protection; requires the standard SKU."
  type        = bool
  default     = false
  nullable    = false
  validation {
    condition     = !var.app_configuration_purge_protection_enabled || var.app_configuration_sku == "standard"
    error_message = "Purge protection requires app_configuration_sku = standard."
  }
}

variable "job_timeout_seconds" {
  description = "Application deadline; leave headroom before the platform terminates the replica."
  type        = number
  default     = 3300
  nullable    = false
  validation {
    condition     = var.job_timeout_seconds > 0 && floor(var.job_timeout_seconds) == var.job_timeout_seconds && var.job_timeout_seconds < var.replica_timeout_seconds
    error_message = "job_timeout_seconds must be a positive integer less than replica_timeout_seconds."
  }
}

variable "replica_timeout_seconds" {
  description = "Platform replica deadline; kept below the daily schedule interval."
  type        = number
  default     = 3600
  nullable    = false
  validation {
    condition     = var.replica_timeout_seconds > 0 && var.replica_timeout_seconds < 86400 && floor(var.replica_timeout_seconds) == var.replica_timeout_seconds
    error_message = "replica_timeout_seconds must be an integer between 1 and 86399."
  }
}

variable "source_file_share_resource_ids" {
  description = "Existing control-plane Azure Files share ARM IDs (/shares/). Converted to /fileshares/ for FileREST OAuth RBAC; no accounts or shares are created."
  type        = set(string)
  nullable    = false
  validation {
    condition = length(var.source_file_share_resource_ids) > 0 && alltrue([
      for id in var.source_file_share_resource_ids : can(regex("(?i)^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/resourceGroups/[^/]+/providers/Microsoft\\.Storage/storageAccounts/[a-z0-9]{3,24}/fileServices/default/shares/[^/]+$", id))
    ])
    error_message = "Provide at least one share-scoped ARM ID ending in /fileServices/default/shares/<share>, not an account ID or URL."
  }
}

variable "destination_file_share_resource_ids" {
  description = "Existing destination control-plane Files share ARM IDs (/shares/), converted to /fileshares/ for FileREST OAuth RBAC. Empty for blob-only destinations."
  type        = set(string)
  default     = []
  nullable    = false
  validation {
    condition = alltrue([
      for id in var.destination_file_share_resource_ids : can(regex("(?i)^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/resourceGroups/[^/]+/providers/Microsoft\\.Storage/storageAccounts/[a-z0-9]{3,24}/fileServices/default/shares/[^/]+$", id))
    ])
    error_message = "Each destination Files scope must end in /fileServices/default/shares/<share>."
  }
}

variable "destination_blob_container_resource_ids" {
  description = "Existing destination blob container ARM IDs (empty for Files-only destinations)."
  type        = set(string)
  default     = []
  nullable    = false
  validation {
    condition = length(setunion(var.destination_file_share_resource_ids, var.destination_blob_container_resource_ids)) > 0 && alltrue([
      for id in var.destination_blob_container_resource_ids : can(regex("(?i)^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/resourceGroups/[^/]+/providers/Microsoft\\.Storage/storageAccounts/[a-z0-9]{3,24}/blobServices/default/containers/[^/]+$", id))
    ])
    error_message = "Provide at least one destination Files share or blob container; blob scopes must end in /blobServices/default/containers/<container>."
  }
}

variable "configuration_operator_object_ids" {
  description = "Optional Entra user/group/service principal object IDs granted App Configuration Data Owner."
  type        = set(string)
  default     = []
  nullable    = false
  validation {
    condition = alltrue([
      for id in var.configuration_operator_object_ids : can(regex("(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", id))
    ])
    error_message = "Operator IDs must be Entra object UUIDs, not application/client IDs."
  }
}

variable "tags" {
  description = "Tags applied to newly created resources."
  type        = map(string)
  default     = {}
  nullable    = false
}
