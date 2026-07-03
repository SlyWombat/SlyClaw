/*
 * outlook.ts — Microsoft Graph email reader for the in-process (Ollama/Gemini) path.
 *
 * Mirrors container/tools/outlook-read.js, but callable directly from the router
 * so the local model can read/search email WITHOUT delegating to the Claude
 * container. Read-only (Mail.Read): sending/replying still goes to Claude.
 *
 * Credentials are read on demand from .env via readEnvFile() — never held in
 * process.env — matching how container-runner.ts handles secrets.
 */
import { readEnvFile } from './env.js';

const GRAPH_HOST = 'https://graph.microsoft.com';
const TOKEN_REFRESH_MARGIN_MS = 60_000;

interface GraphAddress {
  name?: string;
  address?: string;
}
interface GraphRecipient {
  emailAddress?: GraphAddress;
}
interface GraphMessage {
  id: string;
  subject?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  isRead?: boolean;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  hasAttachments?: boolean;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

function graphCreds(): { clientId: string; refreshToken: string; tenant: string } {
  const env = readEnvFile(['MS_GRAPH_CLIENT_ID', 'MS_GRAPH_REFRESH_TOKEN', 'MS_GRAPH_TENANT_ID']);
  return {
    clientId: env.MS_GRAPH_CLIENT_ID ?? '',
    refreshToken: env.MS_GRAPH_REFRESH_TOKEN ?? '',
    tenant: env.MS_GRAPH_TENANT_ID || 'common',
  };
}

export function isEmailConfigured(): boolean {
  const { clientId, refreshToken } = graphCreds();
  return Boolean(clientId && refreshToken);
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
    return cachedToken.token;
  }
  const { clientId, refreshToken, tenant } = graphCreds();
  if (!clientId || !refreshToken) {
    throw new Error('Email not configured (MS_GRAPH_CLIENT_ID / MS_GRAPH_REFRESH_TOKEN missing)');
  }
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
      scope: 'https://graph.microsoft.com/Mail.Read offline_access',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || data.error || !data.access_token) {
    throw new Error(`Graph token refresh failed: ${data.error ?? res.status}: ${data.error_description ?? ''}`.trim());
  }
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cachedToken.token;
}

async function graphGet<T>(pathAndQuery: string): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${GRAPH_HOST}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json()) as T & { error?: { code?: string; message?: string } };
  if (!res.ok || data.error) {
    throw new Error(`Graph API error: ${data.error?.code ?? res.status}: ${data.error?.message ?? ''}`.trim());
  }
  return data;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtDate(iso?: string): string {
  if (!iso) return 'Unknown';
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
}

function stripHtml(html: string): string {
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

function addrName(a?: GraphAddress): string {
  return a?.name || a?.address || 'Unknown';
}

export interface EmailListResult {
  text: string;
  ids: string[];
}

// Render a numbered list the local model can reference ("read_email index 2").
// Exported for unit testing.
export function renderList(messages: GraphMessage[]): EmailListResult {
  if (!messages.length) return { text: 'No matching emails found.', ids: [] };
  const ids: string[] = [];
  const blocks = messages.map((m, i) => {
    ids.push(m.id);
    const unread = m.isRead ? '' : ' [UNREAD]';
    const preview = (m.bodyPreview || '').replace(/\s+/g, ' ').slice(0, 220);
    return (
      `[${i + 1}]${unread} ${fmtDate(m.receivedDateTime)} — from ${addrName(m.from?.emailAddress)}\n` +
      `  Subject: ${m.subject || '(no subject)'}\n` +
      `  ${preview}`
    );
  });
  return { text: blocks.join('\n\n'), ids };
}

const FOLDER_MAP: Record<string, string> = {
  inbox: 'inbox',
  sent: 'sentitems',
  drafts: 'drafts',
  junk: 'junkemail',
  archive: 'archive',
};

// ---------------------------------------------------------------------------
// Public read operations
// ---------------------------------------------------------------------------

export async function searchEmail(query: string, count = 10): Promise<EmailListResult> {
  const encoded = encodeURIComponent(`"${query}"`);
  const data = await graphGet<{ value?: GraphMessage[] }>(
    `/v1.0/me/messages?$search=${encoded}&$top=${count}&$select=id,subject,from,receivedDateTime,isRead,bodyPreview`,
  );
  return renderList(data.value ?? []);
}

export async function listEmail(folder = 'inbox', count = 10): Promise<EmailListResult> {
  const f = FOLDER_MAP[folder.toLowerCase()] || folder;
  const data = await graphGet<{ value?: GraphMessage[] }>(
    `/v1.0/me/mailFolders/${encodeURIComponent(f)}/messages?$top=${count}` +
      `&$select=id,subject,from,receivedDateTime,isRead,bodyPreview&$orderby=receivedDateTime%20desc`,
  );
  return renderList(data.value ?? []);
}

export async function readEmail(id: string): Promise<string> {
  const m = await graphGet<GraphMessage>(
    `/v1.0/me/messages/${encodeURIComponent(id)}?$select=subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments`,
  );
  const bodyRaw = m.body?.contentType === 'html' ? stripHtml(m.body.content || '') : m.body?.content || '';
  const to = (m.toRecipients || []).map((r) => addrName(r.emailAddress)).join(', ');
  const cc = (m.ccRecipients || []).map((r) => r.emailAddress?.address).filter(Boolean).join(', ');
  return [
    `From: ${addrName(m.from?.emailAddress)}`,
    `To: ${to}`,
    cc ? `CC: ${cc}` : '',
    `Date: ${fmtDate(m.receivedDateTime)}`,
    `Subject: ${m.subject || '(no subject)'}`,
    m.hasAttachments ? 'Attachments: yes' : '',
    '---',
    bodyRaw.slice(0, 6000),
  ]
    .filter(Boolean)
    .join('\n');
}
