/*
 *   ____  _            ____ _
 *  / ___|| |_   _     / ___| | __ ___      __
 *  \___ \| | | | |   | |   | |/ _` \ \ /\ / /
 *   ___) | | |_| |   | |___| | (_| |\ V  V /
 *  |____/|_|\__, |    \____|_|\__,_| \_/\_/
 *           |___/
 *
 *  Channel adapter registry — patterned after qwibitai/nanoclaw
 *  but adapted to our `Channel` class shape.
 */
/**
 * Channel adapter registry.
 *
 * Channel modules self-register at import-time. The host calls
 * `createAllChannels(opts)` once at startup, gets back every active
 * adapter, and wires them into the routing layer without needing to
 * know which channels are compiled in.
 *
 * Adding a new channel:
 *   1. Implement `Channel` in `src/channels/<name>.ts`
 *   2. At the bottom of that file, call `registerChannel('<name>', factory)`
 *   3. Import the new file in `src/channels/index.ts` so the bottom-of-file
 *      registration runs at app startup
 *
 * That's it — no edits to `index.ts` needed for new channels.
 *
 * Per-channel disable: the factory returns `null` (e.g. when a required
 * env var like `ALEXA_PORT` isn't set). createAllChannels skips nulls.
 */
import { Channel, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';

export interface ChannelFactoryOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export type ChannelFactory = (opts: ChannelFactoryOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  if (registry.has(name)) {
    throw new Error(`Channel adapter "${name}" registered twice`);
  }
  registry.set(name, factory);
}

export function listRegisteredChannels(): string[] {
  return Array.from(registry.keys());
}

/**
 * Instantiate every registered channel whose factory returns non-null.
 * Iteration order matches registration order (Map insertion order), which
 * matches the import order in `src/channels/index.ts`.
 */
export function createAllChannels(opts: ChannelFactoryOpts): Channel[] {
  const channels: Channel[] = [];
  for (const [name, factory] of registry) {
    try {
      const ch = factory(opts);
      if (ch) {
        channels.push(ch);
        logger.debug({ name }, 'Channel adapter instantiated');
      } else {
        logger.debug({ name }, 'Channel adapter skipped (factory returned null)');
      }
    } catch (err) {
      logger.error({ name, err }, 'Channel adapter factory threw — skipping');
    }
  }
  return channels;
}
