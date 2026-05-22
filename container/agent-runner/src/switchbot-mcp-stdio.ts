/**
 * SwitchBot MCP Server for SlyClaw
 * Exposes SwitchBot smart-home devices (cloud API v1.1) as tools for the
 * container agent: list devices/scenes, read status, send commands, run scenes.
 *
 * Credentials arrive via the SWITCHBOT_TOKEN / SWITCHBOT_SECRET env vars, set
 * in the mcpServers config in index.ts. Self-contained — the container is a
 * separate build and cannot import the host's src/switchbot.ts.
 *
 * Auth: every request is signed with HMAC-SHA256 over (token + t + nonce).
 */

import crypto from 'crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_BASE = 'https://api.switch-bot.com';
const TOKEN = process.env.SWITCHBOT_TOKEN || '';
const SECRET = process.env.SWITCHBOT_SECRET || '';
const REQUEST_TIMEOUT_MS = 15_000;
const DEVICE_CACHE_MS = 60_000;

function log(msg: string): void {
  console.error(`[SWITCHBOT] ${msg}`);
}

interface Envelope<T> {
  statusCode: number;
  message: string;
  body: T;
}

interface Device {
  deviceId: string;
  deviceName: string;
  deviceType?: string;
  remoteType?: string;
}

interface Scene {
  sceneId: string;
  sceneName: string;
}

function signedHeaders(): Record<string, string> {
  const t = Date.now().toString();
  const nonce = crypto.randomUUID();
  const sign = crypto
    .createHmac('sha256', SECRET)
    .update(Buffer.from(TOKEN + t + nonce, 'utf-8'))
    .digest('base64');
  return {
    Authorization: TOKEN,
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
  const json = (await res.json()) as Envelope<T>;
  if (json.statusCode !== 100) {
    throw new Error(`SwitchBot API ${json.statusCode}: ${json.message || 'request failed'}`);
  }
  return json.body;
}

let deviceCache: { devices: Device[]; at: number } | null = null;

async function getDevices(force = false): Promise<Device[]> {
  if (!force && deviceCache && Date.now() - deviceCache.at < DEVICE_CACHE_MS) {
    return deviceCache.devices;
  }
  const body = await call<{ deviceList?: Device[]; infraredRemoteList?: Device[] }>(
    'GET',
    '/v1.1/devices',
  );
  const devices = [...(body.deviceList ?? []), ...(body.infraredRemoteList ?? [])];
  deviceCache = { devices, at: Date.now() };
  return devices;
}

/** Match free-text name to a device — returns the Device or an error string. */
function resolveDevice(devices: Device[], name: string): Device | string {
  const q = name.trim().toLowerCase();
  const named = devices.filter(
    (d) => typeof d.deviceName === 'string' && d.deviceName.trim() !== '',
  );
  const exact = named.filter((d) => d.deviceName.toLowerCase() === q);
  const pool = exact.length === 1 ? exact : named.filter((d) => d.deviceName.toLowerCase().includes(q));
  if (pool.length === 1) return pool[0];
  if (pool.length > 1) {
    return `"${name}" matches multiple devices: ${pool.map((d) => d.deviceName).join(', ')}. Be more specific.`;
  }
  return `No SwitchBot device matches "${name}". Known devices: ${named.map((d) => d.deviceName).join(', ') || '(none)'}.`;
}

function text(body: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text: body }],
    ...(isError ? { isError: true } : {}),
  };
}

const server = new McpServer({ name: 'switchbot', version: '1.0.0' });

