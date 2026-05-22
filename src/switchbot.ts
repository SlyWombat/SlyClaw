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
 * SwitchBot cloud API v1.1 client (host side).
 *
 * Used by the Gemini / Ollama tool loop (see ollama-tools.ts). The Claude
 * container agent has its own self-contained copy in
 * container/agent-runner/src/switchbot-mcp-stdio.ts — the container is a
 * separate build and cannot import this module.
 *
 * Auth: every request is signed with HMAC-SHA256 over (token + t + nonce),
 * using the account secret as the key. See OpenWonderLabs/SwitchBotAPI.
 */
import crypto from 'crypto';

import { SWITCHBOT_TOKEN, SWITCHBOT_SECRET } from './config.js';
import { logger } from './logger.js';

const API_BASE = 'https://api.switch-bot.com';
const REQUEST_TIMEOUT_MS = 15_000;
const DEVICE_CACHE_MS = 60_000;

interface SwitchBotEnvelope<T> {
  statusCode: number;
  message: string;
  body: T;
}

export interface SwitchBotDevice {
  deviceId: string;
  deviceName: string;
  deviceType?: string; // physical devices
  remoteType?: string; // infrared remotes
  hubDeviceId?: string;
}

interface DeviceListBody {
  deviceList?: SwitchBotDevice[];
  infraredRemoteList?: SwitchBotDevice[];
}

interface Scene {
  sceneId: string;
  sceneName: string;
}

export function switchBotConfigured(): boolean {
  return Boolean(SWITCHBOT_TOKEN && SWITCHBOT_SECRET);
}

/** Build the per-request signed auth headers required by the v1.1 API. */
function signedHeaders(): Record<string, string> {
  const t = Date.now().toString();
  const nonce = crypto.randomUUID();
  const sign = crypto
    .createHmac('sha256', SWITCHBOT_SECRET)
    .update(Buffer.from(SWITCHBOT_TOKEN + t + nonce, 'utf-8'))
    .digest('base64');
  return {
    Authorization: SWITCHBOT_TOKEN,
    sign,
    nonce,
    t,
    'Content-Type': 'application/json; charset=utf-8',
  };
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: signedHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`SwitchBot HTTP ${res.status}`);
  const json = (await res.json()) as SwitchBotEnvelope<T>;
  // statusCode 100 = success; anything else is an application-level error.
  if (json.statusCode !== 100) {
    throw new Error(`SwitchBot API ${json.statusCode}: ${json.message || 'request failed'}`);
  }
  return json.body;
}

let deviceCache: { devices: SwitchBotDevice[]; at: number } | null = null;

/** Fetch the device list, cached briefly to avoid hammering the API. */
async function getDevices(force = false): Promise<SwitchBotDevice[]> {
  if (!force && deviceCache && Date.now() - deviceCache.at < DEVICE_CACHE_MS) {
    return deviceCache.devices;
  }
  const body = await call<DeviceListBody>('GET', '/v1.1/devices');
  const devices = [...(body.deviceList ?? []), ...(body.infraredRemoteList ?? [])];
  deviceCache = { devices, at: Date.now() };
  return devices;
}

type Resolved = { device: SwitchBotDevice } | { error: string };

/** Match a free-text name to a device: exact (case-insensitive) first, then partial. */
function resolveDevice(devices: SwitchBotDevice[], name: string): Resolved {
  const q = name.trim().toLowerCase();
  const named = devices.filter(
    (d) => typeof d.deviceName === 'string' && d.deviceName.trim() !== '',
  );
  const exact = named.filter((d) => d.deviceName.toLowerCase() === q);
  const pool = exact.length === 1 ? exact : named.filter((d) => d.deviceName.toLowerCase().includes(q));
  if (pool.length === 1) return { device: pool[0] };
  if (pool.length > 1) {
    return {
      error: `"${name}" matches multiple devices: ${pool.map((d) => d.deviceName).join(', ')}. Be more specific.`,
    };
  }
  return {
    error: `No SwitchBot device matches "${name}". Known devices: ${named.map((d) => d.deviceName).join(', ') || '(none)'}.`,
  };
}

