## Context

NanoClaw uses a self-registering channel architecture where each channel (WhatsApp, Slack) loads from a JSON instance config, registers a factory with the channel registry, and delivers messages via callbacks. The existing patterns — JID prefixing (`wa:`, `slack:`), per-instance credential resolution, container config propagation, and credential proxy — are designed to support additional channels without core changes.

Microsoft Teams exposes messaging via the Microsoft Graph API. The Graph subscriptions (webhooks) API for chat messages is unreliable and requires a publicly accessible endpoint, making polling the pragmatic choice for this integration.

## Goals / Non-Goals

**Goals:**
- Add Teams as a first-class NanoClaw channel with the same capabilities as WhatsApp and Slack
- Support multi-instance configuration (`data/teams-instances.json`) using the established pattern
- "Agent has own account" mode — agent uses its own Azure AD identity (reliable bot detection via `from.id`) or shares the user's account (prefix-based bot detection, like WhatsApp shared number)
- Group chats and 1:1 chats with configurable trigger requirements
- Polling-based message ingestion with efficient delta queries
- Interactive setup skill for Azure AD app registration and token flow

**Non-Goals:**
- Graph subscription/webhook-based message delivery (known to be broken)
- Teams channel posts (only chat messages — 1:1 and group chats)
- Adaptive Cards or rich message formatting (plain text only, like other channels)
- Teams meeting integration or calling APIs
- File upload from agent to Teams (text responses only; file downloads from Teams are in scope)

## Decisions

### 1. Polling with Per-Chat Delta Queries (Delegated Permissions Only)

**Decision**: Use `GET /me/chats` to discover active chats, then `GET /chats/{chatId}/messages/delta` per registered chat for efficient message polling. All API calls use **delegated permissions only** (`Chat.Read`, `Chat.ReadWrite`, `ChatMessage.Send`).

**Rationale**: The tenant-wide endpoints (`/chats/getAllMessages` and `/chats/getAllMessages/delta`) require **application-only** permissions, admin consent, Microsoft approval, and a paid metered API model — making them unsuitable. Per-chat delta queries work with standard delegated `Chat.Read` permission and return only new/changed messages via a `deltaLink` token per chat. The number of API calls per poll cycle is O(N) where N is registered chats, but delta responses are lightweight (empty when no new messages).

**Polling flow**:
1. On startup: `GET /me/chats` to sync chat metadata
2. Per poll cycle: for each registered chat, call `GET /chats/{chatId}/messages/delta` using the stored `deltaLink` (or initial query if no link exists)
3. Store the returned `deltaLink` per chat for the next cycle

**Alternatives considered**:
- *`/chats/getAllMessages`*: Single API call for all chats, but requires application-only permissions, admin consent, Microsoft approval, and paid metered access. Not viable for delegated-only requirement.
- *Graph subscriptions*: Require public HTTPS endpoint, known reliability issues, short expiry (60 min for chat messages). Rejected per user requirement.
- *Bot Framework*: Would require a Bot Framework registration and webhook endpoint. More complexity than needed for polling-based approach.

### 2. Authentication via MSAL with Device Code Flow (Delegated Only)

**Decision**: Use `@azure/msal-node` with device code flow for interactive setup, then cache refresh tokens for headless operation. Both "own account" and "shared account" modes use delegated permissions — the difference is only which Microsoft account authenticates (the bot's dedicated account vs. the user's account).

**Rationale**: Device code flow works in headless/CLI environments (like NanoClaw setup). Delegated permissions are sufficient for all operations (`Chat.Read`, `Chat.ReadWrite`, `ChatMessage.Send`). Token refresh is handled by MSAL's token cache, persisted to `store/auth/{instanceName}/msal-cache.json`. An Azure AD app registration is required to obtain a client ID and enable the device code flow.

**Alternatives considered**:
- *Client credentials flow (app-only)*: Would enable fully autonomous operation without user tokens, but requires tenant-wide `Chat.Read.All` permission, admin consent, and Microsoft approval for protected APIs. Rejected to keep delegated-only.
- *Authorization code flow*: Requires a redirect URI and temporary HTTP server. More complex for CLI setup.
- *Username/password flow (ROPC)*: Deprecated by Microsoft, doesn't support MFA.

### 3. JID Format: `teams:{instanceName}:{chatId}`

**Decision**: Follow the established JID prefixing pattern. Teams chat IDs from Graph API (e.g., `19:meeting_...@thread.v2` or `19:...@unq.gbl.spaces`) become `teams:{instanceName}:{chatId}`.

**Rationale**: Consistent with `wa:{instance}:{jid}` and `slack:{instance}:{channelId}`. Instance extraction regex in `instance-data.ts` only needs `teams` added to the prefix match.

### 4. Bot Detection Strategy

**Decision**: Mirror WhatsApp's dual-mode approach:
- *Own account*: Compare `message.from.user.id` against the cached bot user ID. Reliable.
- *Shared account*: Check for assistant name prefix in message body (same as WhatsApp shared number mode).

**Rationale**: Identical pattern to WhatsApp `hasOwnNumber`, keeping the mental model consistent across channels.

### 5. Message Chunking at 28KB

**Decision**: Split outbound messages at ~28,000 characters (Graph API limit for chat messages is 28KB of content).

**Rationale**: Teams has a different limit than Slack (4000 chars). The chunking logic follows the same pattern as Slack's implementation.

### 6. File/Attachment Handling

**Decision**: Download Teams file attachments via Graph API using the `@microsoft/microsoft-graph-client` authenticated client. Files are saved to the group's working directory for container access, matching the WhatsApp/Slack pattern.

**Rationale**: Teams attachments include a `contentUrl` that requires Graph API authentication to download. The Graph client handles token injection automatically.

## Risks / Trade-offs

- **Polling latency**: Message delivery has up to `POLL_INTERVAL` (default 5s) delay. → Acceptable trade-off vs. broken subscriptions. Interval is configurable per instance.
- **Graph API rate limits**: Microsoft throttles at ~60 requests/minute for delegated permissions. → Per-chat delta queries are lightweight (empty response when no new messages). With many registered chats, the poll interval may need to increase. Monitor `Retry-After` headers.
- **O(N) API calls per poll**: Unlike a single getAllMessages call, per-chat delta requires one call per registered chat. → For typical NanoClaw usage (1-20 chats), this is well within rate limits. Delta responses for idle chats are very small.
- **Token expiry**: Refresh tokens can expire after 90 days of inactivity. → MSAL handles refresh automatically; setup skill warns about re-authentication if token cache is invalid.
- **Azure AD app registration required**: Users must create an Azure AD app registration to get a client ID for the device code flow. → Setup skill provides step-by-step guidance and validates the configuration. The app only needs delegated permissions (no admin consent required for `Chat.Read`, `Chat.ReadWrite`, `ChatMessage.Send`, `User.Read`).
