## ADDED Requirements

### Requirement: Channel self-registration
The Teams channel SHALL self-register with the channel registry when its module is imported. The factory SHALL return `null` when no valid Teams instance configuration exists, allowing graceful skip.

#### Scenario: Teams instances configured
- **WHEN** `data/teams-instances.json` contains one or more valid instance configurations
- **THEN** each instance registers a channel factory named `teams:{instanceName}` with the channel registry

#### Scenario: No Teams configuration
- **WHEN** `data/teams-instances.json` does not exist or is empty
- **THEN** no Teams channel factory is registered and no error is thrown

### Requirement: Instance configuration
Each Teams instance SHALL be configured via `data/teams-instances.json` with the following fields: `name` (string, required), `tenantId` (string, required), `clientId` (string, required), `hasOwnAccount` (boolean, optional, default false), `authMode` ("delegated" | "app", optional, default "delegated"), `pollInterval` (number in ms, optional), `assistantName` (string, optional), `model` (string, optional), `singleGroupDir` (string, optional), `containerConfig` (object, optional).

#### Scenario: Minimal instance configuration
- **WHEN** an instance config contains `name`, `tenantId`, and `clientId`
- **THEN** the channel starts with defaults: `hasOwnAccount: false`, `authMode: "delegated"`, `pollInterval: 5000`

#### Scenario: Instance config with container overrides
- **WHEN** an instance config includes `assistantName`, `model`, and `containerConfig`
- **THEN** those values propagate to `containerConfig` for groups under this instance, matching the WhatsApp/Slack pattern

### Requirement: JID format
The Teams channel SHALL use JIDs in the format `teams:{instanceName}:{chatId}` where `chatId` is the Microsoft Graph chat ID.

#### Scenario: JID construction
- **WHEN** a message arrives from Graph chat ID `19:abc123@thread.v2` on instance `work`
- **THEN** the internal JID is `teams:work:19:abc123@thread.v2`

#### Scenario: Instance extraction
- **WHEN** `instanceNameFromJid()` is called with a Teams JID
- **THEN** it returns the instance name (the JID regex in `instance-data.ts` SHALL include `teams` as a valid prefix)

### Requirement: Message polling via delta queries
The channel SHALL poll for new messages using the Microsoft Graph delta endpoint (`/chats/getAllMessages/delta`). It SHALL store the `deltaLink` token between polls and use it to retrieve only new messages.

#### Scenario: Initial poll
- **WHEN** no delta token exists (first startup)
- **THEN** the channel performs an initial delta query, processes recent messages, and stores the returned `deltaLink`

#### Scenario: Subsequent poll
- **WHEN** a valid `deltaLink` exists from a previous poll
- **THEN** the channel uses it to fetch only messages created since the last poll

#### Scenario: Delta token invalidation
- **WHEN** the Graph API returns a `410 Gone` response for the delta token
- **THEN** the channel discards the token and performs a fresh initial delta query

### Requirement: Message sending
The channel SHALL send text messages to Teams chats via `POST /chats/{chatId}/messages`. Messages exceeding 28,000 characters SHALL be split into multiple messages.

#### Scenario: Short message
- **WHEN** the agent sends a message under 28,000 characters
- **THEN** a single Graph API call sends the message to the chat

#### Scenario: Long message
- **WHEN** the agent sends a message over 28,000 characters
- **THEN** the message is split at 28,000-character boundaries and sent as sequential messages

### Requirement: Bot message detection — own account mode
When `hasOwnAccount` is `true`, the channel SHALL detect bot messages by comparing the message sender's user ID against the authenticated account's user ID.

#### Scenario: Message from bot account
- **WHEN** `hasOwnAccount` is `true` and `message.from.user.id` matches the bot's cached user ID
- **THEN** the message is marked as `is_bot_message: true`

#### Scenario: Message from another user
- **WHEN** `hasOwnAccount` is `true` and `message.from.user.id` does not match the bot's user ID
- **THEN** the message is marked as `is_bot_message: false`

### Requirement: Bot message detection — shared account mode
When `hasOwnAccount` is `false`, the channel SHALL detect bot messages by checking for the assistant name prefix in the message body, matching WhatsApp's shared-number behavior.

