---
name: add-teams
description: Add Microsoft Teams as a channel. Uses Graph API with delegated permissions. Supports own-account and shared-account modes. Polling-based (no webhooks needed).
---

# Add Microsoft Teams Channel

This skill configures Microsoft Teams as a NanoClaw channel using the Microsoft Graph API with delegated permissions.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/teams.ts` exists. If it does, skip to Phase 2 (Azure AD Setup). The code is already in place.

If it doesn't exist, tell the user the Teams channel code needs to be installed first and stop.

### Ask the user

1. **Do they already have an Azure AD app registration?** If yes, collect the Tenant ID and Client ID now.
2. **Will the agent use its own Microsoft account or share the user's?** This determines the `hasOwnAccount` setting.

## Phase 2: Azure AD App Registration

### Create App Registration (if needed)

If the user doesn't have an app, walk them through:

1. Go to [Azure Portal → App registrations](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApplications/ApplicationsListBlade)
2. Click **New registration**
3. Name: `NanoClaw Teams Bot` (or any name)
4. Supported account types: **Accounts in this organizational directory only** (single tenant)
5. Redirect URI: Leave blank (not needed for device code flow)
6. Click **Register**

### Note the IDs

From the app's **Overview** page:
- **Application (client) ID** → this is the `clientId`
- **Directory (tenant) ID** → this is the `tenantId`

### Configure API Permissions

Go to **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**:

Add these permissions:
- `Chat.Read`
- `Chat.ReadWrite`
- `ChatMessage.Send`
- `User.Read`

Then click **Grant admin consent** (if available, otherwise each user grants on first login).

### Enable Public Client Flows

Go to **Authentication** → scroll to **Advanced settings** → set **Allow public client flows** to **Yes** → **Save**.

This is required for the device code flow.

### Create Client Secret

Go to **Certificates & secrets** → **New client secret**:
- Description: `NanoClaw`
- Expires: 24 months (or as preferred)
- Copy the **Value** (not the Secret ID)

## Phase 3: Authentication

### Store the client secret

```bash
mkdir -p data/<instance-name>/secrets
echo -n "<client-secret>" > data/<instance-name>/secrets/teams-client-secret
```

Replace `<instance-name>` with the chosen name (e.g., `work`).

### Authenticate via device code flow

Run the authentication script to get delegated tokens:

```bash
npx tsx -e "
import { PublicClientApplication } from '@azure/msal-node';
import fs from 'fs';
import path from 'path';

const instanceName = '<instance-name>';
const tenantId = '<tenant-id>';
const clientId = '<client-id>';

const authDir = path.join('store', 'auth', instanceName);
fs.mkdirSync(authDir, { recursive: true });
const cachePath = path.join(authDir, 'msal-cache.json');

const pca = new PublicClientApplication({
  auth: { clientId, authority: 'https://login.microsoftonline.com/' + tenantId },
  cache: {
    cachePlugin: {
      beforeCacheAccess: async (ctx) => {
        if (fs.existsSync(cachePath)) ctx.tokenCache.deserialize(fs.readFileSync(cachePath, 'utf-8'));
      },
      afterCacheAccess: async (ctx) => {
        if (ctx.cacheHasChanged) fs.writeFileSync(cachePath, ctx.tokenCache.serialize());
      },
    },
  },
});

const result = await pca.acquireTokenByDeviceCode({
  scopes: ['Chat.Read', 'Chat.ReadWrite', 'ChatMessage.Send', 'User.Read'],
  deviceCodeCallback: (response) => {
    console.log('\\n' + response.message + '\\n');
  },
});

console.log('Authenticated as:', result.account?.name || result.account?.username);
console.log('Token cached to:', cachePath);
"
```

The user must:
1. Open the URL shown in the terminal
2. Enter the code displayed
3. Sign in with the Microsoft account (their own or the bot's dedicated account)
4. Approve the permissions

### Validate connection

After authentication, test with:

```bash
npx tsx -e "
import { PublicClientApplication } from '@azure/msal-node';
import { Client } from '@microsoft/microsoft-graph-client';
import fs from 'fs';
import path from 'path';

const instanceName = '<instance-name>';
const tenantId = '<tenant-id>';
const clientId = '<client-id>';
const cachePath = path.join('store', 'auth', instanceName, 'msal-cache.json');

