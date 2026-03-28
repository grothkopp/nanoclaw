import fs from 'fs';
import path from 'path';
import { marked } from 'marked';
import { Client as GraphClient } from '@microsoft/microsoft-graph-client';
import {
  PublicClientApplication,
  LogLevel as MsalLogLevel,
} from '@azure/msal-node';
import type { AccountInfo } from '@azure/msal-node';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  TRIGGER_PATTERN,
  STORE_DIR,
} from '../config.js';
import { updateChatName } from '../db.js';
import { resolveGroupFolderPath } from '../group-folder.js';

import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  ContainerConfig,
  NewMessageMedia,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Teams messages can be up to ~28KB of content.
const MAX_MESSAGE_LENGTH = 28_000;

// Graph API scopes for delegated access.
const GRAPH_SCOPES = [
  'Chat.Read',
  'Chat.ReadWrite',
  'ChatMessage.Send',
  'User.Read',
];

// Metadata sync interval: 24 hours
const METADATA_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'video/mp4': 'mp4',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/json': 'json',
};

function mimeToExtension(mimetype: string): string {
  const base = mimetype.split(';')[0].trim();
  return (
    MIME_TO_EXT[mimetype] || MIME_TO_EXT[base] || base.split('/')[1] || 'bin'
  );
}

function mimeToMediaType(
  mimetype: string,
): 'image' | 'audio' | 'video' | 'document' {
  const major = mimetype.split('/')[0];
  if (major === 'image') return 'image';
  if (major === 'audio') return 'audio';
  if (major === 'video') return 'video';
  return 'document';
}

/**
 * Convert markdown to Teams-safe HTML using the `marked` library.
 *
 * Teams supports: <strong>, <em>, <strike>, <pre>, <code>, <br>,
 * <ul>, <ol>, <li>, <p>, <a>, <blockquote>, <table>, <thead>, <tbody>,
 * <tr>, <th>, <td>
 *
 * NOT supported: <h1>-<h6> (in chat messages), <hr>, <div>, inline CSS.
 * These are replaced with safe equivalents after parsing.
 */
export function markdownToTeamsHtml(md: string): string {
  // Use marked to convert markdown → HTML (synchronous mode)
  let html = marked.parse(md, { async: false }) as string;

  // Post-process: replace Teams-unsupported tags with safe equivalents

  // Headers → <strong> (h1-h6 don't render in Teams chat messages)
  html = html.replace(
    /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi,
    '<strong>$1</strong><br>',
  );

  // <hr> → <br> (not supported)
  html = html.replace(/<hr\s*\/?>/gi, '<br>');

  // <del> → <strike> (marked uses <del> for ~~strikethrough~~)
  html = html.replace(/<del>/g, '<strike>');
  html = html.replace(/<\/del>/g, '</strike>');

  // Remove <div> wrappers (stripped by Teams)
  html = html.replace(/<\/?div[^>]*>/gi, '');

  // Clean up excessive whitespace
  html = html.replace(/\n{3,}/g, '\n\n').trim();

  return html;
}

export interface TeamsInstanceConfig {
  /** Unique name for this instance (e.g. "work"). Used in JIDs and folder names. */
  name: string;
  /** Azure AD tenant ID */
  tenantId: string;
  /** Azure AD app registration client ID */
  clientId: string;
  /** Whether the agent has its own dedicated Microsoft account (vs. sharing user's) */
  hasOwnAccount?: boolean;
  /** Polling interval in milliseconds (default: 5000) */
  pollInterval?: number;
  /** Override assistant name for this instance */
  assistantName?: string;
  /** Override model for this instance */
  model?: string;
  /** All groups in this instance share this single directory */
  singleGroupDir?: string;
  /** Default container config applied to groups registered under this instance */
  containerConfig?: ContainerConfig;
}

export interface TeamsChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TeamsChannel implements Channel {
  name: string;

  private instanceName: string;
  private jidPrefix: string;
  private instanceAssistantName: string;
  private hasOwnAccount: boolean;
  private defaultContainerConfig?: ContainerConfig;
  private pollInterval: number;
  private connected = false;
  private polling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;

  // MSAL
  private msalClient: PublicClientApplication;
  private tenantId: string;
  private clientId: string;
  private cachedAccount: AccountInfo | null = null;
  private botUserId: string | undefined;

