#!/bin/bash
set -euo pipefail

# 05-sync-groups.sh — Connect to WhatsApp, fetch group metadata, write to DB, exit.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [sync-groups] $*" >> "$LOG_FILE"; }

cd "$PROJECT_ROOT"

# Build TypeScript
log "Building TypeScript"
BUILD="failed"
if npm run build >> "$LOG_FILE" 2>&1; then
  BUILD="success"
  log "Build succeeded"
else
  log "Build failed"
  cat <<EOF
=== NANOCLAW SETUP: SYNC_GROUPS ===
BUILD: failed
SYNC: skipped
GROUPS_IN_DB: 0
STATUS: failed
ERROR: build_failed
LOG: logs/setup.log
=== END ===
EOF
  exit 1
fi

# Directly connect, fetch groups, write to DB, exit
log "Fetching group metadata directly"
SYNC="failed"

SYNC_OUTPUT=$(node -e "
const { Client, LocalAuth } = (await import('whatsapp-web.js'));
const { default: Database } = (await import('better-sqlite3'));
const { default: fs } = (await import('fs'));

const authDir = 'store/wweb-auth';
const dbPath = 'store/messages.db';

if (!fs.existsSync(authDir) || !fs.readdirSync(authDir).length) {
  console.error('NO_AUTH');
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT)');

const upsert = db.prepare(
  'INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?) ON CONFLICT(jid) DO UPDATE SET name = excluded.name'
);

// Timeout after 90s (Puppeteer takes longer to start than Baileys)
const timeout = setTimeout(() => {
  console.error('TIMEOUT');
  process.exit(1);
}, 90000);

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: authDir }),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-gpu']
  }
});

client.on('ready', async () => {
  try {
    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup);
    const now = new Date().toISOString();
    let count = 0;
    for (const group of groups) {
      const jid = group.id._serialized;
      if (group.name) {
        upsert.run(jid, group.name, now);
        count++;
      }
    }
    console.log('SYNCED:' + count);
  } catch (err) {
    console.error('FETCH_ERROR:' + err.message);
  } finally {
    clearTimeout(timeout);
    await client.destroy();
    db.close();
    process.exit(0);
  }
});

client.on('disconnected', () => {
  clearTimeout(timeout);
  console.error('CONNECTION_CLOSED');
  process.exit(1);
});

client.on('qr', () => {
  clearTimeout(timeout);
  console.error('NO_AUTH');
  process.exit(1);
});

await client.initialize();
" --input-type=module 2>&1) || true

log "Sync output: $SYNC_OUTPUT"

if echo "$SYNC_OUTPUT" | grep -q "SYNCED:"; then
  SYNC="success"
fi

# Check for groups in DB
GROUPS_IN_DB=0
if [ -f "$PROJECT_ROOT/store/messages.db" ]; then
  GROUPS_IN_DB=$(sqlite3 "$PROJECT_ROOT/store/messages.db" "SELECT COUNT(*) FROM chats WHERE jid LIKE '%@g.us' AND jid <> '__group_sync__'" 2>/dev/null || echo "0")
  log "Groups found in DB: $GROUPS_IN_DB"
fi

STATUS="success"
if [ "$SYNC" != "success" ]; then
  STATUS="failed"
fi

cat <<EOF
=== NANOCLAW SETUP: SYNC_GROUPS ===
BUILD: $BUILD
SYNC: $SYNC
GROUPS_IN_DB: $GROUPS_IN_DB
STATUS: $STATUS
LOG: logs/setup.log
=== END ===
EOF

if [ "$STATUS" = "failed" ]; then
  exit 1
fi
