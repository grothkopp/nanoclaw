import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  WASocket,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';

import { ASSISTANT_NAME, DATA_DIR, GROUPS_DIR, STORE_DIR } from '../config.js';
import { getLastGroupSync, setLastGroupSync, updateChatName } from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  ContainerConfig,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
  NewMessageMedia,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { transcribeAudio } from '../transcription.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Map WhatsApp message types to media type strings
const MEDIA_TYPE_MAP: Record<string, 'image' | 'audio' | 'video' | 'document'> =
  {
    imageMessage: 'image',
    audioMessage: 'audio',
    pttMessage: 'audio', // Push-to-talk voice notes
    videoMessage: 'video',
    documentMessage: 'document',
    documentWithCaptionMessage: 'document',
    stickerMessage: 'image',
  };

// Map media types to file extensions based on common WhatsApp mimetypes
function getExtensionForMimetype(mimetype: string): string {
  const mimeToExt: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/mpeg': 'mpeg',
    'audio/ogg; codecs=opus': 'ogg',
    'audio/ogg': 'ogg',
    'audio/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/aac': 'aac',
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  };
  // Strip parameters (e.g. "audio/ogg; codecs=opus" -> "audio/ogg")
  const base = mimetype.split(';')[0].trim();
  return mimeToExt[mimetype] || mimeToExt[base] || base.split('/')[1] || 'bin';
}

