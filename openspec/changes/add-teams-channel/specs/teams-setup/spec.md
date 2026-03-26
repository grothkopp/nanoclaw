## ADDED Requirements

### Requirement: Interactive setup skill
A `/add-teams` skill SHALL guide the user through Azure AD app registration, authentication, and instance configuration for Teams.

#### Scenario: User runs /add-teams
- **WHEN** the user invokes `/add-teams`
- **THEN** the skill walks them through: creating an Azure AD app registration, configuring API permissions, obtaining tenant/client IDs, authenticating via device code flow, and writing the instance config

### Requirement: Azure AD app guidance
The setup skill SHALL provide step-by-step instructions for creating an Azure AD app with the required Graph API permissions.

#### Scenario: Required permissions listed
- **WHEN** the user reaches the app registration step
- **THEN** the skill lists required delegated permissions: `Chat.Read`, `Chat.ReadWrite`, `ChatMessage.Send`, `User.Read` and instructs the user to enable "Allow public client flows" for device code flow support

### Requirement: Device code authentication flow
The setup skill SHALL authenticate the user via MSAL device code flow, displaying the code and verification URL.

#### Scenario: Successful device code auth
- **WHEN** the user completes the device code flow at microsoft.com/devicelogin
- **THEN** the skill receives tokens, caches them to `store/auth/{instanceName}/msal-cache.json`, and confirms success

#### Scenario: Device code timeout
- **WHEN** the user does not complete the device code flow within the timeout period
- **THEN** the skill reports the timeout and offers to retry

### Requirement: Instance configuration creation
The setup skill SHALL create or update `data/teams-instances.json` with the new instance configuration.

#### Scenario: First Teams instance
- **WHEN** no `data/teams-instances.json` exists
- **THEN** the skill creates the file with a single-element array containing the new instance

#### Scenario: Additional Teams instance
- **WHEN** `data/teams-instances.json` already contains instances
- **THEN** the skill appends the new instance to the array

### Requirement: Own account vs shared account selection
The setup skill SHALL ask whether the agent has its own Microsoft account or shares the user's account.

#### Scenario: Own account selected
- **WHEN** the user indicates the agent has its own dedicated Microsoft account
- **THEN** `hasOwnAccount` is set to `true` and the skill prompts for device code authentication with the bot's account (delegated permissions, same flow as shared)

#### Scenario: Shared account selected
- **WHEN** the user indicates the agent shares their account
- **THEN** `hasOwnAccount` is set to `false` and the skill prompts for device code authentication with the user's account (delegated permissions)

### Requirement: Connection validation
The setup skill SHALL validate the configuration by making a test Graph API call after authentication.

#### Scenario: Successful validation
- **WHEN** a `GET /me` call succeeds
- **THEN** the skill displays the authenticated user's display name and confirms the connection is working

#### Scenario: Failed validation
- **WHEN** the test API call fails
- **THEN** the skill displays the error and suggests common fixes (wrong permissions, consent not granted, incorrect tenant ID)

### Requirement: Client secret storage
The setup skill SHALL store the Azure AD client secret in the instance's secrets directory via `resolveSecretFile()` conventions.

#### Scenario: Secret stored per-instance
- **WHEN** the user provides the client secret during setup
- **THEN** it is written to `data/{instanceName}/secrets/teams-client-secret`