  // Per-chat last-seen timestamps for polling
  private lastSeenTimestamps = new Map<string, string>();
  private pollStatePath: string;

  // Metadata sync
  private lastMetadataSync = 0;

  // Backoff state for transient errors
  private backoffMs = 0;
  private retryAfterMs = 0;

  private opts: TeamsChannelOpts;

  constructor(opts: TeamsChannelOpts, instanceConfig: TeamsInstanceConfig) {
    this.opts = opts;
    this.instanceName = instanceConfig.name;
    this.jidPrefix = `teams:${instanceConfig.name}:`;
    this.instanceAssistantName = instanceConfig.assistantName || ASSISTANT_NAME;
    this.hasOwnAccount = instanceConfig.hasOwnAccount ?? false;
    this.defaultContainerConfig = instanceConfig.containerConfig;
    this.pollInterval = instanceConfig.pollInterval ?? 5000;
    this.name = `teams:${instanceConfig.name}`;
    this.tenantId = instanceConfig.tenantId;
    this.clientId = instanceConfig.clientId;

    // Poll state persistence path
    const authDir = path.join(STORE_DIR, 'auth', instanceConfig.name);
    fs.mkdirSync(authDir, { recursive: true });
    this.pollStatePath = path.join(authDir, 'teams-poll-state.json');

    // Load persisted poll state
    this.loadPollState();

    // Initialize MSAL public client
    this.msalClient = new PublicClientApplication({
      auth: {
        clientId: instanceConfig.clientId,
        authority: `https://login.microsoftonline.com/${instanceConfig.tenantId}`,
      },
      cache: {
        cachePlugin: {
          beforeCacheAccess: async (cacheContext) => {
            const cachePath = path.join(authDir, 'msal-cache.json');
            if (fs.existsSync(cachePath)) {
              cacheContext.tokenCache.deserialize(
                fs.readFileSync(cachePath, 'utf-8'),
              );
            }
          },
          afterCacheAccess: async (cacheContext) => {
            if (cacheContext.cacheHasChanged) {
              const cachePath = path.join(authDir, 'msal-cache.json');
              fs.writeFileSync(cachePath, cacheContext.tokenCache.serialize());
            }
          },
        },
      },
      system: {
        loggerOptions: {
          logLevel: MsalLogLevel.Error,
          loggerCallback: (_level, message) => {
            logger.debug({ instance: this.instanceName }, `MSAL: ${message}`);
          },
        },
      },
    });
  }

  /** Returns the default containerConfig for groups registered under this instance */
  getDefaultContainerConfig(): ContainerConfig | undefined {
    return this.defaultContainerConfig;
  }

  /** Returns the instance name */
  getInstanceName(): string {
    return this.instanceName;
  }