// ---------------------------------------------------------------------------
// Public, string-returning helpers — consumed directly by the tool layer
// ---------------------------------------------------------------------------

export async function switchBotListDevices(): Promise<string> {
  if (!switchBotConfigured()) return 'SwitchBot is not configured (missing token/secret).';
  try {
    const devices = await getDevices(true);
    let scenes: Scene[] = [];
    try {
      scenes = await call<Scene[]>('GET', '/v1.1/scenes');
    } catch (err) {
      logger.warn({ err }, 'SwitchBot scene list failed');
    }
    if (devices.length === 0 && scenes.length === 0) {
      return 'No SwitchBot devices or scenes found on this account.';
    }
    const lines: string[] = [];
    if (devices.length > 0) {
      lines.push('Devices:');
      for (const d of devices) {
        lines.push(`- ${d.deviceName || '(unnamed)'} [${d.deviceType || d.remoteType || 'unknown'}]`);
      }
    }
    if (scenes.length > 0) {
      lines.push('', 'Scenes:');
      for (const s of scenes) lines.push(`- ${s.sceneName}`);
    }
    return lines.join('\n');
  } catch (err) {
    return `SwitchBot error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function switchBotStatus(deviceName: string): Promise<string> {
  if (!switchBotConfigured()) return 'SwitchBot is not configured (missing token/secret).';
  if (!deviceName) return 'Error: device name is required.';
  try {
    const r = resolveDevice(await getDevices(), deviceName);
    if ('error' in r) return r.error;
    if (r.device.remoteType && !r.device.deviceType) {
      return `"${r.device.deviceName}" is an infrared remote — it has no readable status.`;
    }
    const status = await call<Record<string, unknown>>(
      'GET',
      `/v1.1/devices/${r.device.deviceId}/status`,
    );
    return `Status of "${r.device.deviceName}":\n${JSON.stringify(status, null, 2)}`;
  } catch (err) {
    return `SwitchBot error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function switchBotControl(
  deviceName: string,
  command: string,
  parameter?: string,
  commandType?: string,
): Promise<string> {
  if (!switchBotConfigured()) return 'SwitchBot is not configured (missing token/secret).';
  if (!deviceName) return 'Error: device name is required.';
  if (!command) return 'Error: command is required.';
  try {
    const r = resolveDevice(await getDevices(), deviceName);
    if ('error' in r) return r.error;
    await call('POST', `/v1.1/devices/${r.device.deviceId}/commands`, {
      command,
      parameter: parameter || 'default',
      commandType: commandType || 'command',
    });
    return `Sent "${command}" to "${r.device.deviceName}".`;
  } catch (err) {
    return `SwitchBot error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function switchBotRunScene(sceneName: string): Promise<string> {
  if (!switchBotConfigured()) return 'SwitchBot is not configured (missing token/secret).';
  if (!sceneName) return 'Error: scene name is required.';
  try {
    const scenes = await call<Scene[]>('GET', '/v1.1/scenes');
    const q = sceneName.trim().toLowerCase();
    const exact = scenes.filter((s) => s.sceneName.toLowerCase() === q);
    const pool = exact.length === 1 ? exact : scenes.filter((s) => s.sceneName.toLowerCase().includes(q));
    if (pool.length === 0) {
      return `No SwitchBot scene matches "${sceneName}". Known scenes: ${scenes.map((s) => s.sceneName).join(', ') || '(none)'}.`;
    }
    if (pool.length > 1) {
      return `"${sceneName}" matches multiple scenes: ${pool.map((s) => s.sceneName).join(', ')}. Be more specific.`;
    }
    await call('POST', `/v1.1/scenes/${pool[0].sceneId}/execute`);
    return `Executed scene "${pool[0].sceneName}".`;
  } catch (err) {
    return `SwitchBot error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
