import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    if (m.media) {
      // Build media element with type, path (container-side), and mimetype
      const mediaAttrs = [
        `type="${escapeXml(m.media.type)}"`,
        `path="${escapeXml(m.media.containerPath)}"`,
        `mimetype="${escapeXml(m.media.mimetype)}"`,
      ];
      if (m.media.fileName) {
        mediaAttrs.push(`filename="${escapeXml(m.media.fileName)}"`);
      }
      const mediaEl = `<media ${mediaAttrs.join(' ')} />`;
      const caption = m.content ? escapeXml(m.content) : '';
      const innerContent = caption ? `${mediaEl}\n  ${caption}` : mediaEl;
      return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">\n  ${innerContent}\n</message>`;
    }
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
