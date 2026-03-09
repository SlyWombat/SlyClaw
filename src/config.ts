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
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER', 'DEFAULT_LLM', 'OLLAMA_LOCAL_URL', 'ALEXA_PORT', 'ALEXA_SKILL_ID', 'ECOWITT_APP_KEY', 'ECOWITT_API_KEY', 'ECOWITT_MAC', 'ECOWITT_STATION_NAME', 'ECOWITT_LOCAL_PORT']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Nano';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

// Default LLM: "claude" | "ollama:<model>" (e.g. "ollama:qwen2.5:7b")
export const DEFAULT_LLM =
  process.env.DEFAULT_LLM || envConfig.DEFAULT_LLM || 'claude';

// Local Ollama API URL (always localhost — not the cloud OLLAMA_HOST)
export const OLLAMA_LOCAL_URL =
  process.env.OLLAMA_LOCAL_URL || envConfig.OLLAMA_LOCAL_URL || 'http://localhost:11434';

// Default model used by the Ollama MCP server inside the Claude container agent.
// Separate from DEFAULT_LLM (which controls the Qwen routing layer).
export const OLLAMA_DEFAULT_MODEL =
  process.env.OLLAMA_DEFAULT_MODEL || 'llama3.2';

export const POLL_INTERVAL = 500;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || '/Users/user';

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'slyclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'slyclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Alexa channel — disabled when ALEXA_PORT is 0 or unset
export const ALEXA_PORT = parseInt(process.env.ALEXA_PORT || envConfig.ALEXA_PORT || '0', 10);
export const ALEXA_SKILL_ID = process.env.ALEXA_SKILL_ID || envConfig.ALEXA_SKILL_ID || '';

// Ecowitt weather station — cloud API credentials
export const ECOWITT_APP_KEY =
  process.env.ECOWITT_APP_KEY || envConfig.ECOWITT_APP_KEY || '';
export const ECOWITT_API_KEY =
  process.env.ECOWITT_API_KEY || envConfig.ECOWITT_API_KEY || '';
export const ECOWITT_MAC =
  process.env.ECOWITT_MAC || envConfig.ECOWITT_MAC || '';
export const ECOWITT_STATION_NAME =
  process.env.ECOWITT_STATION_NAME || envConfig.ECOWITT_STATION_NAME || 'Home';
// Set to a port number to also receive local push data (e.g. 8765); 0 = disabled
export const ECOWITT_LOCAL_PORT = parseInt(
  process.env.ECOWITT_LOCAL_PORT || envConfig.ECOWITT_LOCAL_PORT || '0',
  10,
);
