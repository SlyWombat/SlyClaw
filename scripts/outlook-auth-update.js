#!/usr/bin/env node
/**
 * Re-authorize the existing NanoClaw Azure app with expanded scopes
 * (adds Mail.Send to the existing Mail.Read).
 *
 * Reads MS_GRAPH_CLIENT_ID + MS_GRAPH_TENANT_ID from .env. Prints a device
 * code, polls login.microsoftonline.com, writes new refresh token to .env.
 */
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '..', '.env');

function readEnv() {
  const lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n');
  const env = {};
  for (const l of lines) {
    const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

function writeEnvKey(key, value) {
  const content = fs.readFileSync(ENV_PATH, 'utf-8');
  const lines = content.split('\n');
  const idx = lines.findIndex(l => l.startsWith(`${key}=`));
  if (idx !== -1) lines[idx] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  fs.writeFileSync(ENV_PATH, lines.join('\n'));
}

function httpsPost(host, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString();
    const req = https.request({
      hostname: host, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error(raw)); } });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function main() {
  const env = readEnv();
  const CLIENT_ID = env.MS_GRAPH_CLIENT_ID;
  const TENANT = env.MS_GRAPH_TENANT_ID || 'common';
  if (!CLIENT_ID) { console.error('MS_GRAPH_CLIENT_ID missing from .env'); process.exit(1); }

  const SCOPES = 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send offline_access';

  const dc = await httpsPost('login.microsoftonline.com', `/${TENANT}/oauth2/v2.0/devicecode`, {
    client_id: CLIENT_ID, scope: SCOPES,
  });
  if (dc.error) { console.error(`Device code error: ${dc.error}: ${dc.error_description}`); process.exit(1); }

  // Print device code prominently for the user
  console.log('===DEVICE-CODE-BLOCK===');
  console.log(`URL:  ${dc.verification_uri}`);
  console.log(`CODE: ${dc.user_code}`);
  console.log(`EXPIRES IN: ${dc.expires_in}s`);
  console.log('===END-DEVICE-CODE-BLOCK===');

  const intervalMs = (dc.interval || 5) * 1000;
  const expiresAt = Date.now() + (dc.expires_in || 900) * 1000;

  while (Date.now() < expiresAt) {
    await new Promise(r => setTimeout(r, intervalMs));
    const t = await httpsPost('login.microsoftonline.com', `/${TENANT}/oauth2/v2.0/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: CLIENT_ID, device_code: dc.device_code,
    });
    if (t.error === 'authorization_pending' || t.error === 'slow_down') continue;
    if (t.error) { console.error(`AUTH-FAIL: ${t.error}: ${t.error_description}`); process.exit(1); }

    writeEnvKey('MS_GRAPH_REFRESH_TOKEN', t.refresh_token);
    console.log('SUCCESS: new refresh token written to .env');
    console.log(`SCOPES: ${t.scope}`);
    process.exit(0);
  }
  console.error('TIMEOUT: no auth within window'); process.exit(1);
}
main().catch(e => { console.error(`ERR: ${e.message}`); process.exit(1); });