export interface WhatsAppInstanceConfig {
  /** Unique name for this instance (e.g. "personal", "work"). Used in JIDs and folder names. */
  name: string;
  /** Whether the bot has its own dedicated phone number (affects message prefixing and bot detection) */
  hasOwnNumber?: boolean;
  /** Override assistant name for this instance (defaults to global ASSISTANT_NAME) */
  assistantName?: string;
  /** Override model for this instance (defaults to global ANTHROPIC_MODEL) */
  model?: string;
  /** All groups in this instance share this single directory instead of separate folders */
  singleGroupDir?: string;
  /** Default container config applied to groups registered under this instance */
  containerConfig?: ContainerConfig;
}

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WhatsAppChannel implements Channel {
  name: string;

  private instanceName: string;
  private jidPrefix: string;
  private hasOwnNumber: boolean;
  private instanceAssistantName: string;
  private authDirName: string;
  private defaultContainerConfig?: ContainerConfig;
  private sock!: WASocket;
  private connected = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;

  private opts: WhatsAppChannelOpts;

  constructor(
    opts: WhatsAppChannelOpts,
    instanceConfig: WhatsAppInstanceConfig,
  ) {
    this.opts = opts;
    this.instanceName = instanceConfig.name;
    this.jidPrefix = `wa:${instanceConfig.name}:`;
    this.hasOwnNumber = instanceConfig.hasOwnNumber ?? false;
    this.instanceAssistantName = instanceConfig.assistantName || ASSISTANT_NAME;
    this.authDirName = path.join('auth', instanceConfig.name);
    this.defaultContainerConfig = instanceConfig.containerConfig;
    this.name = `wa:${instanceConfig.name}`;
  }

  /** Returns the default containerConfig for groups registered under this instance */
  getDefaultContainerConfig(): ContainerConfig | undefined {
    return this.defaultContainerConfig;
  }

  /** Returns the instance name */
  getInstanceName(): string {
    return this.instanceName;
  }

  /** Convert a raw WhatsApp JID to an instance-prefixed JID */
  private toInstanceJid(rawJid: string): string {
    return `${this.jidPrefix}${rawJid}`;
  }

  /** Strip instance prefix to get raw WhatsApp JID for Baileys API calls */
  private toRawJid(instanceJid: string): string {
    return instanceJid.replace(this.jidPrefix, '');
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve).catch(reject);
    });
  }

  private async connectInternal(onFirstOpen?: () => void): Promise<void> {
    const authDir = path.join(STORE_DIR, this.authDirName);
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
      logger.warn(
        { err },
        'Failed to fetch latest WA Web version, using default',
      );
      return { version: undefined };
    });
    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Chrome'),
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg =
          'WhatsApp authentication required. Run /setup in Claude Code.';
        logger.error({ instance: this.instanceName }, msg);
        exec(
          `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
        );
        setTimeout(() => process.exit(1), 1000);
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.info(
          {
            instance: this.instanceName,
            reason,
            shouldReconnect,
            queuedMessages: this.outgoingQueue.length,
          },
          'Connection closed',
        );

        if (shouldReconnect) {
          logger.info({ instance: this.instanceName }, 'Reconnecting...');
          this.connectInternal().catch((err) => {
            logger.error({ err }, 'Failed to reconnect, retrying in 5s');
            setTimeout(() => {
              this.connectInternal().catch((err2) => {
                logger.error({ err: err2 }, 'Reconnection retry failed');
              });
            }, 5000);
          });
        } else {
          logger.info('Logged out. Run /setup to re-authenticate.');
          process.exit(0);
        }
      } else if (connection === 'open') {
        this.connected = true;
        logger.info({ instance: this.instanceName }, 'Connected to WhatsApp');

        // Announce availability so WhatsApp relays subsequent presence updates (typing indicators)
        this.sock.sendPresenceUpdate('available').catch((err) => {
          logger.warn({ err }, 'Failed to send presence update');
        });

        // Build LID to phone mapping from auth state for self-chat translation
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Flush any messages queued while disconnected
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Signal first connection to caller
        if (onFirstOpen) {
          onFirstOpen();
          onFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          // Unwrap container types (viewOnceMessageV2, ephemeralMessage,
          // editedMessage, etc.) so that conversation, extendedTextMessage,
          // imageMessage, etc. are accessible at the top level.
          const normalized = normalizeMessageContent(msg.message);
          if (!normalized) continue;
          const rawJid = msg.key.remoteJid;
          if (!rawJid || rawJid === 'status@broadcast') continue;

          // Translate LID JID to phone JID if applicable
          const rawChatJid = await this.translateJid(rawJid);
          // Prefix with instance namespace
          const chatJid = this.toInstanceJid(rawChatJid);

          const timestamp = new Date(
            Number(msg.messageTimestamp) * 1000,
          ).toISOString();

          // Always notify about chat metadata for group discovery
          const isGroup = rawChatJid.endsWith('@g.us');
          this.opts.onChatMetadata(
            chatJid,
            timestamp,
            undefined,
            'whatsapp',
            isGroup,
          );

          // Only deliver full message for registered groups
          const groups = this.opts.registeredGroups();
          const registeredGroup = groups[chatJid];
          if (registeredGroup) {
            // Detect media message type
            const mediaKey = Object.keys(MEDIA_TYPE_MAP).find(
              (k) => !!(normalized as Record<string, unknown>)[k],
            );
            const mediaType = mediaKey ? MEDIA_TYPE_MAP[mediaKey] : undefined;

            // Extract text content (caption for media, text for text messages)
            let content =
              normalized.conversation ||
              normalized.extendedTextMessage?.text ||
              normalized.imageMessage?.caption ||
              normalized.videoMessage?.caption ||
              normalized.documentMessage?.caption ||
              normalized.documentWithCaptionMessage?.message?.documentMessage
                ?.caption ||
              '';

            // Skip protocol messages with no text content AND no media
            if (!content && !mediaType) continue;

            // Download and save media if present
            let mediaInfo: NewMessageMedia | undefined;
            if (mediaType && mediaKey) {
              // Extract mimetype and fileName from the already-normalized content
              const msgContent = (normalized as Record<string, unknown>)[
                mediaKey
              ] as Record<string, unknown> | undefined;
              const mimetype =
                (msgContent?.mimetype as string) || `${mediaType}/*`;
              const fileName = (msgContent?.fileName as string) || undefined;
              mediaInfo = await this.downloadAndSaveMedia(
                msg,
                msg.key.id || 'unknown',
                mediaType,
                mimetype,
                fileName,
                registeredGroup,
              );
            }

            // Transcribe audio messages (voice notes, audio files)
            if (mediaInfo?.type === 'audio' && mediaInfo.path) {
              const transcription = await transcribeAudio(
                mediaInfo.path,
                this.instanceName,
              );
              if (transcription) {
                content = content
                  ? `${content}\n\n[Voice transcription: ${transcription}]`
                  : `[Voice transcription: ${transcription}]`;
              }
            }

            const sender = msg.key.participant || msg.key.remoteJid || '';
            const senderName = msg.pushName || sender.split('@')[0];

            const fromMe = msg.key.fromMe || false;
            // Detect bot messages: with own number, fromMe is reliable
            // since only the bot sends from that number.
            // With shared number, bot messages carry the assistant name prefix
            // (even in DMs/self-chat) so we check for that.
            const isBotMessage = this.hasOwnNumber
              ? fromMe
              : content.startsWith(`${this.instanceAssistantName}:`);

            this.opts.onMessage(chatJid, {
              id: msg.key.id || '',
              chat_jid: chatJid,
              sender,
              sender_name: senderName,
              content,
              timestamp,
              is_from_me: fromMe,
              is_bot_message: isBotMessage,
              media: mediaInfo,
            });
          }
        } catch (err) {
          logger.error(
            { err, remoteJid: msg.key?.remoteJid },
            'Error processing incoming message',
          );
        }
      }
    });
  }

  /**
   * Download media from a WhatsApp message and save it to the group's media directory.
   * Returns the media info with host and container paths, or undefined on failure.
   */
  private async downloadAndSaveMedia(
    msg: Parameters<typeof downloadMediaMessage>[0],
    messageId: string,
    mediaType: 'image' | 'audio' | 'video' | 'document',
    mimetype: string,
    fileName: string | undefined,
    group: RegisteredGroup,
  ): Promise<NewMessageMedia | undefined> {
    try {
      // Determine file extension
      const ext = getExtensionForMimetype(mimetype);
      const filename = `${messageId}.${ext}`;

      // Create media directory in the group folder
      const groupDir = path.join(GROUPS_DIR, group.folder);
      const mediaDir = path.join(groupDir, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });

      const hostPath = path.join(mediaDir, filename);
      // Container-side path: /workspace/group/media/{filename}
      const containerPath = `/workspace/group/media/${filename}`;

      // Download the media buffer using Baileys
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        {
          logger,
          reuploadRequest: this.sock.updateMediaMessage,
        },
      );

      fs.writeFileSync(hostPath, buffer as Buffer);
      logger.info(
        {
          messageId,
          mediaType,
          path: hostPath,
          size: (buffer as Buffer).length,
        },
        'Media downloaded and saved',
      );

      return {
        type: mediaType,
        mimetype,
        path: hostPath,
        containerPath,
        fileName,
      };
    } catch (err) {
      logger.warn({ err, messageId, mediaType }, 'Failed to download media');
      return undefined;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Strip instance prefix to get raw WhatsApp JID for Baileys
    const rawJid = this.toRawJid(jid);

    // Prefix bot messages with assistant name so users know who's speaking.
    // On a shared number, prefix is also needed in DMs (including self-chat)
    // to distinguish bot output from user messages.
    // Skip only when the assistant has its own dedicated phone number.
    const prefixed = this.hasOwnNumber
      ? text
      : `${this.instanceAssistantName}: ${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.info(
        { jid, length: prefixed.length, queueSize: this.outgoingQueue.length },
        'WA disconnected, message queued',
      );
      return;
    }
    try {
      await this.sock.sendMessage(rawJid, { text: prefixed });
      logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
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
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const rawJid = this.toRawJid(jid);
      const status = isTyping ? 'composing' : 'paused';
      logger.debug({ jid, status }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, rawJid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  async syncGroups(force: boolean): Promise<void> {
    return this.syncGroupMetadata(force);
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info(
        { instance: this.instanceName },
        'Syncing group metadata from WhatsApp...',
      );
      const groups = await this.sock.groupFetchAllParticipating();

      let count = 0;
      for (const [rawJid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(this.toInstanceJid(rawJid), metadata.subject);
          count++;
        }
      }

      setLastGroupSync();
      logger.info(
        { instance: this.instanceName, count },
        'Group metadata synced',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    // Check local cache first
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      logger.debug(
        { lidJid: jid, phoneJid: cached },
        'Translated LID to phone JID (cached)',
      );
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.lidToPhoneMap[lidUser] = phoneJid;
        logger.info(
          { lidJid: jid, phoneJid },
          'Translated LID to phone JID (signalRepository)',
        );
        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const rawJid = this.toRawJid(item.jid);
        // Send directly — queued items are already prefixed by sendMessage
        await this.sock.sendMessage(rawJid, { text: item.text });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

/**
 * Load WhatsApp instance configurations from data/whatsapp-instances.json.
 */
function loadWhatsAppInstances(): WhatsAppInstanceConfig[] {
  const configPath = path.join(DATA_DIR, 'whatsapp-instances.json');

  if (fs.existsSync(configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (Array.isArray(raw) && raw.length > 0) {
        return raw as WhatsAppInstanceConfig[];
      }
    } catch (err) {
      logger.error(
        { err, configPath },
        'Failed to parse whatsapp-instances.json',
      );
    }
  }

  return [];
}

// Register a factory per WhatsApp instance.
// Each instance gets its own channel named "wa:{instanceName}".
const instances = loadWhatsAppInstances();

if (instances.length > 0) {
  for (const instance of instances) {
    if (!instance.name) {
      logger.warn('WhatsApp instance missing required "name" field — skipping');
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
    registerChannel(`wa:${instance.name}`, (opts: ChannelOpts) => {
      return new WhatsAppChannel(opts, instance);
    });
  }
} else {
  // No instances configured
  registerChannel('whatsapp', () => {
    logger.warn(
      'WhatsApp: No instances configured. Create data/whatsapp-instances.json.',
    );
    return null;
  });
}
