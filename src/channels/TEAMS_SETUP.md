# Microsoft Teams Channel Setup

Teams integration uses the Microsoft Graph API with **delegated permissions only** (no admin consent required). Messages are polled via `GET /chats/{chatId}/messages` with timestamp-based cursor tracking.

## Prerequisites

- A Microsoft 365 account (the bot's own account, or your personal account in shared mode)
- Access to the [Azure Portal](https://portal.azure.com) to create an app registration

## 1. Azure AD App Registration

1. Go to [Azure Portal → App registrations](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApplications/ApplicationsListBlade)
2. Click **New registration**
   - Name: `NanoClaw Teams Bot` (or any name)
   - Supported account types: **Single tenant**
   - Redirect URI: leave blank
3. Click **Register**

### Note the IDs

From the app's **Overview** page, copy:
- **Application (client) ID** → your `clientId`
- **Directory (tenant) ID** → your `tenantId`

### API Permissions

Go to **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**:

| Permission | Purpose |
|-----------|---------|
| `Chat.Read` | Read chat messages (polling) |
| `Chat.ReadWrite` | Access chat metadata |
| `ChatMessage.Send` | Send messages |
| `User.Read` | Get bot's own user ID |

Click **Grant admin consent** if you have admin rights. Otherwise each user grants consent on first login.

### Enable Public Client Flows

Go to **Authentication** → scroll to **Advanced settings** → set **Allow public client flows** to **Yes** → **Save**.

Required for the device code flow (headless CLI authentication).

### Create Client Secret

Go to **Certificates & secrets** → **New client secret**:
- Description: `NanoClaw`
- Expiry: 24 months
- **Copy the Value** (not the Secret ID — you cannot retrieve it later)

## 2. Own Account vs Shared Account

| Mode | `hasOwnAccount` | How it works |
|------|-----------------|-------------|
| **Own account** | `true` | Bot authenticates as a dedicated Microsoft user (e.g. `bot@org.com`). Bot messages detected by user ID. Clean identity in Teams. Requires a Microsoft 365 license for the bot account. |
| **Shared account** | `false` | Bot authenticates as your account. Outbound messages prefixed with `AssistantName: ` to distinguish them. No extra license needed. |

## 3. Store Credentials

```bash
mkdir -p data/<instance>/secrets
echo -n "<client-secret-value>" > data/<instance>/secrets/teams-client-secret
```

Replace `<instance>` with your chosen instance name (e.g. `aicx`).

## 4. Authenticate

Run the device code auth script:

```bash
npx tsx scripts/teams-auth.ts <instance> <tenant-id> <client-id>
```

This will:
1. Print a URL and code
2. Open the URL in a browser, sign in with the bot's account (own mode) or your account (shared mode)
3. Approve the permissions
4. Cache tokens to `store/auth/<instance>/msal-cache.json`

On subsequent runs it will use the cached tokens silently (no browser needed).

## 5. Instance Configuration

Create `data/teams-instances.json`:

```json
[
  {
    "name": "aicx",
    "tenantId": "<tenant-id>",
    "clientId": "<client-id>",
    "hasOwnAccount": true,
    "pollInterval": 5000,
    "assistantName": "Claudia"
  }
]
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | yes | | Instance identifier, used in JIDs and folder names |
| `tenantId` | yes | | Azure AD tenant ID |
| `clientId` | yes | | Azure AD app client ID |
| `hasOwnAccount` | no | `false` | Whether the bot has its own Microsoft account |
| `pollInterval` | no | `5000` | Polling interval in ms |
| `assistantName` | no | global `ASSISTANT_NAME` | Name used for message prefixing and bot detection |
| `model` | no | global model | Claude model override for this instance |
| `singleGroupDir` | no | | All groups share one directory instead of separate folders |
| `containerConfig` | no | `{}` | Default container config for groups in this instance |

## 6. Build and Restart

```bash
npm run build
systemctl --user restart nanoclaw   # Linux
# or: launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

## 7. Register a Chat

Find the chat ID:
- Check the NanoClaw logs after startup — discovered chats are logged during metadata sync
- Or from the Teams web URL: `https://teams.microsoft.com/...19:something@thread.v2`

Register with `--instance` to pull assistant name and model from the instance config:

```bash
npx tsx setup/index.ts --step register -- \
  --jid "teams:<instance>:<chat-id>" \
  --name "<chat-name>" \
  --folder "teams_main" \
  --trigger "@<AssistantName>" \
  --channel teams \
  --instance <instance> \
  --no-trigger-required --is-main
```

For additional chats (trigger required):

```bash
npx tsx setup/index.ts --step register -- \
  --jid "teams:<instance>:<chat-id>" \
  --name "<chat-name>" \
  --folder "teams_<chat-name>" \
  --trigger "@<AssistantName>" \
  --channel teams \
  --instance <instance>
```

### Updating settings after registration

To change the assistant name for an already-registered chat:

```bash
sqlite3 store/messages.db \
  "UPDATE registered_groups SET container_config = json_set(container_config, '$.assistantName', 'NewName') WHERE jid LIKE 'teams:<instance>:%';"
```

## Troubleshooting

### Bot not responding

1. Check the service is running and logs: `tail -f logs/nanoclaw.log | grep -i teams`
2. Check `data/teams-instances.json` has correct IDs
3. Check MSAL cache exists: `ls store/auth/<instance>/msal-cache.json`
4. Check the chat is registered: `sqlite3 store/messages.db "SELECT jid, container_config FROM registered_groups WHERE jid LIKE 'teams:%';"`
5. For non-main chats: message must include the trigger pattern

### Authentication expired

Refresh tokens expire after ~90 days of inactivity. Re-run:

```bash
npx tsx scripts/teams-auth.ts <instance> <tenant-id> <client-id>
```

### Rate limiting (429)

The bot automatically backs off on 429 responses. If persistent:
- Increase `pollInterval` in `teams-instances.json` (e.g. `10000` for 10s)
- Reduce the number of registered chats

### Permission errors (403)

1. Verify all 4 delegated permissions are granted in Azure AD
2. Click **Grant admin consent** in the Azure portal
3. Re-authenticate via the auth script

## Architecture Notes

- **Polling, not webhooks**: Uses `GET /chats/{chatId}/messages` with timestamp filtering. Delta queries (`/messages/delta`) are not supported for chat messages with delegated permissions.
- **Per-chat cursors**: Last-seen timestamps are persisted to `store/auth/<instance>/teams-poll-state.json` so no messages are missed across restarts.
- **JID format**: `teams:<instance>:<chatId>` (e.g. `teams:aicx:19:52bfc...@unq.gbl.spaces`)
- **HTML stripping**: Teams messages are often HTML-formatted; the channel strips tags and decodes entities to plain text.
- **Message chunking**: Outbound messages are split at 28,000 characters (Graph API limit).