const pca = new PublicClientApplication({
  auth: { clientId, authority: 'https://login.microsoftonline.com/' + tenantId },
  cache: {
    cachePlugin: {
      beforeCacheAccess: async (ctx) => {
        if (fs.existsSync(cachePath)) ctx.tokenCache.deserialize(fs.readFileSync(cachePath, 'utf-8'));
      },
      afterCacheAccess: async (ctx) => {
        if (ctx.cacheHasChanged) fs.writeFileSync(cachePath, ctx.tokenCache.serialize());
      },
    },
  },
});

const accounts = await pca.getTokenCache().getAllAccounts();
const token = await pca.acquireTokenSilent({ account: accounts[0], scopes: ['User.Read'] });

const client = Client.initWithMiddleware({
  authProvider: { getAccessToken: async () => token.accessToken },
});
const me = await client.api('/me').select('displayName,mail').get();
console.log('Connected as:', me.displayName, '(' + me.mail + ')');
"
```

## Phase 4: Instance Configuration

### Create teams-instances.json

```bash
cat > data/teams-instances.json << 'EOF'
[
  {
    "name": "<instance-name>",
    "tenantId": "<tenant-id>",
    "clientId": "<client-id>",
    "hasOwnAccount": false,
    "pollInterval": 5000,
    "assistantName": "Andy"
  }
]
EOF
```

Set `hasOwnAccount` to `true` if the agent authenticated with its own dedicated Microsoft account.

### Build and restart

```bash
npm run build
```

Then restart the service:
```bash
# Linux
systemctl --user restart nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 5: Registration

### Get Chat ID

Tell the user:

> 1. Open Microsoft Teams and start a chat (1:1 or group) or use an existing one
> 2. The chat ID can be found in the Teams web app URL: `https://teams.microsoft.com/_#/conversations/19:...@thread.v2`
> 3. Alternatively, after starting NanoClaw, check the logs — discovered chats are logged during metadata sync
>
> The JID format for NanoClaw is: `teams:<instance-name>:<chat-id>`

Wait for the user to provide the chat ID.

### Register the chat

For a main chat (responds to all messages):

```bash
npx tsx setup/index.ts --step register -- --jid "teams:<instance-name>:<chat-id>" --name "<chat-name>" --folder "teams_main" --trigger "@${ASSISTANT_NAME}" --channel teams --no-trigger-required --is-main
```

For additional chats (trigger-only):

```bash
npx tsx setup/index.ts --step register -- --jid "teams:<instance-name>:<chat-id>" --name "<chat-name>" --folder "teams_<chat-name>" --trigger "@${ASSISTANT_NAME}" --channel teams
```

## Phase 6: Verify

### Test the connection

Tell the user:

> Send a message in your registered Teams chat:
> - For main chat: Any message works
> - For non-main: `@<assistant-name> hello` (using the configured trigger word)
>
> The bot should respond within a few seconds (up to the poll interval).

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i teams
```

## Troubleshooting

### Bot not responding

1. Check `data/teams-instances.json` exists and has correct `tenantId`, `clientId`
2. Check MSAL cache exists: `ls store/auth/<instance-name>/msal-cache.json`
3. Check chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'teams:%'"`
4. For non-main chats: message must include trigger pattern
5. Service is running: check logs

### Authentication expired

Refresh tokens can expire after 90 days of inactivity. Re-run the device code flow from Phase 3.

### Rate limiting

If logs show `Teams rate limited (429)`, the bot automatically backs off. If persistent:
- Increase `pollInterval` in `teams-instances.json` (e.g., 10000 for 10s)
- Reduce the number of registered chats

### Permission errors

If logs show `403 Forbidden`:
1. Verify all required permissions are granted in Azure AD
2. Click **Grant admin consent** in the Azure portal
3. Re-authenticate via device code flow

## After Setup

The Teams channel supports:
- **1:1 chats** — Direct messages with the bot
- **Group chats** — Bot participates in group conversations
- **Own account mode** — Bot has its own identity, reliable message detection
- **Shared account mode** — Bot uses the user's account, messages prefixed with assistant name
- **Multi-channel** — Runs alongside WhatsApp, Slack, or other channels

## Known Limitations

- **Polling-based** — Messages are detected via polling (default 5s interval), not instant push. Adjust `pollInterval` to balance latency vs. API usage.
- **No typing indicator** — Teams Graph API typing indicator requires additional setup not implemented.
- **HTML content simplified** — Teams messages often contain HTML formatting which is stripped to plain text.
- **No adaptive cards** — Responses are plain text only, no rich card formatting.
- **File downloads may fail for restricted files** — SharePoint/OneDrive files with restricted permissions may not be downloadable via the bot's delegated token.