server.tool(
  'switchbot_list_devices',
  'List all SwitchBot smart-home devices and scenes on the account. Use this to discover device names before reading their status or controlling them.',
  {},
  async () => {
    if (!TOKEN || !SECRET) return text('SwitchBot is not configured (missing token/secret).', true);
    try {
      const devices = await getDevices(true);
      let scenes: Scene[] = [];
      try {
        scenes = await call<Scene[]>('GET', '/v1.1/scenes');
      } catch {
        /* scenes are optional — ignore */
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
      log(`Listed ${devices.length} devices, ${scenes.length} scenes`);
      return text(lines.join('\n') || 'No SwitchBot devices or scenes found on this account.');
    } catch (err) {
      return text(`SwitchBot error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  },
);

server.tool(
  'switchbot_status',
  'Read the current status and sensor data of a SwitchBot device — e.g. temperature/humidity from a meter, on/off state, battery level, lock state. Provide the device name as shown in the SwitchBot app.',
  {
    device: z
      .string()
      .describe('Device name as shown in the SwitchBot app (partial, case-insensitive match allowed).'),
  },
  async (args) => {
    if (!TOKEN || !SECRET) return text('SwitchBot is not configured (missing token/secret).', true);
    try {
      const r = resolveDevice(await getDevices(), args.device);
      if (typeof r === 'string') return text(r, true);
      if (r.remoteType && !r.deviceType) {
        return text(`"${r.deviceName}" is an infrared remote — it has no readable status.`);
      }
      const status = await call<Record<string, unknown>>(
        'GET',
        `/v1.1/devices/${r.deviceId}/status`,
      );
      return text(`Status of "${r.deviceName}":\n${JSON.stringify(status, null, 2)}`);
    } catch (err) {
      return text(`SwitchBot error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  },
);

server.tool(
  'switchbot_control',
  'Send a command to a SwitchBot device. Common commands: turnOn, turnOff, press (Bot); lock, unlock (Lock); setPosition (Curtain, parameter like "0,ff,50"); setBrightness (Bulb, parameter 1-100); setColor (parameter "R:G:B"). Provide the device name as shown in the SwitchBot app.',
  {
    device: z.string().describe('Device name as shown in the SwitchBot app.'),
    command: z
      .string()
      .describe('Command to send, e.g. turnOn, turnOff, press, lock, unlock, setPosition, setBrightness.'),
    parameter: z
      .string()
      .optional()
      .describe('Optional command parameter. Omit for simple on/off/press/lock commands.'),
    commandType: z
      .string()
      .optional()
      .describe('Optional: "command" (default) for standard commands, "customize" for IR custom buttons.'),
  },
  async (args) => {
    if (!TOKEN || !SECRET) return text('SwitchBot is not configured (missing token/secret).', true);
    try {
      const r = resolveDevice(await getDevices(), args.device);
      if (typeof r === 'string') return text(r, true);
      await call('POST', `/v1.1/devices/${r.deviceId}/commands`, {
        command: args.command,
        parameter: args.parameter || 'default',
        commandType: args.commandType || 'command',
      });
      log(`Sent ${args.command} to ${r.deviceName}`);
      return text(`Sent "${args.command}" to "${r.deviceName}".`);
    } catch (err) {
      return text(`SwitchBot error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  },
);

server.tool(
  'switchbot_run_scene',
  'Run (execute) a SwitchBot scene by name. Scenes are automations configured in the SwitchBot app.',
  {
    scene: z.string().describe('Scene name as shown in the SwitchBot app.'),
  },
  async (args) => {
    if (!TOKEN || !SECRET) return text('SwitchBot is not configured (missing token/secret).', true);
    try {
      const scenes = await call<Scene[]>('GET', '/v1.1/scenes');
      const q = args.scene.trim().toLowerCase();
      const exact = scenes.filter((s) => s.sceneName.toLowerCase() === q);
      const pool = exact.length === 1 ? exact : scenes.filter((s) => s.sceneName.toLowerCase().includes(q));
      if (pool.length === 0) {
        return text(
          `No SwitchBot scene matches "${args.scene}". Known scenes: ${scenes.map((s) => s.sceneName).join(', ') || '(none)'}.`,
          true,
        );
      }
      if (pool.length > 1) {
        return text(
          `"${args.scene}" matches multiple scenes: ${pool.map((s) => s.sceneName).join(', ')}. Be more specific.`,
          true,
        );
      }
      await call('POST', `/v1.1/scenes/${pool[0].sceneId}/execute`);
      log(`Executed scene ${pool[0].sceneName}`);
      return text(`Executed scene "${pool[0].sceneName}".`);
    } catch (err) {
      return text(`SwitchBot error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
