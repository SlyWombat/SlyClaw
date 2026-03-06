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
import {
  Client,
  Events,
  GatewayIntentBits,
  Message as DiscordMessage,
  Partials,
  TextBasedChannel,
} from 'discord.js';

import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

const MAX_MESSAGE_LENGTH = 2000;

export interface DiscordChannelOpts {
  token: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client;
  private connected = false;
  private opts: DiscordChannelOpts;

  constructor(opts: DiscordChannelOpts) {
    this.opts = opts;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.client.once(Events.ClientReady, (c) => {
        this.connected = true;
        logger.info({ tag: c.user.tag }, 'Connected to Discord');
        resolve();
      });

      this.client.on(Events.MessageCreate, (msg: DiscordMessage) => {
        this.handleMessage(msg).catch((err) =>
          logger.error({ err }, 'Discord message handler error'),
        );
      });

      this.client.login(this.opts.token).catch(reject);
    });
  }

  private async handleMessage(msg: DiscordMessage): Promise<void> {
    if (msg.author.bot) return;

    const chatJid = `dc:${msg.channelId}`;
    const timestamp = msg.createdAt.toISOString();

    // Derive a human-readable channel name for metadata
    const channelName = msg.guild
      ? `${msg.guild.name} #${'name' in msg.channel ? (msg.channel as { name: string }).name : 'channel'}`
      : 'Discord DM';
    this.opts.onChatMetadata(chatJid, timestamp, channelName);

    const groups = this.opts.registeredGroups();
    if (!groups[chatJid]) return;

    // Replace <@botId> and <@!botId> mentions with @AssistantName
    const botId = this.client.user?.id;
    let content = msg.content;
    if (botId) {
      content = content.replace(new RegExp(`<@!?${botId}>`, 'g'), `@${ASSISTANT_NAME}`);
    }

    const sender = `dc:${msg.author.id}`;
    const senderName =
      msg.member?.displayName || msg.author.globalName || msg.author.username;

    const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
      ? false
      : content.startsWith(`${ASSISTANT_NAME}:`);

    this.opts.onMessage(chatJid, {
      id: msg.id,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: isBotMessage,
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid }, 'Discord not connected, dropping message');
      return;
    }

    const channelId = jid.replace(/^dc:/, '');
    try {
      const ch = await this.client.channels.fetch(channelId);
      if (!ch?.isTextBased()) {
        logger.error({ jid }, 'Discord channel not text-based or not found');
        return;
      }

      const prefixed = ASSISTANT_HAS_OWN_NUMBER ? text : `${ASSISTANT_NAME}: ${text}`;

      // Split messages that exceed Discord's 2000-char limit
      const chunks: string[] = [];
      for (let i = 0; i < prefixed.length; i += MAX_MESSAGE_LENGTH) {
        chunks.push(prefixed.slice(i, i + MAX_MESSAGE_LENGTH));
      }
      for (const chunk of chunks) {
        await (ch as TextBasedChannel & { send(text: string): Promise<unknown> }).send(chunk);
      }

      logger.info({ jid, length: prefixed.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ err, jid }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.client.destroy();
  }
}
