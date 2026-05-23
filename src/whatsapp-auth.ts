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
 * Standalone WhatsApp pair script.
 *
 * Spins up the same WhatsAppChannel the daemon uses, runs through its QR
 * / pairing-code flow, then exits cleanly once Baileys reports `Connected
 * to WhatsApp`. Run during /setup or after a logout — for normal operation
 * the daemon handles pairing on first start without needing this.
 *
 * Usage: npm run auth
 */
import { WhatsAppChannel } from './channels/whatsapp.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  logger.info('Starting WhatsApp authentication...');
  logger.info('If no session exists, a QR code (or pairing code) will be printed below.');

  const channel = new WhatsAppChannel({
    onMessage: () => {
      /* discard — we only want to confirm the auth handshake */
    },
    onChatMetadata: () => {
      /* discard */
    },
    registeredGroups: () => ({}),
  });

  try {
    await channel.connect();
    logger.info('Successfully authenticated with WhatsApp.');
    logger.info('  Session saved to store/auth/');
    logger.info('  You can now start the SlyClaw service.');
  } catch (err) {
    logger.error({ err }, 'WhatsApp authentication failed');
    process.exit(1);
  }

  // Give Baileys a moment to flush creds.json, then exit.
  await new Promise((r) => setTimeout(r, 1500));
  await channel.disconnect();
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'WhatsApp auth script failed');
  process.exit(1);
});
