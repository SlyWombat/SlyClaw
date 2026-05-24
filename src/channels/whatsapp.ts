/*
 *   ____  _            ____ _
 *  / ___|| |_   _     / ___| | __ ___      __
 *  \___ \| | | | |   | |   | |/ _` \ \ /\ / /
 *   ___) | | |_| |   | |___| | (_| |\ V  V /
 *  |____/|_|\__, |    \____|_|\__,_| \_/\_/
 *           |___/
 *  Cunning. Sturdy. Open.
 *
 *  Based on the NanoClaw project. Modified by Sly Wombat.
 */
/**
 * WhatsApp channel adapter — native Baileys v7 implementation.
 *
 * Replaces the previous wweb-js + puppeteer + Chromium stack. Speaks
 * WhatsApp's WebSocket protocol directly via @whiskeysockets/baileys
 * (pinned to 7.0.0-rc.9 — last release, repo unmaintained but RC.9 is
 * stable when paired with the workarounds in this file).
 *
 * Ports the key fixes from upstream nanoclaw's `channels` branch:
 *
 * 1. `resolveWaWebVersion()` — Baileys' built-in fetchLatestWaWebVersion
 *    scrapes sw.js and is aggressively 429'd; when it fails Baileys falls
 *    back to a hardcoded version that goes stale in weeks and WhatsApp
 *    rejects the Noise handshake (405). We fetch from wppconnect's
 *    version tracker as the primary source.
 *
 * 2. LID handling — Baileys v7 exposes `participantAlt`/`remoteJidAlt`
 *    on every inbound and a real `signalRepository.lidMapping.getPNForLID`.
 *    We resolve to phone-JID (`@s.whatsapp.net`) before emitting to the
 *    router so registeredGroups[jid] lookups hit.
 *
 * 3. Reconnect logic that respects shutdown — auto-reconnect on close
 *    unless `loggedOut` or `shuttingDown`. The shutdown guard exists
 *    because a parallel `useMultiFileAuthState` mid-process-exit
 *    truncates creds.json mid-write and forces a fresh QR pair.
 *
 * 4. Logged-out auth cleanup — nukes authDir immediately on logout.
 *    Stale creds after logout cause a second 401 that triggers WhatsApp's
 *    re-link cooldown ("can't link new devices now").
 *
 * 5. `cachedGroupMetadata` + `getMessage` callbacks into makeWASocket so
 *    Baileys doesn't spin waiting for resends of messages we don't have.
 *
 * Auth credentials persist in `store/auth/` (Baileys multi-file format).
 * If `WHATSAPP_PHONE_NUMBER` is set in `.env` → pairing code (8-char,
 * printed to log + saved to `store/pairing-code.txt`). Otherwise → QR
 * code printed to the log as terminal ASCII.
 */
import fs from 'fs';
import path from 'path';

import { pino } from 'pino';
import QRCode from 'qrcode';
import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  normalizeMessageContent,
  proto,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type {
  GroupMetadata,
  WAMessage,
  WAMessageKey,
  WASocket,
} from '@whiskeysockets/baileys';

import { isSafeAttachmentName } from '../attachment-safety.js';
import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME, STORE_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import {
  getLastGroupSync,
  setLastGroupSync,
  updateChatName,
} from '../db.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

// --- Constants ---

const AUTH_DIR = path.join(STORE_DIR, 'auth');
const PAIRING_CODE_FILE = path.join(STORE_DIR, 'pairing-code.txt');
const QR_PNG_FILE = path.join(STORE_DIR, 'qr.png');
const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const GROUP_METADATA_CACHE_TTL_MS = 60_000; // 1 min for outbound sends
const SENT_MESSAGE_CACHE_MAX = 256;
const RECONNECT_DELAY_MS = 5000;

const baileysLogger = pino({ level: 'silent' });

// --- WA Web version resolution ---

/**
 * Fetch the current WhatsApp Web version. Baileys' built-in fetch
 * scrapes sw.js which is aggressively rate-limited (429); when it
 * fails Baileys uses a hardcoded version that quickly goes stale
 * and WhatsApp rejects the Noise handshake (405). wppconnect runs
 * a version tracker that's reliable enough to use as our primary
 * source, with Baileys' fetch as a fallback.
 */
