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
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// --- Mocks ---

vi.mock('../config.js', () => ({
  STORE_DIR: '/tmp/slyclaw-test-store',
  ASSISTANT_NAME: 'Nano',
  ASSISTANT_HAS_OWN_NUMBER: false,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db.js', () => ({
  getLastGroupSync: vi.fn(() => null),
  setLastGroupSync: vi.fn(),
  updateChatName: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
  };
});

// Build a fake whatsapp-web.js Client that's an EventEmitter with the methods we need
function createFakeClient() {
  const client = new EventEmitter() as EventEmitter & {
    initialize: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    getChats: ReturnType<typeof vi.fn>;
    getChatById: ReturnType<typeof vi.fn>;
  };
  client.initialize = vi.fn().mockResolvedValue(undefined);
  client.sendMessage = vi.fn().mockResolvedValue(undefined);
  client.destroy = vi.fn().mockResolvedValue(undefined);
  client.getChats = vi.fn().mockResolvedValue([]);
  client.getChatById = vi.fn().mockResolvedValue({
    sendStateTyping: vi.fn().mockResolvedValue(undefined),
    clearState: vi.fn().mockResolvedValue(undefined),
  });
  return client;
}

let fakeClient: ReturnType<typeof createFakeClient>;

// Mock whatsapp-web.js
// whatsapp.ts uses `import wwebjs from 'whatsapp-web.js'` (default import) then
// destructures Client and LocalAuth from it — so the mock must include a `default`
// export that mirrors the real module shape (CJS module.exports = { Client, ... }).
vi.mock('whatsapp-web.js', () => {
  // Must use regular functions (not arrows) so they can be called with `new`
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const Client = vi.fn(function (_opts: unknown) { return fakeClient; });
  const LocalAuth = vi.fn(function () {});
  return {
    default: { Client, LocalAuth },
    Client,
    LocalAuth,
  };
});

import { WhatsAppChannel, WhatsAppChannelOpts } from './whatsapp.js';
import { getLastGroupSync, updateChatName, setLastGroupSync } from '../db.js';

// --- Test helpers ---

function createTestOpts(overrides?: Partial<WhatsAppChannelOpts>): WhatsAppChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'registered@g.us': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Nano',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

/**
 * Helper: start connect, flush microtasks so event handlers are registered,
 * then trigger the ready event. Returns the resolved promise.
 */
async function connectChannel(channel: WhatsAppChannel): Promise<void> {
  const p = channel.connect();
  // Flush microtasks so connectInternal registers handlers and initialize() resolves
  await new Promise((r) => setTimeout(r, 0));
  fakeClient.emit('ready');
  return p;
}

async function triggerMessage(msg: Record<string, unknown>) {
  fakeClient.emit('message_create', msg);
  // Flush microtasks so the async message_create handler completes
  await new Promise((r) => setTimeout(r, 0));
}

// --- Tests ---

