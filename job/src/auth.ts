import { AzureCliCredential, ManagedIdentityCredential } from "@azure/identity";

export interface TokenProvider {
  getToken(scope: string | string[]): Promise<{ token: string; expiresOnTimestamp: number } | null>;
}

export function createCredential(env: NodeJS.ProcessEnv = process.env): AzureCliCredential | ManagedIdentityCredential {
  const mode = env.AUTH_MODE ?? "managed-identity";
  if (mode === "azure-cli") return new AzureCliCredential();
  if (mode !== "managed-identity") throw new Error("AUTH_MODE must be managed-identity or azure-cli");
  if (!env.AZURE_CLIENT_ID) throw new Error("AZURE_CLIENT_ID is required for user-assigned managed identity");
  return new ManagedIdentityCredential({ clientId: env.AZURE_CLIENT_ID });
}
