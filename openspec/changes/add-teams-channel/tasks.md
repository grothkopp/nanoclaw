## 1. Dependencies and Configuration

- [ ] 1.1 Add `@microsoft/microsoft-graph-client` and `@azure/msal-node` to package.json and install
- [ ] 1.2 Create `data/teams-instances.json` template file with example configuration structure
- [ ] 1.3 Define `TeamsInstanceConfig` interface and load function in `src/channels/teams.ts`

## 2. Authentication

- [ ] 2.1 Implement MSAL public client setup with device code flow (delegated permissions only, both own-account and shared-account modes)
- [ ] 2.2 Implement token cache persistence to `store/auth/{instanceName}/msal-cache.json`
- [ ] 2.3 Implement Graph client initialization with delegated token acquisition callback
- [ ] 2.4 Add client secret resolution via `resolveSecretFile()` (`data/{instance}/secrets/teams-client-secret`)

## 3. Core Channel Implementation

- [ ] 3.1 Implement `TeamsChannel` class with `Channel` interface (connect, disconnect, sendMessage)
- [ ] 3.2 Implement JID construction: `teams:{instanceName}:{chatId}` and update JID regex in `src/instance-data.ts` to include `teams` prefix
- [ ] 3.3 Implement per-chat message polling loop using `GET /chats/{chatId}/messages/delta` (delegated `Chat.Read`) with per-chat deltaLink persistence
- [ ] 3.4 Handle delta token invalidation (410 Gone → fresh initial query per chat)
- [ ] 3.5 Implement message parsing: extract sender, content, timestamp, attachments from Graph message objects
- [ ] 3.6 Implement bot message detection — own account mode (compare `from.user.id` to bot user ID)
- [ ] 3.7 Implement bot message detection — shared account mode (assistant name prefix check)

## 4. Message Sending

- [ ] 4.1 Implement `sendMessage()` via `POST /chats/{chatId}/messages` with Graph client
- [ ] 4.2 Implement message chunking at 28,000 characters
- [ ] 4.3 Implement message prefixing in shared account mode (`{assistantName}: ` prefix)

## 5. Group and Chat Support

- [ ] 5.1 Implement group vs 1:1 chat detection using `chatType` field
- [ ] 5.2 Call `onChatMetadata()` with correct `isGroup` flag for discovered chats
- [ ] 5.3 Implement chat metadata sync (fetch chat topics/names) on startup and every 24 hours

## 6. File Attachments

- [ ] 6.1 Implement hosted content attachment downloads via Graph API
- [ ] 6.2 Implement SharePoint/OneDrive file reference downloads via drive item endpoint
- [ ] 6.3 Save downloaded files to group working directory with correct filenames

## 7. Error Handling and Resilience

- [ ] 7.1 Implement rate limit handling (429 with Retry-After header)
- [ ] 7.2 Implement exponential backoff for transient errors (503, network failures)
- [ ] 7.3 Handle token expiry gracefully — log error and skip channel when re-auth needed

## 8. Channel Registration

- [ ] 8.1 Implement factory function and self-registration via `registerChannel()` for each instance
- [ ] 8.2 Add `import './teams.js'` to `src/channels/index.ts` barrel file
- [ ] 8.3 Propagate instance-level `assistantName`, `model`, `containerConfig` to group container configs

## 9. Setup Skill

- [ ] 9.1 Create `.claude/skills/add-teams/` skill with Azure AD app registration walkthrough
- [ ] 9.2 Implement device code flow authentication in the skill
- [ ] 9.3 Implement own-account vs shared-account selection (both use delegated device code flow, difference is which Microsoft account authenticates)
- [ ] 9.4 Implement connection validation via `GET /me` test call
- [ ] 9.5 Write instance config to `data/teams-instances.json` and client secret to `data/{instance}/secrets/`

## 10. Testing

- [ ] 10.1 Write unit tests for JID construction and instance extraction
- [ ] 10.2 Write unit tests for bot message detection (both modes)
- [ ] 10.3 Write unit tests for message chunking and prefixing
- [ ] 10.4 Write unit tests for delta token handling (normal flow, 410 reset)
- [ ] 10.5 Manual integration test: connect to Teams, send/receive messages in 1:1 and group chats