  async connect(): Promise<void> {
    // Acquire token silently from cache
    const token = await this.acquireToken();
    if (!token) {
      logger.error(
        { instance: this.instanceName },
        'Teams: Failed to acquire token — run /add-teams to re-authenticate',
      );
      throw new Error('Teams authentication failed');
    }

    // Get bot's own user ID for bot detection
    try {
      const client = this.createGraphClient();
      const me = await client.api('/me').select('id,displayName').get();
      this.botUserId = me.id;
      logger.info(
        {
          instance: this.instanceName,
          botUserId: this.botUserId,
          displayName: me.displayName,
        },
        'Connected to Teams',
      );
    } catch (err) {
      logger.warn(
        { instance: this.instanceName, err },
        'Connected to Teams but failed to get user info',
      );
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync chat metadata on startup
    await this.syncChatMetadata();

    // Start polling loop
    this.startPolling();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.replace(this.jidPrefix, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Teams disconnected, message queued',
      );
      return;
    }

    // In shared account mode, prefix with assistant name
    const prefixed = this.hasOwnAccount
      ? text
      : `${this.instanceAssistantName}: ${text}`;

    // Convert markdown to Teams-safe HTML
    const html = markdownToTeamsHtml(prefixed);

    try {
      const client = this.createGraphClient();

      // Chunk at 28,000 characters
      if (html.length <= MAX_MESSAGE_LENGTH) {
        await client.api(`/chats/${chatId}/messages`).post({
          body: { contentType: 'html', content: html },
        });
      } else {
        for (let i = 0; i < html.length; i += MAX_MESSAGE_LENGTH) {
          await client.api(`/chats/${chatId}/messages`).post({
            body: {
              contentType: 'html',
              content: html.slice(i, i + MAX_MESSAGE_LENGTH),
            },
          });
        }
      }

      logger.info({ jid, length: text.length }, 'Teams message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Teams message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(this.jidPrefix);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.savePollState();
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Graph API typing indicator requires additional setup
  }

  async syncGroups(force: boolean): Promise<void> {
    await this.syncChatMetadata(force);
  }

  // ─── Authentication ────────────────────────────────────────────

  private async acquireToken(): Promise<string | null> {
    try {
      // Try silent acquisition first (from cache)
      const accounts = await this.msalClient.getTokenCache().getAllAccounts();
      if (accounts.length > 0) {
        this.cachedAccount = accounts[0];
        const result = await this.msalClient.acquireTokenSilent({
          account: accounts[0],
          scopes: GRAPH_SCOPES,
        });
        if (result?.accessToken) {
          return result.accessToken;
        }
      }
    } catch (err) {
      logger.debug(
        { instance: this.instanceName, err },
        'Silent token acquisition failed',
      );
    }
    return null;
  }

  private createGraphClient(): GraphClient {
    return GraphClient.initWithMiddleware({
      authProvider: {
        getAccessToken: async () => {
          const token = await this.acquireToken();
          if (!token) {
            throw new Error(
              'Teams: No valid token — re-authenticate with /add-teams',
            );
          }
          return token;
        },
      },
    });
  }

  // ─── Polling ───────────────────────────────────────────────────

  private startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    this.schedulePoll();
  }

  private schedulePoll(): void {
    if (!this.polling) return;

    // Respect Retry-After or backoff
    const delay = Math.max(
      this.pollInterval,
      this.retryAfterMs,
      this.backoffMs,
    );
    this.retryAfterMs = 0; // Reset after use

    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollAllChats();
        this.backoffMs = 0; // Reset backoff on success
      } catch (err) {
        this.handlePollError(err);
      }
      this.schedulePoll();
    }, delay);
  }

  private async pollAllChats(): Promise<void> {
    const groups = this.opts.registeredGroups();
    const client = this.createGraphClient();

    for (const [jid, _group] of Object.entries(groups)) {
      if (!jid.startsWith(this.jidPrefix)) continue;
      const chatId = jid.replace(this.jidPrefix, '');

      try {
        await this.pollChat(client, chatId, jid);
      } catch (err: unknown) {
        if (this.isRateLimitError(err)) throw err; // propagate to handlePollError
        logger.warn(
          { instance: this.instanceName, chatId, err },
          'Failed to poll Teams chat',
        );
      }
    }

    // Periodic metadata sync
    if (Date.now() - this.lastMetadataSync > METADATA_SYNC_INTERVAL_MS) {
      await this.syncChatMetadata();
    }

    this.savePollState();
  }

  private async pollChat(
    client: GraphClient,
    chatId: string,
    jid: string,
  ): Promise<void> {
    const groups = this.opts.registeredGroups();
    const lastSeen = this.lastSeenTimestamps.get(chatId);

    // Build the URL: fetch recent messages, optionally filtered by timestamp
    // Use $orderby=createdDateTime desc and $top=50 to get recent messages
    let url = `/chats/${chatId}/messages?$top=50&$orderby=createdDateTime desc`;
    if (lastSeen) {
      // Filter to only messages newer than our last seen timestamp
      url += `&$filter=createdDateTime gt ${lastSeen}`;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let response: any;
    try {
      response = await client.api(url).get();
    } catch (err: unknown) {
      // If $filter is not supported, fall back to unfiltered query
      if (this.isBadRequestError(err) && lastSeen) {
        logger.debug(
          { instance: this.instanceName, chatId },
          'Filter not supported, falling back to unfiltered query',
        );
        response = await client
          .api(
            `/chats/${chatId}/messages?$top=50&$orderby=createdDateTime desc`,
          )
          .get();
      } else {
        throw err;
      }
    }

    const messages = (response.value || []) as Array<Record<string, unknown>>;

    // Messages come in desc order — reverse to process oldest first
    messages.reverse();

    let latestTimestamp = lastSeen;

    for (const msg of messages) {
      const createdDateTime = msg.createdDateTime as string | undefined;
      if (!createdDateTime) continue;

      // Skip messages we've already seen
      if (lastSeen && createdDateTime <= lastSeen) continue;

      await this.processMessage(client, msg, chatId, jid, groups);

      // Track the latest timestamp
      if (!latestTimestamp || createdDateTime > latestTimestamp) {
        latestTimestamp = createdDateTime;
      }
    }

    if (latestTimestamp) {
      this.lastSeenTimestamps.set(chatId, latestTimestamp);
    }
  }

  private async processMessage(
    client: GraphClient,
    msg: Record<string, unknown>,
    chatId: string,
    jid: string,
    groups: Record<string, RegisteredGroup>,
  ): Promise<void> {
    // Skip system/event messages
    const messageType = msg.messageType as string | undefined;
    if (messageType && messageType !== 'message') return;

    // Skip deleted messages
    if (msg.deletedDateTime) return;

    const body = msg.body as
      | { contentType?: string; content?: string }
      | undefined;
    if (!body?.content) return;

    // Extract plain text from HTML content
    let content = body.content;
    if (body.contentType === 'html') {
      content = this.stripHtml(content);
    }
    if (!content.trim()) return;

    // Sender info
    const from = msg.from as {
      user?: { id?: string; displayName?: string };
    } | null;
    const senderId = from?.user?.id || '';
    const senderName = from?.user?.displayName || 'unknown';

    // Bot detection
    const isBotMessage = this.hasOwnAccount
      ? senderId === this.botUserId
      : content.startsWith(`${this.instanceAssistantName}:`);

    // Determine chat type for metadata
    const chatType = msg.chatType as string | undefined;
    const isGroup = chatType === 'group' || chatType === 'meeting';

    // Report metadata for chat discovery
    const timestamp =
      (msg.createdDateTime as string) || new Date().toISOString();
    this.opts.onChatMetadata(jid, timestamp, undefined, 'teams', isGroup);

    // Only deliver to registered groups
    if (!groups[jid]) return;

    // Handle @mention trigger translation (like Slack)
    if (!isBotMessage && this.botUserId) {
      // Teams encodes mentions in HTML. After stripping, check if assistant name appears
      if (
        content.includes(`@${this.instanceAssistantName}`) &&
        !TRIGGER_PATTERN.test(content)
      ) {
        content = `@${this.instanceAssistantName} ${content}`;
      }
    }

    // Download file attachments
    let media: NewMessageMedia | undefined;
    const attachments = msg.attachments as
      | Array<{
          id?: string;
          contentType?: string;
          contentUrl?: string;
          name?: string;
          content?: string;
        }>
      | undefined;

    if (attachments && attachments.length > 0 && groups[jid]) {
      const attachment = attachments[0];
      try {
        media = await this.downloadAttachment(
          client,
          chatId,
          msg.id as string,
          attachment,
          groups[jid].folder,
        );
      } catch (err) {
        logger.warn(
          { instance: this.instanceName, chatId, err },
          'Failed to download Teams attachment',
        );
      }
    }

    const resolvedSenderName = isBotMessage
      ? this.instanceAssistantName
      : senderName;

    this.opts.onMessage(jid, {
      id: (msg.id as string) || '',
      chat_jid: jid,
      sender: senderId,
      sender_name: resolvedSenderName,
      content,
      timestamp,
      is_from_me: isBotMessage,
      is_bot_message: isBotMessage,
      media,
    });
  }

  // ─── File Attachments ──────────────────────────────────────────

  private async downloadAttachment(
    client: GraphClient,
    chatId: string,
    messageId: string,
    attachment: {
      id?: string;
      contentType?: string;
      contentUrl?: string;
      name?: string;
      content?: string;
    },
    groupFolder: string,
  ): Promise<NewMessageMedia | undefined> {
    let buffer: Buffer | undefined;
    let fileName =
      attachment.name || `attachment_${attachment.id || Date.now()}`;
    let mimetype = attachment.contentType || 'application/octet-stream';

    if (attachment.contentType === 'reference') {
      // SharePoint/OneDrive file reference
      // Extract drive item URL from attachment content
      if (attachment.contentUrl) {
        try {
          const stream = await client.api(attachment.contentUrl).getStream();
          buffer = await this.streamToBuffer(stream);
        } catch (err) {
          logger.debug(
            { err, contentUrl: attachment.contentUrl },
            'Failed to download reference attachment via contentUrl',
          );
        }
      }
    } else if (attachment.id) {
      // Hosted content — download via Graph API
      try {
        const stream = await client
          .api(
            `/chats/${chatId}/messages/${messageId}/hostedContents/${attachment.id}/$value`,
          )
          .getStream();
        buffer = await this.streamToBuffer(stream);
      } catch (err) {
        logger.debug(
          { err, attachmentId: attachment.id },
          'Failed to download hosted content',
        );
      }
    }

    if (!buffer) return undefined;

    // Determine extension
    const ext = path.extname(fileName) || `.${mimeToExtension(mimetype)}`;
    if (!path.extname(fileName)) {
      fileName = `${fileName}${ext}`;
    }

    // Sanitize filename
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const savedName = `${Date.now()}_${safeName}`;

    const groupDir = resolveGroupFolderPath(groupFolder, this.instanceName);
    const mediaDir = path.join(groupDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    const hostPath = path.join(mediaDir, savedName);
    const containerPath = `/workspace/group/media/${savedName}`;
    fs.writeFileSync(hostPath, buffer);

    const mediaType = mimeToMediaType(mimetype);

    logger.info(
      {
        instance: this.instanceName,
        mimetype,
        size: buffer.length,
        path: hostPath,
      },
      'Teams file saved',
    );

    return {
      type: mediaType,
      mimetype,
      path: hostPath,
      containerPath,
      fileName: attachment.name || undefined,
    };
  }

  private async streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(
        Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk as unknown as Uint8Array),
      );
    }
    return Buffer.concat(chunks);
  }

  // ─── Chat Metadata ─────────────────────────────────────────────

  private async syncChatMetadata(force = false): Promise<void> {
    if (
      !force &&
      Date.now() - this.lastMetadataSync < METADATA_SYNC_INTERVAL_MS
    ) {
      return;
    }

    try {
      logger.info(
        { instance: this.instanceName },
        'Syncing chat metadata from Teams...',
      );

      const client = this.createGraphClient();
      let count = 0;
      let nextLink: string | undefined = '/me/chats?$expand=members&$top=50';

      while (nextLink) {
        const response = await client.api(nextLink).get();
        const chats = response.value || [];

        for (const chat of chats) {
          const chatId = chat.id as string;
          if (!chatId) continue;

          const jid = `${this.jidPrefix}${chatId}`;
          const chatType = chat.chatType as string;
          const isGroup = chatType === 'group' || chatType === 'meeting';

          // Derive a name: topic for groups, member names for 1:1
          let chatName = chat.topic as string | undefined;
          if (!chatName && !isGroup) {
            // For 1:1 chats, use the other person's display name
            const members = chat.members as
              | Array<{
                  displayName?: string;
                  userId?: string;
                }>
              | undefined;
            if (members) {
              const other = members.find((m) => m.userId !== this.botUserId);
              chatName = other?.displayName;
            }
          }

          if (chatName) {
            updateChatName(jid, chatName);
          }
          count++;
        }

        nextLink = response['@odata.nextLink'];
      }

      this.lastMetadataSync = Date.now();
      logger.info(
        { instance: this.instanceName, count },
        'Teams chat metadata synced',
      );
    } catch (err) {
      logger.error(
        { instance: this.instanceName, err },
        'Failed to sync Teams chat metadata',
      );
    }
  }

  // ─── Error Handling ────────────────────────────────────────────

  private handlePollError(err: unknown): void {
    if (this.isRateLimitError(err)) {
      const retryAfter = this.extractRetryAfter(err);
      this.retryAfterMs = retryAfter * 1000;
      logger.warn(
        { instance: this.instanceName, retryAfterMs: this.retryAfterMs },
        'Teams rate limited (429), backing off',
      );
    } else if (this.isTransientError(err)) {
      // Exponential backoff: 5s, 10s, 20s, 40s, 60s max
      this.backoffMs = Math.min((this.backoffMs || 5000) * 2, 60_000);
      logger.warn(
        { instance: this.instanceName, backoffMs: this.backoffMs, err },
        'Teams transient error, backing off',
      );
    } else if (this.isAuthError(err)) {
      logger.error(
        { instance: this.instanceName, err },
        'Teams auth error — run /add-teams to re-authenticate',
      );
      this.polling = false;
      this.connected = false;
    } else {
      logger.error({ instance: this.instanceName, err }, 'Teams poll error');
    }
  }

  private isRateLimitError(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'statusCode' in err &&
      (err as { statusCode: number }).statusCode === 429
    );
  }

  private isBadRequestError(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'statusCode' in err &&
      (err as { statusCode: number }).statusCode === 400
    );
  }

  private isTransientError(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const status = (err as { statusCode?: number }).statusCode;
    return status === 503 || status === 502 || status === 500;
  }

  private isAuthError(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const status = (err as { statusCode?: number }).statusCode;
    return status === 401 || status === 403;
  }

  private extractRetryAfter(err: unknown): number {
    if (typeof err === 'object' && err !== null) {
      const headers = (err as { headers?: Record<string, string> }).headers;
      if (headers?.['retry-after']) {
        const val = parseInt(headers['retry-after'], 10);
        if (!isNaN(val)) return val;
      }
    }
    return 30; // Default 30 seconds
  }

  // ─── Poll State Persistence ─────────────────────────────────────

  private loadPollState(): void {
    try {
      if (fs.existsSync(this.pollStatePath)) {
        const raw = JSON.parse(fs.readFileSync(this.pollStatePath, 'utf-8'));
        if (typeof raw === 'object' && raw !== null) {
          for (const [chatId, timestamp] of Object.entries(raw)) {
            if (typeof timestamp === 'string') {
              this.lastSeenTimestamps.set(chatId, timestamp);
            }
          }
        }
      }
    } catch (err) {
      logger.debug(
        { instance: this.instanceName, err },
        'Failed to load Teams poll state',
      );
    }
  }

  private savePollState(): void {
    try {
      const obj: Record<string, string> = {};
      for (const [chatId, timestamp] of this.lastSeenTimestamps) {
        obj[chatId] = timestamp;
      }
      fs.writeFileSync(this.pollStatePath, JSON.stringify(obj, null, 2));
    } catch (err) {
      logger.debug(
        { instance: this.instanceName, err },
        'Failed to save Teams poll state',
      );
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private stripHtml(html: string): string {
    // Remove HTML tags, decode common entities
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .trim();
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Teams outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this.sendMessage(item.jid, item.text);
      }
    } finally {
      this.flushing = false;
    }
  }
}

