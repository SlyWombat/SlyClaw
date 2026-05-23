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
 * Smoke tests for WhatsAppChannel (Baileys-based).
 *
 * Deliberately thin: previous tests mocked wweb-js client internals;
 * Baileys has a much larger surface (signalRepository, lid-mapping,
 * groupFetchAllParticipating, multi-file auth state, event emitter
 * for connection.update / messages.upsert / creds.update). Mocking it
 * faithfully is a substantial harness and adds little safety beyond
 * what the live integration provides.
 *
 * The real correctness signal is the daemon connecting on startup and
 * messages round-tripping through the orchestrator — verified by the
 * service successfully sending the snarky startup-check message to the
 * main WhatsApp group after each restart.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  STORE_DIR: '/tmp/slyclaw-test-store',
  ASSISTANT_NAME: 'Nano',
  ASSISTANT_HAS_OWN_NUMBER: false,
}));
vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../db.js', () => ({
  getLastGroupSync: vi.fn(() => null),
  setLastGroupSync: vi.fn(),
  updateChatName: vi.fn(),
}));

import { WhatsAppChannel } from './whatsapp.js';

describe('WhatsAppChannel', () => {
  it('can be instantiated and exposes the Channel interface', () => {
    const channel = new WhatsAppChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    expect(channel.name).toBe('whatsapp');
    expect(typeof channel.connect).toBe('function');
    expect(typeof channel.disconnect).toBe('function');
    expect(typeof channel.sendMessage).toBe('function');
    expect(typeof channel.sendFile).toBe('function');
    expect(typeof channel.setTyping).toBe('function');
    expect(typeof channel.syncGroupMetadata).toBe('function');
    expect(typeof channel.isConnected).toBe('function');
    expect(typeof channel.ownsJid).toBe('function');
    expect(channel.isConnected()).toBe(false);
  });

  it('ownsJid recognises WhatsApp JID formats', () => {
    const channel = new WhatsAppChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    expect(channel.ownsJid('1234567890@s.whatsapp.net')).toBe(true);
    expect(channel.ownsJid('1234567890-1234567@g.us')).toBe(true);
    expect(channel.ownsJid('alexa:default')).toBe(false);
    expect(channel.ownsJid('telegram:123')).toBe(false);
  });

  it('queues messages when not connected', async () => {
    const channel = new WhatsAppChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    // Not connected — should queue silently (not throw, not block)
    await expect(
      channel.sendMessage('1234567890@s.whatsapp.net', 'hello'),
    ).resolves.toBeUndefined();
    // setTyping is a no-op when disconnected
    await expect(
      channel.setTyping('1234567890@s.whatsapp.net', true),
    ).resolves.toBeUndefined();
    // syncGroupMetadata is a no-op when disconnected
    await expect(channel.syncGroupMetadata()).resolves.toBeUndefined();
  });
});