#### Scenario: Message with assistant prefix
- **WHEN** `hasOwnAccount` is `false` and the message body starts with `{assistantName}:`
- **THEN** the message is marked as `is_bot_message: true`

#### Scenario: Message without assistant prefix
- **WHEN** `hasOwnAccount` is `false` and the message body does not start with `{assistantName}:`
- **THEN** the message is marked as `is_bot_message: false`

### Requirement: Message prefixing in shared account mode
When `hasOwnAccount` is `false`, outbound messages SHALL be prefixed with `{assistantName}: ` to distinguish bot messages from user messages.

#### Scenario: Sending in shared mode
- **WHEN** `hasOwnAccount` is `false` and the agent sends a response
- **THEN** the message text is prefixed with `{assistantName}: `

#### Scenario: Sending in own account mode
- **WHEN** `hasOwnAccount` is `true` and the agent sends a response
- **THEN** the message text is sent without any prefix

### Requirement: Group chat and 1:1 chat support
The channel SHALL support both group chats and 1:1 (direct) chats. It SHALL report `isGroup` correctly in chat metadata callbacks.

#### Scenario: Group chat detection
- **WHEN** a message arrives from a chat with `chatType: "group"` or `chatType: "meeting"`
- **THEN** `onChatMetadata` is called with `isGroup: true`

#### Scenario: 1:1 chat detection
- **WHEN** a message arrives from a chat with `chatType: "oneOnOne"`
- **THEN** `onChatMetadata` is called with `isGroup: false`

### Requirement: Chat metadata sync
The channel SHALL periodically sync chat metadata (chat names/topics) from the Graph API for registered chats.

#### Scenario: Startup sync
- **WHEN** the channel connects successfully
- **THEN** it fetches metadata for all chats the user is a member of and updates chat names via `updateChatName()`

#### Scenario: Periodic sync
- **WHEN** 24 hours have elapsed since the last metadata sync
- **THEN** the channel re-syncs chat metadata

### Requirement: File attachment downloads
The channel SHALL download file attachments from Teams messages via the Graph API and deliver them as part of the message payload.

#### Scenario: Message with hosted content attachment
- **WHEN** a message contains a `hostedContents` attachment
- **THEN** the channel downloads the file via Graph API and includes it in the message's attachment list with filename and local path

#### Scenario: Message with reference attachment
- **WHEN** a message contains a file reference (SharePoint/OneDrive link)
- **THEN** the channel downloads the file via the Graph API drive item endpoint

### Requirement: Authentication token management
The channel SHALL use MSAL for token acquisition and refresh. Tokens SHALL be cached in `store/auth/{instanceName}/msal-cache.json`. The channel SHALL handle token refresh transparently.

#### Scenario: Valid cached token
- **WHEN** a valid (non-expired) access token exists in the MSAL cache
- **THEN** the channel uses it for Graph API calls without re-authentication

#### Scenario: Expired access token with valid refresh token
- **WHEN** the access token has expired but a valid refresh token exists
- **THEN** MSAL silently acquires a new access token

#### Scenario: All tokens expired
- **WHEN** both access and refresh tokens are expired or invalid
- **THEN** the channel logs an error and the factory returns `null` (channel skipped until re-authenticated via setup skill)

### Requirement: Credential proxy compatibility
The channel SHALL store its client secret in `data/{instanceName}/secrets/teams-client-secret` (or `data/secrets/teams-client-secret` as fallback), resolved via the existing `resolveSecretFile()` mechanism.

#### Scenario: Per-instance secret resolution
- **WHEN** `data/work/secrets/teams-client-secret` exists for instance `work`
- **THEN** the channel uses the per-instance secret

#### Scenario: Global secret fallback
- **WHEN** no per-instance secret exists but `data/secrets/teams-client-secret` does
- **THEN** the channel uses the global secret

### Requirement: Reconnection and error handling
The channel SHALL handle transient Graph API errors (429, 503) with exponential backoff. It SHALL continue polling after transient failures without crashing.

#### Scenario: Rate limiting (429)
- **WHEN** the Graph API returns HTTP 429 with a `Retry-After` header
- **THEN** the channel waits for the specified duration before the next poll

#### Scenario: Transient server error
- **WHEN** the Graph API returns HTTP 503
- **THEN** the channel retries with exponential backoff (starting at 5s, max 60s)
