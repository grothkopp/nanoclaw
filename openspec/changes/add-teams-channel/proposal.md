## Why

NanoClaw supports WhatsApp and Slack as messaging channels, but many teams and organizations use Microsoft Teams as their primary communication platform. Adding a Teams channel enables NanoClaw agents to be deployed where enterprise users already collaborate, using the same multi-instance patterns established for WhatsApp and Slack.

## What Changes

- New `src/channels/teams.ts` channel implementation using Microsoft Graph API for message polling and sending
- New `data/teams-instances.json` configuration file for multi-instance Teams support
- "Agent has own account" mode: agent can use its own Microsoft account or share the user's account (mirrors WhatsApp's "has own number")
- Group chat support: register Teams group chats and 1:1 chats, with configurable trigger/mention requirements
- Polling-based message ingestion using per-chat delta queries (`/chats/{chatId}/messages/delta`) with delegated permissions only — not Graph subscriptions (unreliable) or `/chats/getAllMessages` (requires application-only permissions, admin consent, and paid metered API)
- Self-registration into the channel registry with `teams:{instanceName}:{chatId}` JID format
- Per-instance credential resolution via existing `data/{instance}/secrets/` mechanism
- Channel barrel export in `src/channels/index.ts`

## Capabilities

### New Capabilities
- `teams-channel`: Core Teams channel — authentication, message polling, sending, bot detection, group/DM handling, multi-instance support
- `teams-setup`: Interactive setup skill for Teams OAuth app registration, token acquisition, and instance configuration

### Modified Capabilities
<!-- No existing spec-level requirements change. The channel registry, instance-data resolution,
     container runner, and credential proxy all support new channels without modification. -->

## Impact

- **New files**: `src/channels/teams.ts`, `src/channels/teams.test.ts`, `data/teams-instances.json` (template)
- **Modified files**: `src/channels/index.ts` (add import), JID regex in `src/instance-data.ts` (add `teams:` prefix)
- **Dependencies**: `@microsoft/microsoft-graph-client` and `@azure/msal-node` npm packages
- **Auth**: Azure AD app registration required (client ID, tenant ID); delegated permissions only (`Chat.Read`, `Chat.ReadWrite`, `ChatMessage.Send`, `User.Read`); device code flow for setup; tokens cached in `store/auth/{instanceName}/msal-cache.json`; client secret stored via `resolveSecretFile()`
- **Credential proxy**: No changes needed — Teams secrets resolved via existing `resolveSecretFile()` with instance-scoped paths
