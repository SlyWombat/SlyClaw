import fs from 'fs';
import path from 'path';

import wwebjs from 'whatsapp-web.js';
import type { Client as ClientType, Message, GroupChat, Chat } from 'whatsapp-web.js';
const { Client, LocalAuth } = wwebjs;

import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME, STORE_DIR } from '../config.js';
import {
  getLastGroupSync,
  setLastGroupSync,
  updateChatName,
} from '../db.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--disable-gpu',
];

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private client!: ClientType;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;
  private reconnectAttempts = 0;

  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve).catch(reject);
    });
  }

  private async connectInternal(onFirstReady?: () => void): Promise<void> {
    const authDataPath = path.join(STORE_DIR, 'wweb-auth');
    fs.mkdirSync(authDataPath, { recursive: true });

    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: authDataPath }),
      puppeteer: { args: PUPPETEER_ARGS },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.67 Safari/537.36',
    });

    this.client.on('qr', (qr: string) => {
      // In the running service, a QR means the session expired — user needs to re-pair.
      logger.error('WhatsApp QR code emitted — session expired. Run /setup to re-authenticate.');
      const qrFile = path.join(STORE_DIR, 'qr-data.txt');
      fs.writeFileSync(qrFile, qr);
      setTimeout(() => process.exit(1), 1000);
    });

    this.client.on('ready', () => {
      this.reconnectAttempts = 0;
      this.connected = true;
      logger.info('Connected to WhatsApp');

      this.flushOutgoingQueue().catch((err) =>
        logger.error({ err }, 'Failed to flush outgoing queue'),
      );

      // Group sync: only on first connect, then daily timer
      if (!this.groupSyncTimerStarted) {
        this.groupSyncTimerStarted = true;
        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        setInterval(() => {
          this.syncGroupMetadata().catch((err) =>
            logger.error({ err }, 'Periodic group sync failed'),
          );
        }, GROUP_SYNC_INTERVAL_MS);
      }

      if (onFirstReady) {
        onFirstReady();
        onFirstReady = undefined;
      }
    });

    this.client.on('disconnected', (reason: string) => {
      this.connected = false;
      logger.info({ reason, queuedMessages: this.outgoingQueue.length }, 'Connection closed');

      if (reason === 'LOGOUT') {
        logger.info('Logged out. Run /setup to re-authenticate.');
        process.exit(0);
      }

      // Exponential backoff: 2s, 4s, 8s, 16s, 32s, 60s max
      const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempts), 60000);
      this.reconnectAttempts++;
      logger.info({ attempt: this.reconnectAttempts, delayMs: delay }, 'Reconnecting...');
      setTimeout(() => {
        this.connectInternal().catch((err) => {
          logger.error({ err }, 'Reconnect failed');
        });
      }, delay);
    });

    this.client.on('message_create', async (msg: Message) => {
      await this.handleIncomingMessage(msg);
    });

    await this.client.initialize();
  }

  private async handleIncomingMessage(msg: Message): Promise<void> {
    if (!msg.from) return;

    // For messages sent by the current account (fromMe=true), msg.from is the
    // sender's own JID/LID. The chat JID (group or DM partner) lives in msg.to.
    const rawChatJid = msg.fromMe ? msg.to : msg.from;
    if (!rawChatJid) return;
    const chatJid = normalizeJid(rawChatJid);
    const timestamp = new Date(msg.timestamp * 1000).toISOString();

    this.opts.onChatMetadata(chatJid, timestamp);

    const groups = this.opts.registeredGroups();
    if (!groups[chatJid]) return;

    const content = msg.body || '';
    const senderRaw = msg.author || msg.from;
    const sender = normalizeJid(senderRaw);

    let senderName = sender.split('@')[0];
    try {
      const contact = await msg.getContact();
      senderName = contact.pushname || contact.name || senderName;
    } catch {
      // fallback to JID username
    }

    const fromMe = msg.fromMe;
    const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
      ? fromMe
      : content.startsWith(`${ASSISTANT_NAME}:`);

    this.opts.onMessage(chatJid, {
      id: msg.id._serialized,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: fromMe,
      is_bot_message: isBotMessage,
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.info({ jid, length: prefixed.length, queueSize: this.outgoingQueue.length }, 'WA disconnected, message queued');
      return;
    }
    try {
      await this.client.sendMessage(toWwebJid(jid), prefixed);
      logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'Failed to send, message queued');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.client?.destroy();
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const chat = await this.client.getChatById(toWwebJid(jid));
      if (isTyping) {
        await chat.sendStateTyping();
      } else {
        await chat.clearState();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

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
      logger.info('Syncing group metadata from WhatsApp...');
      const chats = await this.client.getChats();
      const groups = chats.filter((c: Chat): c is GroupChat => c.isGroup);

      let count = 0;
      for (const group of groups) {
        const jid = group.id._serialized;
        if (group.name) {
          updateChatName(jid, group.name);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info({ count: this.outgoingQueue.length }, 'Flushing outgoing message queue');
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this.client.sendMessage(toWwebJid(item.jid), item.text);
        logger.info({ jid: item.jid, length: item.text.length }, 'Queued message sent');
      }
    } finally {
      this.flushing = false;
    }
  }
}

/**
 * whatsapp-web.js uses @c.us for individual contacts.
 * Normalize to @s.whatsapp.net to stay compatible with existing DB entries.
 */
function normalizeJid(jid: string): string {
  if (jid.endsWith('@c.us')) return jid.replace('@c.us', '@s.whatsapp.net');
  return jid;
}

/**
 * Convert stored @s.whatsapp.net JIDs back to @c.us for whatsapp-web.js API calls.
 */
function toWwebJid(jid: string): string {
  if (jid.endsWith('@s.whatsapp.net')) return jid.replace('@s.whatsapp.net', '@c.us');
  return jid;
}