// ─── Instance Loading & Registration ───────────────────────────

function loadTeamsInstances(): TeamsInstanceConfig[] {
  const configPath = path.join(DATA_DIR, 'teams-instances.json');

  if (fs.existsSync(configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (Array.isArray(raw) && raw.length > 0) {
        return raw as TeamsInstanceConfig[];
      }
    } catch (err) {
      logger.error({ err, configPath }, 'Failed to parse teams-instances.json');
    }
  }

  return [];
}

// Self-registration: register a factory per Teams instance.
const instances = loadTeamsInstances();

if (instances.length > 0) {
  for (const instance of instances) {
    if (!instance.name || !instance.tenantId || !instance.clientId) {
      logger.warn(
        { instance: instance.name },
        'Teams instance missing required fields (name, tenantId, clientId) — skipping',
      );
      continue;
    }

    // Merge instance-level settings into containerConfig defaults
    instance.containerConfig = {
      ...instance.containerConfig,
      instanceName: instance.name,
      assistantName:
        instance.containerConfig?.assistantName ?? instance.assistantName,
      model: instance.containerConfig?.model ?? instance.model,
    };

    registerChannel(`teams:${instance.name}`, (opts: ChannelOpts) => {
      return new TeamsChannel(opts, instance);
    });
  }
} else {
  // No instances configured — register a noop factory so the system knows
  // about Teams but gracefully skips it.
  registerChannel('teams', () => null);
}
