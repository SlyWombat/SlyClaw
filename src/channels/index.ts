/*
 *   ____  _            ____ _
 *  / ___|| |_   _     / ___| | __ ___      __
 *  \___ \| | | | |   | |   | |/ _` \ \ /\ / /
 *   ___) | | |_| |   | |___| | (_| |\ V  V /
 *  |____/|_|\__, |    \____|_|\__,_| \_/\_/
 *           |___/
 */
/**
 * Channel barrel.
 *
 * Importing this file triggers every channel module's bottom-of-file
 * `registerChannel(...)` call, populating the registry before the host
 * iterates it via `createAllChannels()`.
 *
 * **Order matters.** Channels are instantiated in registration order
 * (`Map` insertion order). The host connects them serially in the same
 * order, so put WhatsApp first (it can block on QR scan), then anything
 * lightweight (Alexa/Express, future channels).
 */
import './whatsapp.js';
import './alexa.js';

export { createAllChannels, listRegisteredChannels, registerChannel } from './channel-registry.js';
export type { ChannelFactory, ChannelFactoryOpts } from './channel-registry.js';

// Re-export class names + constants the host still references by type.
export { WhatsAppChannel } from './whatsapp.js';
export { AlexaChannel, ALEXA_JID } from './alexa.js';