async function resolveWaWebVersion(): Promise<[number, number, number]> {
  try {
    const res = await fetch('https://wppconnect.io/whatsapp-versions/', {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const html = await res.text();
      const match = html.match(/2\.3000\.(\d+)/);
      if (match) {
        const version: [number, number, number] = [2, 3000, Number(match[1])];
        logger.info({ version }, 'Fetched WA Web version from wppconnect');
        return version;
      }
    }
  } catch {
    /* fall through to Baileys fetch */
  }

  try {
    const { version } = await fetchLatestWaWebVersion({});
    if (version) {
      logger.info({ version }, 'Fetched WA Web version from Baileys');
      return version as [number, number, number];
    }
  } catch {
    /* fall through to error */
  }

  throw new Error(
    'Could not fetch current WhatsApp Web version from any source. ' +
      'Baileys hardcodes a stale version that WhatsApp rejects (405). ' +
      'Check connectivity to wppconnect.io and web.whatsapp.com.',
  );
}

// --- Media outbound ---

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv']);
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.m4a', '.wav', '.aac', '.opus']);

/** Build a Baileys message payload for an outbound media file. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildMediaMessage(data: Buffer, filename: string, ext: string, caption?: string): any {
  if (IMAGE_EXTS.has(ext)) {
    const subtype = ext.slice(1) === 'jpg' ? 'jpeg' : ext.slice(1);
    return { image: data, caption, mimetype: `image/${subtype}` };
  }
  if (VIDEO_EXTS.has(ext)) {
    return { video: data, caption, mimetype: `video/${ext.slice(1)}` };
  }
  if (AUDIO_EXTS.has(ext)) {
    const subtype = ext.slice(1) === 'mp3' ? 'mpeg' : ext.slice(1);
    return { audio: data, mimetype: `audio/${subtype}` };
  }
  return { document: data, fileName: filename, caption, mimetype: 'application/octet-stream' };
}

// --- Channel ---

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface OutgoingItem {
  jid: string;
  payload: { text?: string; mediaPath?: string; caption?: string };
}

interface CachedGroup {
  metadata: GroupMetadata;
  expiresAt: number;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock!: WASocket;
  private connected = false;
  private shuttingDown = false;
  private outgoingQueue: OutgoingItem[] = [];
  private flushing = false;
  private groupSyncTimerStarted = false;
  private firstOpenResolve?: () => void;
  private firstOpenReject?: (err: Error) => void;

  // LRU of message IDs we sent — used to filter our own echoes in self-chat
  private sentMessageCache = new Map<string, true>();

  // LID → phone JID map; built from auth state + Baileys' lid-mapping.update event
  private lidToPhone = new Map<string, string>();
  private botPhoneJid?: string;
  private botLidUser?: string;

  // 60s group metadata cache for outbound sends
  private groupMetadataCache = new Map<string, CachedGroup>();

  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }

  // --- Channel interface ---

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.firstOpenResolve = resolve;
      this.firstOpenReject = reject;
      this.connectInternal().catch(reject);
    });
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    this.connected = false;
    try {
      this.sock?.end(undefined);
    } catch {
      /* ignore */
    }
    logger.info('WhatsApp adapter shut down');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const prefixed = ASSISTANT_HAS_OWN_NUMBER ? text : `${ASSISTANT_NAME}: ${text}`;
    if (!this.connected) {
      this.outgoingQueue.push({ jid, payload: { text: prefixed } });
      logger.info(
        { jid, length: prefixed.length, queueSize: this.outgoingQueue.length },
        'WA disconnected, message queued',
      );
      return;
    }
    try {
      const sent = await this.sock.sendMessage(jid, { text: prefixed });
      this.recordSent(sent?.key?.id);
      logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, payload: { text: prefixed } });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
    }
  }

  async sendFile(jid: string, filePath: string, caption?: string): Promise<void> {
    // Match sendMessage's labelling: when the assistant doesn't own its own
    // WA number, every outbound message gets a `${ASSISTANT_NAME}:` prefix
    // so recipients can tell who sent it and so the inbound bot-detection
    // matches echoed-back media (caption is the `content` field for media).
    const prefixedCaption = ASSISTANT_HAS_OWN_NUMBER
      ? caption
      : caption
        ? `${ASSISTANT_NAME}: ${caption}`
        : `${ASSISTANT_NAME}:`;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, payload: { mediaPath: filePath, caption: prefixedCaption } });
      logger.info({ jid, filePath, queueSize: this.outgoingQueue.length }, 'WA disconnected, file queued');
      return;
    }
    try {
      const data = fs.readFileSync(filePath);
      const filename = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const payload = buildMediaMessage(data, filename, ext, prefixedCaption);
      const sent = await this.sock.sendMessage(jid, payload);
      this.recordSent(sent?.key?.id);
      logger.info({ jid, filePath, hasCaption: !!caption }, 'File sent');
    } catch (err) {
      logger.error({ err, jid, filePath }, 'Failed to send file');
      throw err;
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.connected) return;
    try {
      await this.sock.sendPresenceUpdate(isTyping ? 'composing' : 'paused', jid);
    } catch (err) {
      logger.debug({ err, jid, isTyping }, 'Failed to update typing presence');
    }
  }

  async syncGroupMetadata(force = false): Promise<void> {
    if (!this.connected) return;

    const lastSync = getLastGroupSync();
    if (!force && lastSync) {
      const since = Date.now() - new Date(lastSync).getTime();
      if (since < GROUP_SYNC_INTERVAL_MS) {
        logger.debug({ sinceMs: since }, 'Group sync skipped (last sync recent)');
        return;
      }
    }

    try {
      const groups = await this.sock.groupFetchAllParticipating();
      let updated = 0;
      for (const [jid, meta] of Object.entries(groups)) {
        if (meta.subject) {
          updateChatName(jid, meta.subject);
          updated++;
        }
      }
      setLastGroupSync();
      logger.info({ updated }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Group sync failed');
    }
  }

  // --- Internals ---

  private recordSent(id: string | null | undefined): void {
    if (!id) return;
    this.sentMessageCache.set(id, true);
    if (this.sentMessageCache.size > SENT_MESSAGE_CACHE_MAX) {
      const oldest = this.sentMessageCache.keys().next().value;
      if (oldest) this.sentMessageCache.delete(oldest);
    }
  }

  private async connectInternal(): Promise<void> {
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const version = await resolveWaWebVersion();

    // Optional pairing-code auth — set WHATSAPP_PHONE_NUMBER in .env to use
    // (digits only, with country code, e.g. "14165551234").
    const env = readEnvFile(['WHATSAPP_PHONE_NUMBER']);
    const phoneNumber = env.WHATSAPP_PHONE_NUMBER;

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: false,
      logger: baileysLogger,
      browser: Browsers.macOS('Chrome'),
      cachedGroupMetadata: async (jid: string) => this.getNormalizedGroupMetadata(jid),
      getMessage: async (key: WAMessageKey) => {
        // Return empty so Baileys doesn't spin forever waiting for a
        // resend of messages we don't have. Echo filtering happens at
        // the inbound handler level via sentMessageCache.
        if (key.id && this.sentMessageCache.has(key.id)) {
          // We sent this message recently, but we don't keep the proto
          // payload around — empty is still preferred over "unknown".
        }
        return proto.Message.create({});
      },
    });

    // Request pairing code if phone number set + not yet registered
    if (phoneNumber && !state.creds.registered) {
      setTimeout(async () => {
        try {
          const code = await this.sock.requestPairingCode(phoneNumber);
          logger.info({ code }, `WhatsApp pairing code: ${code}`);
          logger.info('Enter in WhatsApp > Linked Devices > Link with phone number');
          fs.writeFileSync(PAIRING_CODE_FILE, code, 'utf-8');
        } catch (err) {
          logger.error({ err }, 'Failed to request WhatsApp pairing code');
        }
      }, 3000);
    }

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !phoneNumber) {
        // QR auth — print ASCII to log AND save as PNG. ASCII through
        // terminal scrollback can be hard to scan reliably; the PNG is
        // a no-fail fallback the user can open in any image viewer.
        QRCode.toString(qr, { type: 'terminal', small: true })
          .then((ascii) => {
            logger.info(
              '\nWhatsApp QR code — scan with WhatsApp > Linked Devices > Link a Device:\n' +
                ascii,
            );
          })
          .catch((err) => logger.warn({ err, qr }, 'Failed to render QR ASCII'));
        QRCode.toFile(QR_PNG_FILE, qr, { width: 512, margin: 2 })
          .then(() => {
            logger.info(
              { path: QR_PNG_FILE },
              `WhatsApp QR also saved as PNG (open it in any image viewer to scan)`,
            );
          })
          .catch((err) => logger.warn({ err }, 'Failed to write QR PNG'));
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (lastDisconnect?.error as { output?: { statusCode?: number } })
          ?.output?.statusCode;
        // Don't auto-reconnect during shutdown — a parallel
        // useMultiFileAuthState() init truncates creds.json mid-write on
        // process exit, leaving a 0-byte creds file and forcing a fresh QR.
        const shouldReconnect = !this.shuttingDown && reason !== DisconnectReason.loggedOut;

        logger.info(
          { reason, shouldReconnect, shuttingDown: this.shuttingDown },
          'WhatsApp connection closed',
        );

        if (shouldReconnect) {
          logger.info('Reconnecting...');
          this.connectInternal().catch((err) => {
            logger.error({ err }, 'Failed to reconnect, retrying in 5s');
            setTimeout(() => {
              this.connectInternal().catch((err2) =>
                logger.error({ err: err2 }, 'Reconnection retry failed'),
              );
            }, RECONNECT_DELAY_MS);
          });
        } else {
          logger.info('WhatsApp logged out');
          // Clear stale credentials immediately. Keeping them around
          // causes the next service start to attempt auth with an
          // invalidated session — a second 401 triggers WhatsApp's
          // re-link cooldown ("can't link new devices now").
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
            logger.info('WhatsApp auth cleared — restart to re-pair');
          } catch (err) {
            logger.error({ err }, 'Failed to clear WhatsApp auth after logout');
          }
          if (this.firstOpenReject) {
            this.firstOpenReject(new Error('WhatsApp logged out'));
            this.firstOpenResolve = undefined;
            this.firstOpenReject = undefined;
          }
        }
      } else if (connection === 'open') {
        this.connected = true;
        logger.info('Connected to WhatsApp');

        // Clean up pairing-code file after successful pair
        try {
          if (fs.existsSync(PAIRING_CODE_FILE)) fs.unlinkSync(PAIRING_CODE_FILE);
        } catch {
          /* ignore */
        }

        // Announce online presence
        this.sock.sendPresenceUpdate('available').catch((err) =>
          logger.warn({ err }, 'Failed to send presence update'),
        );

        // Build LID → phone mapping from auth state for bot's own JID
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          this.botPhoneJid = `${phoneUser}@s.whatsapp.net`;
          if (lidUser && phoneUser) {
            this.lidToPhone.set(lidUser, this.botPhoneJid);
            this.botLidUser = lidUser;
          }
        }

        // Flush queued outgoing messages
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // First sync (then daily timer)
        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Resolve the outer connect() promise once on first successful open.
        if (this.firstOpenResolve) {
          this.firstOpenResolve();
          this.firstOpenResolve = undefined;
          this.firstOpenReject = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    // LID ↔ phone mapping updates — Baileys v7 emits these continuously as
    // it learns mappings for participants we see across chats.
    this.sock.ev.on('lid-mapping.update', ({ lid, pn }) => {
      const lidUser = lid?.split('@')[0]?.split(':')[0];
      if (lidUser && pn) {
        const phoneJid = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
        this.lidToPhone.set(lidUser, phoneJid);
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        try {
          await this.handleIncomingMessage(msg);
        } catch (err) {
          logger.error({ err, msgId: msg.key.id }, 'Error handling inbound message');
        }
      }
    });
  }

  private async handleIncomingMessage(msg: WAMessage): Promise<void> {
    if (!msg.message) return;
    const normalized = normalizeMessageContent(msg.message);
    if (!normalized) return;

    const rawJid = msg.key.remoteJid;
    if (!rawJid || rawJid === 'status@broadcast') return;

    // Translate LID → phone JID via v7's alt JID
    const chatJid = await this.translateJid(rawJid, msg.key.remoteJidAlt);

    const tsSec = typeof msg.messageTimestamp === 'number'
      ? msg.messageTimestamp
      : Number(msg.messageTimestamp);
    const isoTimestamp = new Date(tsSec * 1000).toISOString();
    const isGroup = chatJid.endsWith('@g.us');

    // Notify host of metadata for group discovery — let it record
    // the chat exists so /add-group flows can discover it.
    this.opts.onChatMetadata(chatJid, isoTimestamp);

    let content =
      normalized.conversation ||
      normalized.extendedTextMessage?.text ||
      normalized.imageMessage?.caption ||
      normalized.videoMessage?.caption ||
      normalized.documentMessage?.caption ||
      '';

    // Normalize bot LID mention → assistant name for trigger matching
    if (this.botLidUser && content.includes(`@${this.botLidUser}`)) {
      content = content.replace(`@${this.botLidUser}`, `@${ASSISTANT_NAME}`);
    }

    // Download any attached media
    const attachment = await this.downloadInboundMedia(msg, normalized);

    // Skip empty protocol messages (no text and no media)
    if (!content && !attachment) return;

    // Resolve sender: in groups, participant may be LID — translate first
    const rawSender = msg.key.participant || msg.key.remoteJid || '';
    const sender = rawSender.endsWith('@lid')
      ? await this.translateJid(rawSender, msg.key.participantAlt)
      : rawSender;
    const senderName = msg.pushName || sender.split('@')[0];
    const fromMe = msg.key.fromMe || false;

    // Echo filter. In self-chat (user messaging their own number) every
    // message has fromMe=true — we can't blanket-drop them, but our own
    // echoes are in sentMessageCache. In any other chat fromMe=true means
    // the user's phone sent it, which shouldn't wake the agent.
    if (fromMe) {
      const isSelfChat = this.botPhoneJid && chatJid === this.botPhoneJid;
      if (!isSelfChat) return;
      if (msg.key.id && this.sentMessageCache.has(msg.key.id)) return;
    }

    const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
      ? false
      : content.startsWith(`${ASSISTANT_NAME}:`);

    const newMessage: NewMessage = {
      id: msg.key.id || `${tsSec}-${Math.random().toString(36).slice(2, 8)}`,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp: isoTimestamp,
      is_from_me: fromMe,
      is_bot_message: isBotMessage,
    };
    if (attachment) {
      if (attachment.kind === 'image') {
        newMessage.imageAttachment = {
          base64: attachment.data.toString('base64'),
          mimeType: attachment.mimeType,
        };
      } else {
        newMessage.fileAttachment = {
          base64: attachment.data.toString('base64'),
          mimeType: attachment.mimeType,
          filename: attachment.filename,
        };
      }
    }

    this.opts.onMessage(chatJid, newMessage);
  }

  /**
   * Resolve a possibly-LID JID to a phone-format JID. Baileys v7 hands us
   * the alt JID on every message; we cache it for later sends to the same
   * participant. If we don't have an alt and the JID is already
   * phone-format, return it unchanged.
   */
  private async translateJid(rawJid: string, altJid?: string | null): Promise<string> {
    if (!rawJid.endsWith('@lid')) return rawJid;

    const lidUser = rawJid.split('@')[0].split(':')[0];

    if (altJid) {
      const normalised = altJid.endsWith('@s.whatsapp.net')
        ? altJid
        : altJid.includes('@')
          ? altJid
          : `${altJid}@s.whatsapp.net`;
      this.lidToPhone.set(lidUser, normalised);
      return normalised;
    }

    const cached = this.lidToPhone.get(lidUser);
    if (cached) return cached;

    // Last resort: Baileys' signalRepository (may throw or return undefined)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const repo = (this.sock as any).signalRepository;
      const pn = await repo?.lidMapping?.getPNForLID?.(rawJid);
      if (pn) {
        const normalised = pn.endsWith('@s.whatsapp.net') ? pn : `${pn}@s.whatsapp.net`;
        this.lidToPhone.set(lidUser, normalised);
        return normalised;
      }
    } catch {
      /* fall through */
    }

    // Couldn't resolve — return the LID unchanged. The router will treat
    // it as an unregistered chat and ignore, which is the safe behaviour.
    return rawJid;
  }

  private async getNormalizedGroupMetadata(jid: string): Promise<GroupMetadata | undefined> {
    if (!jid.endsWith('@g.us')) return undefined;
    const cached = this.groupMetadataCache.get(jid);
    if (cached && cached.expiresAt > Date.now()) return cached.metadata;
    try {
      const metadata = await this.sock.groupMetadata(jid);
      this.groupMetadataCache.set(jid, {
        metadata,
        expiresAt: Date.now() + GROUP_METADATA_CACHE_TTL_MS,
      });
      return metadata;
    } catch (err) {
      logger.debug({ jid, err }, 'Group metadata fetch failed');
      return undefined;
    }
  }

  private async downloadInboundMedia(
    msg: WAMessage,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    normalized: any,
  ): Promise<{ kind: 'image' | 'file'; data: Buffer; mimeType: string; filename: string } | null> {
    type MediaSpec = {
      key: 'imageMessage' | 'videoMessage' | 'audioMessage' | 'documentMessage';
      kind: 'image' | 'file';
      defaultExt: string;
      defaultMime: string;
    };
    const mediaTypes: MediaSpec[] = [
      { key: 'imageMessage', kind: 'image', defaultExt: 'jpg', defaultMime: 'image/jpeg' },
      { key: 'videoMessage', kind: 'file', defaultExt: 'mp4', defaultMime: 'video/mp4' },
      { key: 'audioMessage', kind: 'file', defaultExt: 'ogg', defaultMime: 'audio/ogg' },
      { key: 'documentMessage', kind: 'file', defaultExt: '', defaultMime: 'application/octet-stream' },
    ];

    for (const spec of mediaTypes) {
      const media = normalized[spec.key];
      if (!media) continue;
      try {
        const buffer = (await downloadMediaMessage(
          msg,
          'buffer',
          {},
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { logger: baileysLogger as any, reuploadRequest: this.sock.updateMediaMessage },
        )) as Buffer;
        const mimeType: string = media.mimetype || spec.defaultMime;

        if (spec.key === 'documentMessage') {
          // documentMessage.fileName is attacker-controlled — sanitize.
          const raw = media.fileName as string | undefined | null;
          const safe = isSafeAttachmentName(raw)
            ? (raw as string)
            : `document-${Date.now()}.${spec.defaultExt || 'bin'}`;
          if (raw && safe !== raw) {
            logger.warn(
              { rejected: raw, replacement: safe },
              'Refused unsafe inbound document filename',
            );
          }
          return { kind: 'file', data: buffer, mimeType, filename: safe };
        }
        // Filename derived from mime (for image/video/audio — no inbound name)
        const subtype = mimeType.split('/')[1]?.split(';')[0] || spec.defaultExt;
        return {
          kind: spec.kind,
          data: buffer,
          mimeType,
          filename: `${spec.key.replace('Message', '')}-${Date.now()}.${subtype}`,
        };
      } catch (err) {
        logger.warn({ err, msgId: msg.key.id, key: spec.key }, 'Inbound media download failed');
        return null;
      }
    }
    return null;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.outgoingQueue.length > 0 && this.connected) {
        const item = this.outgoingQueue.shift()!;
        try {
          if (item.payload.mediaPath) {
            const data = fs.readFileSync(item.payload.mediaPath);
            const filename = path.basename(item.payload.mediaPath);
            const ext = path.extname(item.payload.mediaPath).toLowerCase();
            const payload = buildMediaMessage(data, filename, ext, item.payload.caption);
            const sent = await this.sock.sendMessage(item.jid, payload);
            this.recordSent(sent?.key?.id);
            logger.info({ jid: item.jid, filePath: item.payload.mediaPath }, 'Queued file sent');
          } else if (item.payload.text) {
            const sent = await this.sock.sendMessage(item.jid, { text: item.payload.text });
            this.recordSent(sent?.key?.id);
            logger.info({ jid: item.jid, length: item.payload.text.length }, 'Queued message sent');
          }
        } catch (err) {
          // Put it back at the front and bail — we'll retry on next flush.
          this.outgoingQueue.unshift(item);
          logger.warn({ err, jid: item.jid }, 'Queue flush failed, will retry');
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
