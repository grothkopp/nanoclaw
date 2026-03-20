import fs from 'fs';
import path from 'path';
import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, DATA_DIR, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  ContainerConfig,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export interface SlackInstanceConfig {
  /** Unique name for this instance (e.g. "aicx", "nanoclaw"). Used in JIDs and folder names. */
  name: string;
  botToken: string;
  appToken: string;
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
  private defaultContainerConfig?: ContainerConfig;
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
    this.defaultContainerConfig = instanceConfig.containerConfig;
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
      if (subtype && subtype !== 'bot_message') return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      if (!msg.text) return;

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

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text;
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
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
