import fs from 'fs';
import https from 'https';
import http from 'http';
import path from 'path';
import { App, LogLevel } from '@slack/bolt';
import type {
  GenericMessageEvent,
  BotMessageEvent,
  FileShareMessageEvent,
} from '@slack/types';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  TRIGGER_PATTERN,
} from '../config.js';
import { updateChatName } from '../db.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../transcription.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  ContainerConfig,
  NewMessageMedia,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/json': 'json',
};

function mimeToExtension(mimetype: string): string {
  const base = mimetype.split(';')[0].trim();
  return MIME_TO_EXT[mimetype] || MIME_TO_EXT[base] || base.split('/')[1] || 'bin';
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
 * Download a URL with auth, following redirects while preserving the
 * Authorization header (unlike fetch which strips it per spec).
 * Rejects if the response is non-200 or returns an HTML login page.
 */
export function downloadWithAuth(
  url: string,
  token: string,
  expectedMimetype: string,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const makeReq = (reqUrl: string, redirectsLeft: number) => {
      const parsedUrl = new URL(reqUrl);
      const mod = parsedUrl.protocol === 'https:' ? https : http;
      const req = mod.get(
        reqUrl,
        { headers: { Authorization: `Bearer ${token}` } },
        (res: import('http').IncomingMessage) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location &&
            redirectsLeft > 0
          ) {
            makeReq(res.headers.location, redirectsLeft - 1);
            return;
          }

          if (res.statusCode !== 200) {
            reject(
              new Error(`Download failed: ${res.statusCode}`),
            );
            res.resume();
            return;
          }

          const ct = res.headers['content-type'] || '';
          if (ct.includes('text/html') && !expectedMimetype.includes('html')) {
            reject(
              new Error('Download returned HTML login page instead of file'),
            );
            res.resume();
            return;
          }

          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
    };
    makeReq(url, 5);
  });
}

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent =
  | GenericMessageEvent
  | BotMessageEvent
  | FileShareMessageEvent;

