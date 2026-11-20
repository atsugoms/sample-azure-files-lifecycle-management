import { AzureCliCredential, ManagedIdentityCredential } from "@azure/identity";

export function readAuthMode(env: NodeJS.ProcessEnv): "managed-identity" | "azure-cli" {
  const mode = env.AUTH_MODE ?? "managed-identity";
  if (mode !== "managed-identity" && mode !== "azure-cli") {
    throw new Error("AUTH_MODE must be managed-identity or azure-cli");
  }
  return mode;
}

export function createCredential(env: NodeJS.ProcessEnv) {
  if (readAuthMode(env) === "azure-cli") return new AzureCliCredential();
  if (!env.AZURE_CLIENT_ID) {
    throw new Error("AZURE_CLIENT_ID is required for user-assigned managed identity");
  }
  return new ManagedIdentityCredential({ clientId: env.AZURE_CLIENT_ID });
}
