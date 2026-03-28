#!/usr/bin/env npx tsx
/**
 * Send a test HTML message to Teams to verify formatting.
 * Usage: npx tsx scripts/teams-test-html.ts
 */
import fs from "fs";
import path from "path";
import { PublicClientApplication } from "@azure/msal-node";
import { Client } from "@microsoft/microsoft-graph-client";

const instanceName = "aicx";
const cachePath = path.join("store", "auth", instanceName, "msal-cache.json");

const instances = JSON.parse(fs.readFileSync("data/teams-instances.json", "utf-8"));
const inst = instances.find((i: { name: string }) => i.name === instanceName);

const pca = new PublicClientApplication({
  auth: { clientId: inst.clientId, authority: `https://login.microsoftonline.com/${inst.tenantId}` },
  cache: {
    cachePlugin: {
      beforeCacheAccess: async (ctx) => {
        if (fs.existsSync(cachePath)) ctx.tokenCache.deserialize(fs.readFileSync(cachePath, "utf-8"));
      },
      afterCacheAccess: async (ctx) => {
        if (ctx.cacheHasChanged) fs.writeFileSync(cachePath, ctx.tokenCache.serialize());
      },
    },
  },
});

const accounts = await pca.getTokenCache().getAllAccounts();
const token = await pca.acquireTokenSilent({
  account: accounts[0],
  scopes: ["Chat.Read", "Chat.ReadWrite", "ChatMessage.Send"],
});

const client = Client.initWithMiddleware({
  authProvider: { getAccessToken: async () => token.accessToken },
});

const chatId = "19:52bfc177-6d94-4929-bca8-968e3aca6ca6_80b6dcea-48d8-4292-85d3-59818f46b700@unq.gbl.spaces";

const html = [
  "<strong>Bold test</strong><br>",
  "<em>Italic test</em><br>",
  "<code>inline code</code><br>",
  "<br>",
  "<table>",
  "<tr><th>Name</th><th>Value</th></tr>",
  "<tr><td>Alpha</td><td>1</td></tr>",
  "<tr><td>Beta</td><td>2</td></tr>",
  "</table>",
  "<br>",
  "<ul><li>Item one</li><li>Item two</li></ul>",
  "<br>",
  "<pre>code block\n  indented</pre>",
].join("");

await client.api(`/chats/${chatId}/messages`).post({
  body: { contentType: "html", content: html },
});

console.log("Sent HTML test message to Teams");
