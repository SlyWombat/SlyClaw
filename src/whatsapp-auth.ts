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
 * WhatsApp Authentication Script
 *
 * Run this during setup to authenticate with WhatsApp.
 * Displays QR code, waits for scan, saves session, then exits.
 *
 * Usage: npx tsx src/whatsapp-auth.ts
 */
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import QRCode from 'qrcode';
import wwebjs from 'whatsapp-web.js';
const { Client, LocalAuth } = wwebjs;

const STORE_DIR = './store';
const AUTH_DATA_PATH = path.join(STORE_DIR, 'wweb-auth');
const QR_FILE = path.join(STORE_DIR, 'qr-data.txt');
const STATUS_FILE = path.join(STORE_DIR, 'auth-status.txt');

const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--disable-gpu',
];

async function authenticate(): Promise<void> {
  fs.mkdirSync(AUTH_DATA_PATH, { recursive: true });
  try { fs.unlinkSync(QR_FILE); } catch {}
  try { fs.unlinkSync(STATUS_FILE); } catch {}

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_DATA_PATH }),
    puppeteer: { args: PUPPETEER_ARGS },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.67 Safari/537.36',
  });

  let qrEmitted = false;

  client.on('qr', async (qr) => {
    qrEmitted = true;
    fs.writeFileSync(QR_FILE, qr);

    // Print QR in terminal
    const terminalQr = await QRCode.toString(qr, { type: 'terminal', small: true }).catch(() => '');
    if (terminalQr) {
      console.log('\n' + terminalQr);
    }

    // Also open HTML page in browser (works on macOS and WSL2)
    try {
      const svg = await QRCode.toString(qr, { type: 'svg' });
      const template = fs.readFileSync('.claude/skills/setup/scripts/qr-auth.html', 'utf8');
      const htmlPath = path.join(STORE_DIR, 'qr-auth.html');
      fs.writeFileSync(htmlPath, template.replace('{{QR_SVG}}', svg).replace('{{GENERATED_AT}}', Date.now().toString()));
      const absPath = path.resolve(htmlPath);
      if (process.platform === 'darwin') {
        exec(`open "${absPath}"`);
      } else {
        // WSL2: convert to Windows path and open with default browser
        exec(`wslpath -w "${absPath}"`, (err, winPath) => {
          if (!err && winPath.trim()) {
            exec(`cmd.exe /c start "" "${winPath.trim().replace(/\\/g, '\\\\')}"`);
          }
        });
      }
    } catch {
      // browser open is best-effort
    }

    console.log('Scan this QR code with WhatsApp:\n');
    console.log('  1. Open WhatsApp on your phone');
    console.log('  2. Tap Settings → Linked Devices → Link a Device');
    console.log('  3. Point your camera at the QR code\n');
  });

  client.on('authenticated', () => {
    console.log('Authenticated — saving session...');
  });

  client.on('ready', async () => {
    if (!qrEmitted) {
      fs.writeFileSync(STATUS_FILE, 'already_authenticated');
      console.log('✓ Already authenticated with WhatsApp');
    } else {
      fs.writeFileSync(STATUS_FILE, 'authenticated');
      try { fs.unlinkSync(QR_FILE); } catch {}
      // Replace the QR page with a success page so the browser stops refreshing
      const htmlPath = path.join(STORE_DIR, 'qr-auth.html');
      try {
        fs.writeFileSync(htmlPath, '<!DOCTYPE html><html><head><title>SlyClaw</title><style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5}.card{background:#fff;border-radius:16px;padding:48px;box-shadow:0 4px 24px rgba(0,0,0,.1);text-align:center}h2{margin:0 0 8px;color:#25d366}p{color:#666;margin:8px 0 0}</style></head><body><div class="card"><h2>✓ Authenticated</h2><p>WhatsApp is connected. You can close this tab.</p></div></body></html>');
      } catch { /* best-effort */ }
      console.log('\n✓ Successfully authenticated with WhatsApp!');
      console.log('  Session saved to store/wweb-auth/');
      console.log('  You can now start the SlyClaw service.\n');
    }
    // Gracefully shut down Chrome so it flushes session data to disk before exit
    await client.destroy();
    process.exit(0);
  });

  client.on('auth_failure', (msg) => {
    fs.writeFileSync(STATUS_FILE, 'failed:auth_failure');
    console.error(`\n✗ Authentication failed: ${msg}`);
    process.exit(1);
  });

  client.on('disconnected', (reason) => {
    if (reason === 'LOGOUT') {
      fs.writeFileSync(STATUS_FILE, 'failed:logged_out');
    } else {
      fs.writeFileSync(STATUS_FILE, `failed:${reason}`);
    }
    console.error(`\n✗ Disconnected: ${reason}`);
    process.exit(1);
  });

  console.log('Starting WhatsApp authentication...\n');
  await client.initialize();
}

authenticate().catch((err) => {
  try { fs.writeFileSync(STATUS_FILE, 'failed:crash'); } catch {}
  console.error('Authentication failed:', err.message);
  process.exit(1);
});
