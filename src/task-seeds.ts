import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from './config.js';
import {
  createTask,
  getAllRegisteredGroups,
  getTaskById,
  updateTask,
} from './db.js';
import { logger } from './logger.js';

// Source of truth for "managed" scheduled tasks: JSON metadata + a sibling
// .prompt.md (default name is <basename>.prompt.md). Loaded on startup and
// upserted into scheduled_tasks. See tasks/README.md for the schema and
// the upsert semantics.

const SEEDS_DIR = path.resolve(process.cwd(), 'tasks');

interface TaskSeed {
  id: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode?: 'group' | 'isolated';
  prompt?: string;
  prompt_file?: string;
}

function isTaskSeed(value: unknown): value is TaskSeed {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    (v.schedule_type === 'cron' ||
      v.schedule_type === 'interval' ||
      v.schedule_type === 'once') &&
    typeof v.schedule_value === 'string'
  );
}

function computeNextRun(seed: TaskSeed): string | null {
  if (seed.schedule_type === 'cron') {
    return CronExpressionParser.parse(seed.schedule_value, { tz: TIMEZONE })
      .next()
      .toISOString();
  }
  if (seed.schedule_type === 'interval') {
    const ms = parseInt(seed.schedule_value, 10);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return new Date(Date.now() + ms).toISOString();
  }
  // 'once': schedule_value is the target ISO timestamp
  return seed.schedule_value;
}

function findGroupJid(groupFolder: string): string | undefined {
  // getAllRegisteredGroups returns Record<jid, RegisteredGroup> — the jid
  // is the key, not a field on the value.
  const groups = getAllRegisteredGroups();
  for (const [jid, g] of Object.entries(groups)) {
    if (g.folder === groupFolder) return jid;
  }
  return undefined;
}

function resolvePrompt(
  groupDir: string,
  fileBase: string,
  seed: TaskSeed,
): string | null {
  if (seed.prompt_file) {
    const p = path.join(groupDir, seed.prompt_file);
    if (!fs.existsSync(p)) {
      logger.error({ promptFile: p, seedId: seed.id }, 'Task seed prompt_file missing');
      return null;
    }
    return fs.readFileSync(p, 'utf-8').replace(/\s+$/, '');
  }

  // Default convention: <basename>.prompt.md
  const defaultPromptPath = path.join(groupDir, `${fileBase}.prompt.md`);
  if (fs.existsSync(defaultPromptPath)) {
    return fs.readFileSync(defaultPromptPath, 'utf-8').replace(/\s+$/, '');
  }

  if (typeof seed.prompt === 'string') {
    return seed.prompt;
  }

  logger.error(
    { seedId: seed.id, defaultPromptPath },
    'Task seed has no prompt_file, no inline prompt, and no sibling .prompt.md',
  );
  return null;
}

export function loadTaskSeeds(): void {
  if (!fs.existsSync(SEEDS_DIR)) {
    logger.debug({ dir: SEEDS_DIR }, 'No tasks/ seed directory, skipping');
    return;
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let errored = 0;

  const groupFolders = fs.readdirSync(SEEDS_DIR).filter((name) => {
    if (name.startsWith('.') || name === 'README.md') return false;
    return fs.statSync(path.join(SEEDS_DIR, name)).isDirectory();
  });

  for (const groupFolder of groupFolders) {
    const groupDir = path.join(SEEDS_DIR, groupFolder);
    const seedFiles = fs
      .readdirSync(groupDir)
      .filter((f) => f.endsWith('.json'));

    for (const file of seedFiles) {
      const fullPath = path.join(groupDir, file);
      const fileBase = file.replace(/\.json$/, '');

      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
      } catch (err) {
        logger.error(
          { file: fullPath, err: err instanceof Error ? err.message : String(err) },
          'Failed to parse task seed JSON',
        );
        errored++;
        continue;
      }

      if (!isTaskSeed(raw)) {
        logger.error({ file: fullPath }, 'Task seed JSON missing required fields');
        errored++;
        continue;
      }
      const seed = raw;

      const prompt = resolvePrompt(groupDir, fileBase, seed);
      if (prompt === null) {
        errored++;
        continue;
      }

      const existing = getTaskById(seed.id);
      if (existing) {
        // Preserve runtime state (status, next_run, last_run, chat_jid).
        // Only sync the seed-controlled fields.
        updateTask(seed.id, {
          prompt,
          schedule_type: seed.schedule_type,
          schedule_value: seed.schedule_value,
          context_mode: seed.context_mode || 'isolated',
        });
        updated++;
        logger.info({ id: seed.id, file }, 'Updated managed task from seed');
      } else {
        const jid = findGroupJid(groupFolder);
        if (!jid) {
          logger.warn(
            { id: seed.id, groupFolder, file },
            'Task seed: group not registered yet, skipping (will retry next startup)',
          );
          skipped++;
          continue;
        }
        let nextRun: string | null;
        try {
          nextRun = computeNextRun(seed);
        } catch (err) {
          logger.error(
            { id: seed.id, err: err instanceof Error ? err.message : String(err) },
            'Failed to compute next_run for task seed',
          );
          errored++;
          continue;
        }
        createTask({
          id: seed.id,
          group_folder: groupFolder,
          chat_jid: jid,
          prompt,
          schedule_type: seed.schedule_type,
          schedule_value: seed.schedule_value,
          context_mode: seed.context_mode || 'isolated',
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        created++;
        logger.info({ id: seed.id, file, groupFolder }, 'Created managed task from seed');
      }
    }
  }

  if (created || updated || skipped || errored) {
    logger.info({ created, updated, skipped, errored }, 'Task seeds processed');
  }
}
