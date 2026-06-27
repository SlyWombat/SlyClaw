#!/usr/bin/env node
/**
 * slyclaw-enqueue-shim — tiny LAN HTTP endpoint so the k1 kuma-bridge can
 * enqueue one-shot scheduled_tasks into slyclaw's local messages.db on k2.
 * (slyclaw has no HTTP enqueue endpoint; the bridge used to write the SQLite
 * DB directly when co-located. Post-migration the DB lives here on k2.)
 *
 * POST /enqueue { group?, prompt, chatJid?, idPrefix?, status?, nextRun? }
 *   - resolves chatJid from registered_groups (fallback to main jid)
 *   - inserts a one-shot scheduled_task (status default 'active', next_run now)
 * GET /health
 */
import http from 'http';
import Database from 'better-sqlite3';

const DB_PATH = '/data/slyclaw/store/messages.db';
const PORT = parseInt(process.env.SHIM_PORT || '3503', 10);
const FALLBACK_JID = '120363424649451143@g.us';
const log = (...a) => console.log(new Date().toISOString(), ...a);

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, ts: Date.now() }));
  }
  if (req.method !== 'POST' || req.url !== '/enqueue') {
    res.writeHead(404);
    return res.end('Not Found');
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      const p = body ? JSON.parse(body) : {};
      const group = p.group || 'main';
      const prompt = p.prompt;
      if (!prompt) throw new Error('need prompt');
      const status = p.status || 'active';
      const db = new Database(DB_PATH);
      let chatJid = p.chatJid;
      if (!chatJid) {
        const row = db.prepare('SELECT jid FROM registered_groups WHERE folder = ?').get(group);
        chatJid = (row && row.jid) || FALLBACK_JID;
      }
      const id = (p.idPrefix || 'kuma-notify') + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      const now = new Date().toISOString();
      const nextRun = p.nextRun || now;
      db.prepare(
        "INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at, context_mode) VALUES (?, ?, ?, ?, 'once', ?, ?, ?, ?, 'isolated')",
      ).run(id, group, chatJid, prompt, now, nextRun, status, now);
      db.close();
      log('enqueued', id, 'group=' + group, 'status=' + status);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, enqueued: id, chatJid }));
    } catch (e) {
      log('FAIL', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => log('enqueue-shim listening on :' + PORT));
