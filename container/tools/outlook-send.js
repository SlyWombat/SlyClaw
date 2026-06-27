#!/usr/bin/env node
/**
 * outlook-send — Microsoft Graph email sender for NanoClaw agent + HA bridge
 *
 * Usage (CLI):
 *   node outlook-send.js --to recipient@example.com --subject "Hi" --body "Hello there"
 *   echo "body from stdin" | node outlook-send.js --to x@y.com --subject "Stdin"
 *
 * Usage (module):
 *   import { sendMail } from './outlook-send.js';
 *   await sendMail({ to, subject, body, html, from? });
 *
 * Env vars (required):
 *   MS_GRAPH_CLIENT_ID
 *   MS_GRAPH_REFRESH_TOKEN
 *   MS_GRAPH_TENANT_ID (optional, default "common")
 *   GRAPH_DEFAULT_FROM (optional, default the authenticated user's primary email)
 *   GRAPH_DEFAULT_TO  (optional, default fallback when --to omitted)
 */
import https from 'https';




function httpsRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  const CLIENT_ID = process.env.MS_GRAPH_CLIENT_ID;
  const REFRESH_TOKEN = process.env.MS_GRAPH_REFRESH_TOKEN;
  const TENANT = process.env.MS_GRAPH_TENANT_ID || 'common';
  if (!CLIENT_ID || !REFRESH_TOKEN) throw new Error('MS_GRAPH_CLIENT_ID and MS_GRAPH_REFRESH_TOKEN required');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: REFRESH_TOKEN,
    scope: 'https://graph.microsoft.com/Mail.Send offline_access',
  }).toString();
  const r = await httpsRequest({
    hostname: 'login.microsoftonline.com',
    path: `/${TENANT}/oauth2/v2.0/token`,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  }, body);
  const j = JSON.parse(r.body);
  if (j.error) throw new Error(`token: ${j.error}: ${j.error_description}`);
  return j.access_token;
}

export async function sendMail({ to, subject, body, html, from }) {
  const token = await getAccessToken();
  const recipients = (Array.isArray(to) ? to : [to])
    .filter(Boolean)
    .map(addr => ({ emailAddress: { address: addr } }));
  if (recipients.length === 0) throw new Error('at least one recipient required');

  const message = {
    subject: subject || '(no subject)',
    body: html
      ? { contentType: 'HTML', content: html }
      : { contentType: 'Text', content: body || '' },
    toRecipients: recipients,
  };
  if (from) message.from = { emailAddress: { address: from } };

  const payload = JSON.stringify({ message, saveToSentItems: true });
  const r = await httpsRequest({
    hostname: 'graph.microsoft.com',
    path: '/v1.0/me/sendMail',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  }, payload);
  if (r.status === 202) return { ok: true };
  throw new Error(`sendMail HTTP ${r.status}: ${r.body}`);
}

// CLI mode
async function main() {
  const args = process.argv.slice(2);
  const opts = { to: process.env.GRAPH_DEFAULT_TO, from: process.env.GRAPH_DEFAULT_FROM };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--to') opts.to = args[++i];
    else if (args[i] === '--subject') opts.subject = args[++i];
    else if (args[i] === '--body') opts.body = args[++i];
    else if (args[i] === '--html') opts.html = args[++i];
    else if (args[i] === '--from') opts.from = args[++i];
  }
  if (!opts.body && !opts.html && !process.stdin.isTTY) {
    opts.body = await new Promise(r => { let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>r(d)); });
  }
  try {
    await sendMail(opts);
    console.log('sent');
  } catch (e) {
    console.error(`FAIL: ${e.message}`);
    process.exit(1);
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main();