describe('WhatsAppChannel', () => {
  beforeEach(() => {
    fakeClient = createFakeClient();
    vi.mocked(getLastGroupSync).mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when ready event fires', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      expect(channel.isConnected()).toBe(true);
    });

    it('flushes outgoing queue on reconnect', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // Disconnect
      (channel as any).connected = false;

      // Queue a message while disconnected
      await channel.sendMessage('test@g.us', 'Queued message');
      expect(fakeClient.sendMessage).not.toHaveBeenCalled();

      // Reconnect
      (channel as any).connected = true;
      await (channel as any).flushOutgoingQueue();

      // Group messages get prefixed when flushed; @g.us JID is unchanged
      expect(fakeClient.sendMessage).toHaveBeenCalledWith(
        'test@g.us',
        'Nano: Queued message',
      );
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      expect(fakeClient.destroy).toHaveBeenCalled();
    });
  });

  // --- QR code and auth ---

  describe('authentication', () => {
    it('exits process when QR code is emitted (session expired)', async () => {
      vi.useFakeTimers();
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      // Start connect but don't await (it won't resolve — process exits)
      channel.connect().catch(() => {});

      // Flush microtasks so connectInternal registers handlers
      await vi.advanceTimersByTimeAsync(0);

      // Emit QR code event — means session expired in the running service
      fakeClient.emit('qr', 'some-qr-data');

      // Advance timer past the 1000ms setTimeout before exit
      await vi.advanceTimersByTimeAsync(1500);

      expect(mockExit).toHaveBeenCalledWith(1);
      mockExit.mockRestore();
      vi.useRealTimers();
    });
  });

  // --- Reconnection behavior ---

  describe('reconnection', () => {
    it('marks as disconnected when disconnected event fires', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);
      expect(channel.isConnected()).toBe(true);

      fakeClient.emit('disconnected', 'CONN_FAILURE');

      expect(channel.isConnected()).toBe(false);
    });

    it('exits on LOGOUT disconnect', async () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      fakeClient.emit('disconnected', 'LOGOUT');

      expect(channel.isConnected()).toBe(false);
      expect(mockExit).toHaveBeenCalledWith(0);
      mockExit.mockRestore();
    });

    it('does not exit on non-LOGOUT disconnect', async () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      fakeClient.emit('disconnected', 'CONN_FAILURE');

      expect(mockExit).not.toHaveBeenCalled();
      mockExit.mockRestore();
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      const ts = Math.floor(Date.now() / 1000);
      await triggerMessage({
        from: 'registered@g.us',
        body: 'Hello Nano',
        author: '5551234@s.whatsapp.net',
        fromMe: false,
        timestamp: ts,
        id: { _serialized: 'msg-1' },
        getContact: vi.fn().mockResolvedValue({ pushname: 'Alice', name: 'Alice' }),
      });

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'registered@g.us',
        expect.any(String),
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          id: 'msg-1',
          content: 'Hello Nano',
          sender_name: 'Alice',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered groups', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessage({
        from: 'unregistered@g.us',
        body: 'Hello',
        author: '5551234@s.whatsapp.net',
        fromMe: false,
        timestamp: Math.floor(Date.now() / 1000),
        id: { _serialized: 'msg-2' },
        getContact: vi.fn().mockResolvedValue({ pushname: 'Bob' }),
      });

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'unregistered@g.us',
        expect.any(String),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores messages with no from field', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessage({
        from: undefined,
        body: 'No from',
        fromMe: false,
        timestamp: Math.floor(Date.now() / 1000),
        id: { _serialized: 'msg-3' },
      });

      expect(opts.onChatMetadata).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('delivers message with empty body', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessage({
        from: 'registered@g.us',
        body: '',
        author: '5551234@s.whatsapp.net',
        fromMe: false,
        timestamp: Math.floor(Date.now() / 1000),
        id: { _serialized: 'msg-4' },
        getContact: vi.fn().mockResolvedValue({ pushname: 'Frank' }),
      });

      // Still delivered, just with empty content
      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({ content: '' }),
      );
    });

    it('falls back to JID username when getContact fails', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessage({
        from: 'registered@g.us',
        body: 'No contact',
        author: '5551234@s.whatsapp.net',
        fromMe: false,
        timestamp: Math.floor(Date.now() / 1000),
        id: { _serialized: 'msg-5' },
        getContact: vi.fn().mockRejectedValue(new Error('Contact fetch failed')),
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({ sender_name: '5551234' }),
      );
    });

    it('normalizes @c.us JIDs to @s.whatsapp.net for DMs', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          '1234567890@s.whatsapp.net': {
            name: 'Self Chat',
            folder: 'self-chat',
            trigger: '@Nano',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessage({
        from: '1234567890@c.us',
        body: 'DM message',
        fromMe: false,
        timestamp: Math.floor(Date.now() / 1000),
        id: { _serialized: 'msg-6' },
        getContact: vi.fn().mockResolvedValue({ pushname: 'Self' }),
      });

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        '1234567890@s.whatsapp.net',
        expect.any(String),
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        '1234567890@s.whatsapp.net',
        expect.objectContaining({ id: 'msg-6' }),
      );
    });

    it('uses author for sender in group messages', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessage({
        from: 'registered@g.us',
        body: 'Group message',
        author: '5551234@s.whatsapp.net',
        fromMe: false,
        timestamp: Math.floor(Date.now() / 1000),
        id: { _serialized: 'msg-7' },
        getContact: vi.fn().mockResolvedValue({ pushname: 'GroupMember' }),
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          sender: '5551234@s.whatsapp.net',
          sender_name: 'GroupMember',
        }),
      );
    });
  });

  // --- Outgoing message queue ---

  describe('outgoing message queue', () => {
    it('sends message directly when connected', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await channel.sendMessage('test@g.us', 'Hello');
      // Group messages get prefixed; @g.us JID is unchanged
      expect(fakeClient.sendMessage).toHaveBeenCalledWith('test@g.us', 'Nano: Hello');
    });

    it('converts @s.whatsapp.net to @c.us when calling sendMessage', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await channel.sendMessage('123@s.whatsapp.net', 'Hello');
      expect(fakeClient.sendMessage).toHaveBeenCalledWith('123@c.us', 'Nano: Hello');
    });

    it('queues message when disconnected', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      // Don't connect — channel starts disconnected
      await channel.sendMessage('test@g.us', 'Queued');
      expect(fakeClient.sendMessage).not.toHaveBeenCalled();
    });

    it('queues message on send failure', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // Make sendMessage fail
      fakeClient.sendMessage.mockRejectedValueOnce(new Error('Network error'));

      // Should not throw, message is queued for retry
      await expect(channel.sendMessage('test@g.us', 'Will fail')).resolves.toBeUndefined();
    });

    it('flushes multiple queued messages in order', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      // Queue messages while disconnected (before connect, so no client yet)
      await channel.sendMessage('test@g.us', 'First');
      await channel.sendMessage('test@g.us', 'Second');
      await channel.sendMessage('test@g.us', 'Third');

      // Connect — flush happens automatically on ready
      await connectChannel(channel);

      // Give the async flush time to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(fakeClient.sendMessage).toHaveBeenCalledTimes(3);
      expect(fakeClient.sendMessage).toHaveBeenNthCalledWith(1, 'test@g.us', 'Nano: First');
      expect(fakeClient.sendMessage).toHaveBeenNthCalledWith(2, 'test@g.us', 'Nano: Second');
      expect(fakeClient.sendMessage).toHaveBeenNthCalledWith(3, 'test@g.us', 'Nano: Third');
    });
  });

  // --- Group metadata sync ---

  describe('group metadata sync', () => {
    it('syncs group metadata on first connection', async () => {
      fakeClient.getChats.mockResolvedValue([
        { isGroup: true, id: { _serialized: 'group1@g.us' }, name: 'Group One' },
        { isGroup: true, id: { _serialized: 'group2@g.us' }, name: 'Group Two' },
        { isGroup: false, id: { _serialized: '123@c.us' }, name: 'Contact' },
      ]);

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // Wait for async sync to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(fakeClient.getChats).toHaveBeenCalled();
      expect(updateChatName).toHaveBeenCalledWith('group1@g.us', 'Group One');
      expect(updateChatName).toHaveBeenCalledWith('group2@g.us', 'Group Two');
      // Non-group contacts should be filtered out
      expect(updateChatName).not.toHaveBeenCalledWith('123@c.us', expect.any(String));
      expect(setLastGroupSync).toHaveBeenCalled();
    });

    it('skips sync when synced recently', async () => {
      // Last sync was 1 hour ago (within 24h threshold)
      vi.mocked(getLastGroupSync).mockReturnValue(
        new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      );

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await new Promise((r) => setTimeout(r, 50));

      expect(fakeClient.getChats).not.toHaveBeenCalled();
    });

    it('forces sync regardless of cache', async () => {
      vi.mocked(getLastGroupSync).mockReturnValue(
        new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      );

      fakeClient.getChats.mockResolvedValue([
        { isGroup: true, id: { _serialized: 'group@g.us' }, name: 'Forced Group' },
      ]);

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await channel.syncGroupMetadata(true);

      expect(fakeClient.getChats).toHaveBeenCalled();
      expect(updateChatName).toHaveBeenCalledWith('group@g.us', 'Forced Group');
    });

    it('handles group sync failure gracefully', async () => {
      fakeClient.getChats.mockRejectedValue(new Error('Network timeout'));

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // Should not throw
      await expect(channel.syncGroupMetadata(true)).resolves.toBeUndefined();
    });

    it('skips groups with no name', async () => {
      fakeClient.getChats.mockResolvedValue([
        { isGroup: true, id: { _serialized: 'group1@g.us' }, name: 'Has Name' },
        { isGroup: true, id: { _serialized: 'group2@g.us' }, name: '' },
        { isGroup: true, id: { _serialized: 'group3@g.us' }, name: undefined },
      ]);

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // Clear calls from the automatic sync on connect
      vi.mocked(updateChatName).mockClear();

      await channel.syncGroupMetadata(true);

      expect(updateChatName).toHaveBeenCalledTimes(1);
      expect(updateChatName).toHaveBeenCalledWith('group1@g.us', 'Has Name');
    });
  });

  // --- JID ownership ---

  describe('ownsJid', () => {
    it('owns @g.us JIDs (WhatsApp groups)', () => {
      const channel = new WhatsAppChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(true);
    });

    it('owns @s.whatsapp.net JIDs (WhatsApp DMs)', () => {
      const channel = new WhatsAppChannel(createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(true);
    });

    it('owns @c.us JIDs (whatsapp-web.js DM format)', () => {
      const channel = new WhatsAppChannel(createTestOpts());
      expect(channel.ownsJid('12345@c.us')).toBe(true);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new WhatsAppChannel(createTestOpts());
      expect(channel.ownsJid('tg:12345')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new WhatsAppChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- Typing indicator ---

  describe('setTyping', () => {
    it('calls sendStateTyping on chat when typing', async () => {
      const mockChat = {
        sendStateTyping: vi.fn().mockResolvedValue(undefined),
        clearState: vi.fn().mockResolvedValue(undefined),
      };
      fakeClient.getChatById.mockResolvedValue(mockChat);

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await channel.setTyping('test@g.us', true);
      expect(fakeClient.getChatById).toHaveBeenCalledWith('test@g.us');
      expect(mockChat.sendStateTyping).toHaveBeenCalled();
    });

    it('calls clearState on chat when not typing', async () => {
      const mockChat = {
        sendStateTyping: vi.fn().mockResolvedValue(undefined),
        clearState: vi.fn().mockResolvedValue(undefined),
      };
      fakeClient.getChatById.mockResolvedValue(mockChat);

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await channel.setTyping('test@g.us', false);
      expect(mockChat.clearState).toHaveBeenCalled();
    });

    it('handles typing indicator failure gracefully', async () => {
      fakeClient.getChatById.mockRejectedValueOnce(new Error('Failed'));

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // Should not throw
      await expect(channel.setTyping('test@g.us', true)).resolves.toBeUndefined();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "whatsapp"', () => {
      const channel = new WhatsAppChannel(createTestOpts());
      expect(channel.name).toBe('whatsapp');
    });

    it('does not expose prefixAssistantName (prefix handled internally)', () => {
      const channel = new WhatsAppChannel(createTestOpts());
      expect('prefixAssistantName' in channel).toBe(false);
    });
  });
});
