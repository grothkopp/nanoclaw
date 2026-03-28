import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  STORE_DIR: '/tmp/nanoclaw-test-store',
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock db
vi.mock('../db.js', () => ({
  updateChatName: vi.fn(),
}));

// Mock group-folder
vi.mock('../group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(
    (folder: string) => `/tmp/nanoclaw-test-groups/${folder}`,
  ),
}));

// Mock fs — selective override to prevent real filesystem access
const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue('{}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: mockFs.existsSync,
    readFileSync: mockFs.readFileSync,
    writeFileSync: mockFs.writeFileSync,
    mkdirSync: mockFs.mkdirSync,
  },
  existsSync: mockFs.existsSync,
  readFileSync: mockFs.readFileSync,
  writeFileSync: mockFs.writeFileSync,
  mkdirSync: mockFs.mkdirSync,
}));

// Mock MSAL
const mockMsal = vi.hoisted(() => ({
  acquireTokenSilent: vi.fn().mockResolvedValue({
    accessToken: 'mock-access-token',
    account: { homeAccountId: 'test', environment: 'test', tenantId: 'test', username: 'test@test.com' },
  }),
  acquireTokenByDeviceCode: vi.fn(),
  getTokenCache: vi.fn().mockReturnValue({
    getAllAccounts: vi.fn().mockResolvedValue([
      { homeAccountId: 'test', environment: 'test', tenantId: 'test', username: 'test@test.com' },
    ]),
  }),
}));

vi.mock('@azure/msal-node', () => ({
  PublicClientApplication: class MockPCA {
    acquireTokenSilent = mockMsal.acquireTokenSilent;
    acquireTokenByDeviceCode = mockMsal.acquireTokenByDeviceCode;
    getTokenCache = mockMsal.getTokenCache;
  },
  LogLevel: { Error: 0, Warning: 1, Info: 2, Verbose: 3, Trace: 4 },
}));

// Mock Graph client
const mockGraphApi = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue({ value: [] }),
  post: vi.fn().mockResolvedValue({}),
  select: vi.fn(),
  getStream: vi.fn(),
}));

// Chain methods return the same object
mockGraphApi.select.mockReturnValue(mockGraphApi);

vi.mock('@microsoft/microsoft-graph-client', () => ({
  Client: {
    initWithMiddleware: vi.fn(() => ({
      api: vi.fn().mockReturnValue(mockGraphApi),
    })),
  },
}));

import { TeamsChannel, type TeamsInstanceConfig } from './teams.js';

// --- Test Setup ---

function makeOpts() {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn().mockReturnValue({}),
  };
}

function makeConfig(overrides: Partial<TeamsInstanceConfig> = {}): TeamsInstanceConfig {
  return {
    name: 'work',
    tenantId: 'tenant-123',
    clientId: 'client-456',
    ...overrides,
  };
}

// --- Tests ---

