#!/usr/bin/env node
/**
 * outlook-read — Microsoft Graph email reader for NanoClaw agent
 *
 * Usage:
 *   node /workspace/tools/outlook-read.js list [--count N] [--folder inbox|sent|drafts|junk]
 *   node /workspace/tools/outlook-read.js read <message-id>
 *   node /workspace/tools/outlook-read.js search <query>
 *
 * Requires env vars: MS_GRAPH_CLIENT_ID, MS_GRAPH_REFRESH_TOKEN
 * Optional env var: MS_GRAPH_TENANT_ID (defaults to "common")
 */

import https from 'https';

const CLIENT_ID = process.env.MS_GRAPH_CLIENT_ID;
const REFRESH_TOKEN = process.env.MS_GRAPH_REFRESH_TOKEN;
const TENANT = process.env.MS_GRAPH_TENANT_ID || 'common';

if (!CLIENT_ID || !REFRESH_TOKEN) {
  console.error('Error: MS_GRAPH_CLIENT_ID and MS_GRAPH_REFRESH_TOKEN must be set in .env');
  process.exit(1);
}

function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString();
    const req = https.request({
      hostname,
      path,
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

function httpsGet(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'graph.microsoft.com',
      path,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) {
            reject(new Error(`Graph API error: ${parsed.error.code}: ${parsed.error.message}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${raw}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getAccessToken() {
  const response = await httpsPost('login.microsoftonline.com', `/${TENANT}/oauth2/v2.0/token`, {
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: REFRESH_TOKEN,
    scope: 'https://graph.microsoft.com/Mail.Read offline_access',
  });

  if (response.error) {
    throw new Error(`Token refresh failed: ${response.error}: ${response.error_description}`);
  }
  return response.access_token;
}

function formatDate(iso) {
  if (!iso) return 'Unknown';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseArgs(args) {
  const opts = { count: 10, folder: 'inbox', _rest: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--count' && args[i + 1]) {
      opts.count = parseInt(args[++i]) || 10;
    } else if (args[i] === '--folder' && args[i + 1]) {
      opts.folder = args[++i];
    } else {
      opts._rest.push(args[i]);
    }
  }
  return opts;
}

async function cmdList(args, token) {
  const opts = parseArgs(args);
  const folderMap = { inbox: 'inbox', sent: 'sentitems', drafts: 'drafts', junk: 'junkemail', archive: 'archive' };
  const folder = folderMap[opts.folder] || opts.folder;

  const data = await httpsGet(
    `/v1.0/me/mailFolders/${folder}/messages?$top=${opts.count}&$select=id,subject,from,receivedDateTime,isRead,bodyPreview&$orderby=receivedDateTime%20desc`,
    token,
  );

  if (!data.value || data.value.length === 0) {
    console.log('No messages found.');
    return;
  }

  for (const msg of data.value) {
    const unread = msg.isRead ? '' : ' [UNREAD]';
    const from = msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || 'Unknown';
    const date = formatDate(msg.receivedDateTime);
    // Show last 12 chars of ID as a short reference
    const shortId = msg.id.slice(-12);
    console.log(`[${shortId}]${unread}`);
    console.log(`  From: ${from}`);
    console.log(`  Date: ${date}`);
    console.log(`  Subject: ${msg.subject || '(no subject)'}`);
    console.log(`  Preview: ${(msg.bodyPreview || '').slice(0, 120)}...`);
    console.log();
  }
}

async function cmdRead(args, token) {
  const id = args[0];
  if (!id) {
    console.error('Usage: outlook-read read <message-id>');
    process.exit(1);
  }

  const msg = await httpsGet(
    `/v1.0/me/messages/${encodeURIComponent(id)}?$select=subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments`,
    token,
  );

  const fromAddr = msg.from?.emailAddress?.address || 'Unknown';
  const fromName = msg.from?.emailAddress?.name;
  const fromStr = fromName ? `${fromName} <${fromAddr}>` : fromAddr;
  const to = (msg.toRecipients || []).map(r => {
    const a = r.emailAddress?.address || '';
    const n = r.emailAddress?.name;
    return n ? `${n} <${a}>` : a;
  }).join(', ');
  const cc = (msg.ccRecipients || []).map(r => r.emailAddress?.address).filter(Boolean).join(', ');

  console.log(`From: ${fromStr}`);
  console.log(`To: ${to}`);
  if (cc) console.log(`CC: ${cc}`);
  console.log(`Date: ${formatDate(msg.receivedDateTime)}`);
  console.log(`Subject: ${msg.subject || '(no subject)'}`);
  if (msg.hasAttachments) console.log(`Attachments: yes`);
  console.log('---');
  const body = msg.body?.contentType === 'html'
    ? stripHtml(msg.body.content)
    : (msg.body?.content || '');
  console.log(body);
}

async function cmdSearch(args, token) {
  const query = args.join(' ');
  if (!query) {
    console.error('Usage: outlook-read search <query>');
    process.exit(1);
  }

  // Graph $search uses KQL syntax; wrap in quotes for phrase search
  const encoded = encodeURIComponent(`"${query}"`);
  const data = await httpsGet(
    `/v1.0/me/messages?$search=${encoded}&$top=10&$select=id,subject,from,receivedDateTime,isRead,bodyPreview`,
    token,
  );

  if (!data.value || data.value.length === 0) {
    console.log('No messages found matching that query.');
    return;
  }

  for (const msg of data.value) {
    const unread = msg.isRead ? '' : ' [UNREAD]';
    const from = msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || 'Unknown';
    const date = formatDate(msg.receivedDateTime);
    const shortId = msg.id.slice(-12);
    console.log(`[${shortId}]${unread}`);
    console.log(`  From: ${from}`);
    console.log(`  Date: ${date}`);
    console.log(`  Subject: ${msg.subject || '(no subject)'}`);
    console.log(`  Preview: ${(msg.bodyPreview || '').slice(0, 150)}...`);
    console.log();
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    console.log('Usage: node /workspace/tools/outlook-read.js <command> [options]');
    console.log('');
    console.log('Commands:');
    console.log('  list [--count N] [--folder inbox|sent|drafts|junk]');
    console.log('  read <message-id>');
    console.log('  search <query>');
    process.exit(0);
  }

  const token = await getAccessToken();

  switch (command) {
    case 'list':   await cmdList(rest, token); break;
    case 'read':   await cmdRead(rest, token); break;
    case 'search': await cmdSearch(rest, token); break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Commands: list, read, search');
      process.exit(1);
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
