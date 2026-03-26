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

### 1. Polling with Graph Delta Queries

**Decision**: Use `GET /me/chats/getAllMessages/delta` for message polling rather than per-chat polling or subscriptions.

**Rationale**: The delta endpoint returns only new/changed messages across all chats since the last request, using a `deltaLink` token. This is efficient (single API call per poll cycle) and avoids the broken subscription system. Per-chat polling would require N API calls for N registered chats.

**Alternatives considered**:
- *Graph subscriptions*: Require public HTTPS endpoint, known reliability issues, short expiry (60 min for chat messages). Rejected per user requirement.
- *Per-chat polling*: `GET /chats/{chatId}/messages` for each registered chat. Simpler but O(N) API calls. Rejected for efficiency.
- *Bot Framework*: Would require a Bot Framework registration and webhook endpoint. More complexity than needed for polling-based approach.

### 2. Authentication via MSAL with Device Code Flow

**Decision**: Use `@azure/msal-node` with device code flow for interactive setup, then cache refresh tokens for headless operation. For "agent has own account" mode, use client credentials flow (app-only permissions).

**Rationale**: Device code flow works in headless/CLI environments (like NanoClaw setup). Client credentials flow enables fully autonomous bot accounts. Token refresh is handled by MSAL's token cache, persisted to `store/auth/{instanceName}/msal-cache.json`.

**Alternatives considered**:
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
- **Graph API rate limits**: Microsoft throttles at ~60 requests/minute for delegated permissions. → Delta queries minimize calls (1 per poll cycle regardless of chat count). Monitor `Retry-After` headers.
- **Token expiry**: Refresh tokens can expire after 90 days of inactivity. → MSAL handles refresh automatically; setup skill warns about re-authentication if token cache is invalid.
- **Delegated vs. app permissions**: `ChatMessage.Read` (delegated) requires user context; `ChatMessage.Read.All` (app) requires admin consent. → Support both via instance config `authMode: "delegated" | "app"`.
- **Azure AD app registration complexity**: Users must create an Azure AD app with correct permissions. → Setup skill provides step-by-step guidance and validates the configuration.