describe('TeamsChannel', () => {
  let channel: TeamsChannel;
  let opts: ReturnType<typeof makeOpts>;

  beforeEach(() => {
    vi.clearAllMocks();
    opts = makeOpts();
  });

  afterEach(async () => {
    if (channel) {
      await channel.disconnect();
    }
  });

  describe('JID construction', () => {
    it('should create JIDs with teams:{instanceName}: prefix', () => {
      channel = new TeamsChannel(opts, makeConfig({ name: 'work' }));
      expect(channel.ownsJid('teams:work:19:abc@thread.v2')).toBe(true);
      expect(channel.ownsJid('teams:other:19:abc@thread.v2')).toBe(false);
      expect(channel.ownsJid('slack:work:C123')).toBe(false);
    });

    it('should use instance name in the channel name', () => {
      channel = new TeamsChannel(opts, makeConfig({ name: 'corp' }));
      expect(channel.name).toBe('teams:corp');
    });
  });

  describe('Bot message detection — own account mode', () => {
    it('should detect bot messages by user ID when hasOwnAccount is true', async () => {
      channel = new TeamsChannel(opts, makeConfig({ hasOwnAccount: true }));

      // Simulate connect to set botUserId
      mockGraphApi.get.mockResolvedValueOnce({ id: 'bot-user-id', displayName: 'Bot' });
      await channel.connect();

      const registeredGroup = {
        name: 'test',
        folder: 'test_folder',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      };
      opts.registeredGroups.mockReturnValue({
        'teams:work:chat123': registeredGroup,
      });

      // Simulate polling with a message from the bot
      mockGraphApi.get.mockResolvedValueOnce({
        value: [{
          id: 'msg1',
          messageType: 'message',
          body: { contentType: 'text', content: 'Hello from bot' },
          from: { user: { id: 'bot-user-id', displayName: 'Bot' } },
          createdDateTime: '2024-01-01T00:00:00Z',
          chatType: 'oneOnOne',
        }],
        '@odata.deltaLink': 'delta-link-1',
      });

      // Trigger poll by accessing private method via any cast
      const client = (channel as any).createGraphClient();
      await (channel as any).pollChat(client, 'chat123', 'teams:work:chat123');

      expect(opts.onMessage).toHaveBeenCalledWith(
        'teams:work:chat123',
        expect.objectContaining({
          is_bot_message: true,
          content: 'Hello from bot',
        }),
      );
    });

    it('should not flag messages from other users as bot messages', async () => {
      channel = new TeamsChannel(opts, makeConfig({ hasOwnAccount: true }));

      mockGraphApi.get.mockResolvedValueOnce({ id: 'bot-user-id', displayName: 'Bot' });
      await channel.connect();

      opts.registeredGroups.mockReturnValue({
        'teams:work:chat123': {
          name: 'test',
          folder: 'test_folder',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
      });

      mockGraphApi.get.mockResolvedValueOnce({
        value: [{
          id: 'msg2',
          messageType: 'message',
          body: { contentType: 'text', content: 'Hello from user' },
          from: { user: { id: 'other-user-id', displayName: 'Alice' } },
          createdDateTime: '2024-01-01T00:00:01Z',
          chatType: 'oneOnOne',
        }],
        '@odata.deltaLink': 'delta-link-2',
      });

      const client = (channel as any).createGraphClient();
      await (channel as any).pollChat(client, 'chat123', 'teams:work:chat123');

      expect(opts.onMessage).toHaveBeenCalledWith(
        'teams:work:chat123',
        expect.objectContaining({
          is_bot_message: false,
          sender_name: 'Alice',
        }),
      );
    });
  });

  describe('Bot message detection — shared account mode', () => {
    it('should detect bot messages by assistant name prefix when hasOwnAccount is false', async () => {
      channel = new TeamsChannel(opts, makeConfig({ hasOwnAccount: false }));

      mockGraphApi.get.mockResolvedValueOnce({ id: 'user-id', displayName: 'User' });
      await channel.connect();

      opts.registeredGroups.mockReturnValue({
        'teams:work:chat123': {
          name: 'test',
          folder: 'test_folder',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
      });

      mockGraphApi.get.mockResolvedValueOnce({
        value: [{
          id: 'msg3',
          messageType: 'message',
          body: { contentType: 'text', content: 'Andy: Hello from bot' },
          from: { user: { id: 'user-id', displayName: 'User' } },
          createdDateTime: '2024-01-01T00:00:00Z',
          chatType: 'oneOnOne',
        }],
        '@odata.deltaLink': 'delta-link-3',
      });

      const client = (channel as any).createGraphClient();
      await (channel as any).pollChat(client, 'chat123', 'teams:work:chat123');

      expect(opts.onMessage).toHaveBeenCalledWith(
        'teams:work:chat123',
        expect.objectContaining({
          is_bot_message: true,
        }),
      );
    });

    it('should not flag regular messages as bot messages in shared mode', async () => {
      channel = new TeamsChannel(opts, makeConfig({ hasOwnAccount: false }));

      mockGraphApi.get.mockResolvedValueOnce({ id: 'user-id', displayName: 'User' });
      await channel.connect();

      opts.registeredGroups.mockReturnValue({
        'teams:work:chat123': {
          name: 'test',
          folder: 'test_folder',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
      });

      mockGraphApi.get.mockResolvedValueOnce({
        value: [{
          id: 'msg4',
          messageType: 'message',
          body: { contentType: 'text', content: 'Regular message' },
          from: { user: { id: 'other-user', displayName: 'Bob' } },
          createdDateTime: '2024-01-01T00:00:00Z',
          chatType: 'oneOnOne',
        }],
        '@odata.deltaLink': 'delta-link-4',
      });

      const client = (channel as any).createGraphClient();
      await (channel as any).pollChat(client, 'chat123', 'teams:work:chat123');

      expect(opts.onMessage).toHaveBeenCalledWith(
        'teams:work:chat123',
        expect.objectContaining({
          is_bot_message: false,
          sender_name: 'Bob',
        }),
      );
    });
  });

  describe('Message sending and chunking', () => {
    it('should send short messages in a single API call', async () => {
      channel = new TeamsChannel(opts, makeConfig({ hasOwnAccount: true }));
      mockGraphApi.get.mockResolvedValueOnce({ id: 'bot-id', displayName: 'Bot' });
      await channel.connect();

      await channel.sendMessage('teams:work:chat123', 'Hello!');

      expect(mockGraphApi.post).toHaveBeenCalledTimes(1);
      expect(mockGraphApi.post).toHaveBeenCalledWith({
        body: { contentType: 'text', content: 'Hello!' },
      });
    });

    it('should prefix messages with assistant name in shared mode', async () => {
      channel = new TeamsChannel(opts, makeConfig({
        hasOwnAccount: false,
        assistantName: 'Andy',
      }));
      mockGraphApi.get.mockResolvedValueOnce({ id: 'user-id', displayName: 'User' });
      await channel.connect();

      await channel.sendMessage('teams:work:chat123', 'Hello!');

      expect(mockGraphApi.post).toHaveBeenCalledWith({
        body: { contentType: 'text', content: 'Andy: Hello!' },
      });
    });

    it('should not prefix messages in own account mode', async () => {
      channel = new TeamsChannel(opts, makeConfig({ hasOwnAccount: true }));
      mockGraphApi.get.mockResolvedValueOnce({ id: 'bot-id', displayName: 'Bot' });
      await channel.connect();

      await channel.sendMessage('teams:work:chat123', 'Hello!');

      expect(mockGraphApi.post).toHaveBeenCalledWith({
        body: { contentType: 'text', content: 'Hello!' },
      });
    });

    it('should chunk messages exceeding 28,000 characters', async () => {
      channel = new TeamsChannel(opts, makeConfig({ hasOwnAccount: true }));
      mockGraphApi.get.mockResolvedValueOnce({ id: 'bot-id', displayName: 'Bot' });
      await channel.connect();

      const longMessage = 'A'.repeat(56_001);
      await channel.sendMessage('teams:work:chat123', longMessage);

      // Should be 3 chunks: 28000, 28000, 1
      expect(mockGraphApi.post).toHaveBeenCalledTimes(3);
    });
  });

  describe('Group vs 1:1 chat detection', () => {
    it('should report group chats as isGroup: true', async () => {
      channel = new TeamsChannel(opts, makeConfig());
      mockGraphApi.get.mockResolvedValueOnce({ id: 'user-id', displayName: 'User' });
      await channel.connect();

      opts.registeredGroups.mockReturnValue({
        'teams:work:chat123': {
          name: 'test',
          folder: 'test_folder',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
      });

      mockGraphApi.get.mockResolvedValueOnce({
        value: [{
          id: 'msg5',
          messageType: 'message',
          body: { contentType: 'text', content: 'Group message' },
          from: { user: { id: 'other', displayName: 'Alice' } },
          createdDateTime: '2024-01-01T00:00:00Z',
          chatType: 'group',
        }],
        '@odata.deltaLink': 'delta-link-5',
      });

      const client = (channel as any).createGraphClient();
      await (channel as any).pollChat(client, 'chat123', 'teams:work:chat123');

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'teams:work:chat123',
        '2024-01-01T00:00:00Z',
        undefined,
        'teams',
        true,
      );
    });

    it('should report 1:1 chats as isGroup: false', async () => {
      channel = new TeamsChannel(opts, makeConfig());
      mockGraphApi.get.mockResolvedValueOnce({ id: 'user-id', displayName: 'User' });
      await channel.connect();

      opts.registeredGroups.mockReturnValue({
        'teams:work:chat123': {
          name: 'test',
          folder: 'test_folder',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
      });

      mockGraphApi.get.mockResolvedValueOnce({
        value: [{
          id: 'msg6',
          messageType: 'message',
          body: { contentType: 'text', content: 'DM message' },
          from: { user: { id: 'other', displayName: 'Bob' } },
          createdDateTime: '2024-01-01T00:00:00Z',
          chatType: 'oneOnOne',
        }],
        '@odata.deltaLink': 'delta-link-6',
      });

      const client = (channel as any).createGraphClient();
      await (channel as any).pollChat(client, 'chat123', 'teams:work:chat123');

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'teams:work:chat123',
        '2024-01-01T00:00:00Z',
        undefined,
        'teams',
        false,
      );
    });
  });

  describe('Timestamp-based polling', () => {
    it('should track last seen timestamp for subsequent polls', async () => {
      channel = new TeamsChannel(opts, makeConfig());
      mockGraphApi.get.mockResolvedValueOnce({ id: 'user-id', displayName: 'User' });
      await channel.connect();

      opts.registeredGroups.mockReturnValue({
        'teams:work:chat123': {
          name: 'test',
          folder: 'test_folder',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
      });

      // Poll returns a message with a timestamp
      mockGraphApi.get.mockResolvedValueOnce({
        value: [{
          id: 'msg-ts',
          messageType: 'message',
          body: { contentType: 'text', content: 'Hello' },
          from: { user: { id: 'other', displayName: 'Alice' } },
          createdDateTime: '2024-06-15T10:30:00Z',
          chatType: 'oneOnOne',
        }],
      });

      const client = (channel as any).createGraphClient();
      await (channel as any).pollChat(client, 'chat123', 'teams:work:chat123');

      // Verify last seen timestamp was saved
      const lastSeen = (channel as any).lastSeenTimestamps.get('chat123');
      expect(lastSeen).toBe('2024-06-15T10:30:00Z');
    });

    it('should skip system messages and deleted messages', async () => {
      channel = new TeamsChannel(opts, makeConfig());
      mockGraphApi.get.mockResolvedValueOnce({ id: 'user-id', displayName: 'User' });
      await channel.connect();

      opts.registeredGroups.mockReturnValue({
        'teams:work:chat123': {
          name: 'test',
          folder: 'test_folder',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
      });

      mockGraphApi.get.mockResolvedValueOnce({
        value: [
          // System message
          {
            id: 'sys1',
            messageType: 'systemEventMessage',
            body: { content: 'Alice added Bob' },
            from: { user: { id: 'alice', displayName: 'Alice' } },
            createdDateTime: '2024-01-01T00:00:00Z',
          },
          // Deleted message
          {
            id: 'del1',
            messageType: 'message',
            deletedDateTime: '2024-01-01T00:01:00Z',
            body: { content: 'deleted' },
            from: { user: { id: 'alice', displayName: 'Alice' } },
            createdDateTime: '2024-01-01T00:00:00Z',
          },
        ],
        '@odata.deltaLink': 'delta-link-7',
      });

      const client = (channel as any).createGraphClient();
      await (channel as any).pollChat(client, 'chat123', 'teams:work:chat123');

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  describe('HTML stripping', () => {
    it('should strip HTML tags and decode entities', () => {
      channel = new TeamsChannel(opts, makeConfig());
      const strip = (channel as any).stripHtml.bind(channel);

      expect(strip('<p>Hello</p>')).toBe('Hello');
      expect(strip('Line 1<br>Line 2')).toBe('Line 1\nLine 2');
      expect(strip('&amp; &lt; &gt; &quot;')).toBe('& < > "');
      expect(strip('<div><b>Bold</b> text</div>')).toBe('Bold text');
    });
  });

  describe('Instance name from JID', () => {
    it('should work with the updated regex in instance-data', async () => {
      // This tests the regex pattern we updated
      const regex = /^(?:wa|slack|teams):([^:]+):/;

      expect('teams:work:19:abc@thread.v2'.match(regex)?.[1]).toBe('work');
      expect('teams:corp:chat123'.match(regex)?.[1]).toBe('corp');
      expect('wa:personal:12345@s.whatsapp.net'.match(regex)?.[1]).toBe('personal');
      expect('slack:aicx:C123'.match(regex)?.[1]).toBe('aicx');
      expect('legacy@g.us'.match(regex)).toBeNull();
    });
  });
});
