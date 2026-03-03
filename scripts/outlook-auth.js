#!/usr/bin/env node
/**
 * NanoClaw Outlook Authentication
 *
 * One-time device code flow setup for Microsoft 365 email access.
 * Saves MS_GRAPH_CLIENT_ID, MS_GRAPH_REFRESH_TOKEN (and optionally
 * MS_GRAPH_TENANT_ID) to your .env file.
 *
 * Run: node scripts/outlook-auth.js
 *
 * Prerequisites — create an Azure AD app registration:
 *   1. https://portal.azure.com → "App registrations" → "New registration"
 *   2. Name: "NanoClaw", Supported account types: your org only (or multi-tenant)
 *   3. No redirect URI needed (public client / device code flow)
 *   4. Authentication → Advanced settings → "Allow public client flows" → Yes
 *   5. API permissions → Add → Microsoft Graph → Delegated:
 *        Mail.Read, offline_access → Grant admin consent
 *   6. Copy the Application (client) ID from the Overview page
 */

import https from 'https';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '..', '.env');

function httpsPost(hostname, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString();
    const req = https.request({
      hostname,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`Failed to parse response: ${raw}`)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function ask(rl, prompt) {
  return new Promise(resolve => rl.question(prompt, answer => resolve(answer.trim())));
}

function upsertEnv(content, key, value) {
  const lines = content.split('\n');
  const idx = lines.findIndex(l => l.startsWith(`${key}=`));
  if (idx !== -1) {
    lines[idx] = `${key}=${value}`;
    return lines.join('\n');
  }
  const trimmed = content.trimEnd();
  return trimmed ? `${trimmed}\n${key}=${value}\n` : `${key}=${value}\n`;
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n=== NanoClaw — Outlook Authentication ===\n');
  console.log('Before running this script, you need an Azure AD app registration.');
  console.log('See the script header comments for step-by-step instructions.\n');

  const clientId = await ask(rl, 'Application (client) ID: ');
  if (!clientId) {
    console.error('Client ID is required.');
    rl.close();
    process.exit(1);
  }

  const tenantInput = await ask(rl, 'Tenant ID (press Enter to use "organizations" for any work account): ');
  const tenant = tenantInput || 'organizations';

  console.log('\nRequesting device code from Microsoft...\n');

  const deviceCode = await httpsPost('login.microsoftonline.com', `/${tenant}/oauth2/v2.0/devicecode`, {
    client_id: clientId,
    scope: 'https://graph.microsoft.com/Mail.Read offline_access',
  });

  if (deviceCode.error) {
    console.error(`Error: ${deviceCode.error}: ${deviceCode.error_description}`);
    rl.close();
    process.exit(1);
  }

  console.log(deviceCode.message);
  console.log('\nWaiting for you to complete sign-in...');

  const intervalMs = (deviceCode.interval || 5) * 1000;
  const expiresAt = Date.now() + (deviceCode.expires_in || 900) * 1000;
  let refreshToken = null;

  while (Date.now() < expiresAt) {
    await new Promise(r => setTimeout(r, intervalMs));

    const token = await httpsPost('login.microsoftonline.com', `/${tenant}/oauth2/v2.0/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: deviceCode.device_code,
    });

    if (token.error === 'authorization_pending') continue;
    if (token.error === 'slow_down') { await new Promise(r => setTimeout(r, intervalMs)); continue; }
    if (token.error) {
      console.error(`\nAuthentication failed: ${token.error}: ${token.error_description}`);
      rl.close();
      process.exit(1);
    }

    refreshToken = token.refresh_token;
    break;
  }

  rl.close();

  if (!refreshToken) {
    console.error('\nAuthentication timed out. Please run the script again.');
    process.exit(1);
  }

  // Write to .env
  let envContent = '';
  try { envContent = fs.readFileSync(ENV_PATH, 'utf-8'); } catch { /* new file */ }

  envContent = upsertEnv(envContent, 'MS_GRAPH_CLIENT_ID', clientId);
  if (tenantInput) {
    envContent = upsertEnv(envContent, 'MS_GRAPH_TENANT_ID', tenant);
  }
  envContent = upsertEnv(envContent, 'MS_GRAPH_REFRESH_TOKEN', refreshToken);

  fs.writeFileSync(ENV_PATH, envContent);

  console.log('\n✓ Authentication successful!');
  console.log('✓ Credentials saved to .env');
  console.log('\nRestart NanoClaw to apply:');
  console.log('  npm run build && sudo systemctl restart nanoclaw');
  console.log('  # or: launchctl unload/load ~/Library/LaunchAgents/com.nanoclaw.plist\n');
}

main().catch(err => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
