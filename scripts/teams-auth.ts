#!/usr/bin/env npx tsx
/**
 * Teams device code authentication script.
 *
 * Usage:
 *   npx tsx scripts/teams-auth.ts <instance-name> <tenant-id> <client-id>
 *
 * Example:
 *   npx tsx scripts/teams-auth.ts work 12345-tenant-id 67890-client-id
 *
 * Authenticates via device code flow and caches tokens to
 * store/auth/<instance-name>/msal-cache.json
 */
import fs from "fs";
import path from "path";
import { PublicClientApplication } from "@azure/msal-node";

const [instanceName, tenantId, clientId] = process.argv.slice(2);

if (!instanceName || !tenantId || !clientId) {
  console.error(
    "Usage: npx tsx scripts/teams-auth.ts <instance-name> <tenant-id> <client-id>"
  );
  process.exit(1);
}

const authDir = path.join("store", "auth", instanceName);
fs.mkdirSync(authDir, { recursive: true });
const cachePath = path.join(authDir, "msal-cache.json");

const pca = new PublicClientApplication({
  auth: {
    clientId,
    authority: `https://login.microsoftonline.com/${tenantId}`,
  },
  cache: {
    cachePlugin: {
      beforeCacheAccess: async (ctx) => {
        if (fs.existsSync(cachePath)) {
          ctx.tokenCache.deserialize(fs.readFileSync(cachePath, "utf-8"));
        }
      },
      afterCacheAccess: async (ctx) => {
        if (ctx.cacheHasChanged) {
          fs.writeFileSync(cachePath, ctx.tokenCache.serialize());
        }
      },
    },
  },
});

// Try silent auth first (from cached tokens)
const accounts = await pca.getTokenCache().getAllAccounts();
if (accounts.length > 0) {
  try {
    const silent = await pca.acquireTokenSilent({
      account: accounts[0],
      scopes: ["Chat.Read", "Chat.ReadWrite", "ChatMessage.Send", "User.Read"],
    });
    console.log(
      `Already authenticated as: ${silent.account?.name || silent.account?.username}`
    );
    console.log(`Token cached at: ${cachePath}`);
    process.exit(0);
  } catch {
    console.log("Cached token expired, starting device code flow...\n");
  }
}

const result = await pca.acquireTokenByDeviceCode({
  scopes: ["Chat.Read", "Chat.ReadWrite", "ChatMessage.Send", "User.Read"],
  deviceCodeCallback: (response) => {
    console.log(response.message);
    console.log();
  },
});

console.log(
  `Authenticated as: ${result.account?.name || result.account?.username}`
);
console.log(`Token cached at: ${cachePath}`);