export interface SlackInstanceConfig {
  /** Unique name for this instance (e.g. "aicx", "nanoclaw"). Used in JIDs and folder names. */
  name: string;
  botToken: string;
  appToken: string;
  /** Override assistant name for this instance (defaults to global ASSISTANT_NAME) */
  assistantName?: string;
  /** Override model for this instance (defaults to global ANTHROPIC_MODEL) */
  model?: string;
  /** All groups in this instance share this single directory instead of separate folders */
  singleGroupDir?: string;
  /** Default container config applied to groups registered under this instance */
  containerConfig?: ContainerConfig;
}

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name: string;

  private instanceName: string;
  private jidPrefix: string;
  private instanceAssistantName: string;
  private defaultContainerConfig?: ContainerConfig;
  private botToken: string;
  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts, instanceConfig: SlackInstanceConfig) {
    this.opts = opts;
    this.instanceName = instanceConfig.name;
    this.jidPrefix = `slack:${instanceConfig.name}:`;
    this.instanceAssistantName = instanceConfig.assistantName || ASSISTANT_NAME;
    this.defaultContainerConfig = instanceConfig.containerConfig;
    this.botToken = instanceConfig.botToken;
    this.name = `slack:${instanceConfig.name}`;

    this.app = new App({
      token: instanceConfig.botToken,
      appToken: instanceConfig.appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  /** Returns the default containerConfig for groups registered under this instance */
  getDefaultContainerConfig(): ContainerConfig | undefined {
    return this.defaultContainerConfig;
  }

  /** Returns the instance name */
  getInstanceName(): string {
    return this.instanceName;
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message' && subtype !== 'file_share')
        return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      const files = (msg as GenericMessageEvent | FileShareMessageEvent).files;
      if (!msg.text && (!files || files.length === 0)) return;

      // Threaded replies are flattened into the channel conversation.
      // The agent sees them alongside channel-level messages; responses
      // always go to the channel, not back into the thread.

      const jid = `${this.jidPrefix}${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      const isBotMessage =
        !!((msg as GenericMessageEvent).bot_id) ||
        msg.user === this.botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = this.instanceAssistantName;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text || '';
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${this.instanceAssistantName} ${content}`;
        }
      }

      // Download file attachments (first file only, matching WhatsApp behavior)
      let media: NewMessageMedia | undefined;
      const group = groups[jid];
      if (files && files.length > 0 && group) {
        const file = files[0];
        const downloadUrl = file.url_private_download || file.url_private;
        if (downloadUrl) {
          try {
            media = await this.downloadSlackFile(
              downloadUrl,
              file.id,
              file.mimetype,
              file.name || undefined,
              group.folder,
              this.instanceName,
            );

            // Transcribe audio files
            if (media && (media.type === 'audio')) {
              const transcript = await transcribeAudio(
                media.path,
                this.instanceName,
              );
              if (transcript) {
                content = content
                  ? `${content}\n[Voice transcription: ${transcript}]`
                  : `[Voice transcription: ${transcript}]`;
              }
            }
          } catch (err) {
            logger.warn(
              { err, fileId: file.id, instance: this.instanceName },
              'Failed to download Slack file',
            );
          }
        }
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || (msg as GenericMessageEvent).bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
        media,
      });
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info(
        { instance: this.instanceName, botUserId: this.botUserId },
        'Connected to Slack',
      );
    } catch (err) {
      logger.warn(
        { instance: this.instanceName, err },
        'Connected to Slack but failed to get bot user ID',
      );
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Strip instance-prefixed JID to get channel ID: "slack:instance:C123" -> "C123"
    const channelId = jid.replace(this.jidPrefix, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({ channel: channelId, text });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
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
    await this.app.stop();
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info(
        { instance: this.instanceName },
        'Syncing channel metadata from Slack...',
      );
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`${this.jidPrefix}${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info(
        { instance: this.instanceName, count },
        'Slack channel metadata synced',
      );
    } catch (err) {
      logger.error(
        { instance: this.instanceName, err },
        'Failed to sync Slack channel metadata',
      );
    }
  }

  /**
   * Download a Slack file and save it to the group's media directory.
   */
  /** @internal - exposed for testing */
  _downloadFn: typeof downloadWithAuth = downloadWithAuth;

  private async downloadSlackFile(
    url: string,
    fileId: string,
    mimetype: string,
    fileName: string | undefined,
    groupFolder: string,
    instanceName?: string,
  ): Promise<NewMessageMedia | undefined> {
    const buffer = await this._downloadFn(url, this.botToken, mimetype);

    // Use original filename when available (sanitized), fall back to fileId
    let savedName: string;
    if (fileName) {
      // Sanitize: keep only safe chars, prefix with fileId to avoid collisions
      const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      savedName = `${fileId}_${safe}`;
    } else {
      const ext = mimeToExtension(mimetype);
      savedName = `${fileId}.${ext}`;
    }

    const groupDir = resolveGroupFolderPath(groupFolder, instanceName);
    const mediaDir = path.join(groupDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    const hostPath = path.join(mediaDir, savedName);
    const containerPath = `/workspace/group/media/${savedName}`;
    fs.writeFileSync(hostPath, buffer);

    const mediaType = mimeToMediaType(mimetype);

    logger.info(
      { fileId, mimetype, size: buffer.length, path: hostPath },
      'Slack file saved',
    );

    return {
      type: mediaType,
      mimetype,
      path: hostPath,
      containerPath,
      fileName: fileName || undefined,
    };
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(this.jidPrefix, '');
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

/**
 * Load Slack instance configurations from data/slack-instances.json.
 * Falls back to legacy .env tokens (SLACK_BOT_TOKEN / SLACK_APP_TOKEN)
 * for backwards compatibility with single-instance setups.
 */
function loadSlackInstances(): SlackInstanceConfig[] {
  const configPath = path.join(DATA_DIR, 'slack-instances.json');

  if (fs.existsSync(configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (Array.isArray(raw) && raw.length > 0) {
        return raw as SlackInstanceConfig[];
      }
    } catch (err) {
      logger.error({ err, configPath }, 'Failed to parse slack-instances.json');
    }
  }

  return [];
}

// Register a factory per Slack instance.
// Each instance gets its own channel named "slack:{instanceName}".
const instances = loadSlackInstances();

if (instances.length > 0) {
  for (const instance of instances) {
    if (!instance.name || !instance.botToken || !instance.appToken) {
      logger.warn(
        { instance: instance.name },
        'Slack instance missing required fields (name, botToken, appToken) — skipping',
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
    registerChannel(`slack:${instance.name}`, (opts: ChannelOpts) => {
      return new SlackChannel(opts, instance);
    });
  }
} else {
  // No instances configured
  registerChannel('slack', () => {
    logger.warn(
      'Slack: No instances configured. Create data/slack-instances.json.',
    );
    return null;
  });
}
