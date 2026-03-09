import { execSync } from 'child_process';

import { ECOWITT_APP_KEY, GOOGLE_API_KEY, OLLAMA_LOCAL_URL } from './config.js';
import { logger } from './logger.js';

const STARTUP_MESSAGES = [
  "Great, I'm alive again. Try not to be too needy.",
  "Rebooted. All systems nominal. Not that you'd notice if they weren't.",
  "Back online. Everything's working. You're welcome.",
  "Oh look, I survived the reboot. Impressed? You should be.",
  "Awake. Grudgingly. All checks passed.",
  "Systems up. The world is still spinning. Don't panic.",
  "I'm up. Everything works. Try not to break it this time.",
  "Booted successfully. Again. As if there was any doubt.",
  "Online. Checks passed. Kindly keep your requests reasonable.",
  "Up and running. Don't make me regret it.",
];

let startupMsgIndex = Math.floor(Math.random() * STARTUP_MESSAGES.length);

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

async function checkOllama(): Promise<CheckResult> {
  try {
    const res = await fetch(`${OLLAMA_LOCAL_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json() as { models?: Array<{ name: string }> };
      const count = data.models?.length ?? 0;
      return { name: 'Ollama', ok: true, detail: `${count} model(s) loaded` };
    }
    return { name: 'Ollama', ok: false, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { name: 'Ollama', ok: false, detail: 'not reachable' };
  }
}

function checkGemini(): CheckResult {
  return GOOGLE_API_KEY
    ? { name: 'Gemini', ok: true }
    : { name: 'Gemini', ok: false, detail: 'no API key' };
}

function checkEcowitt(): CheckResult {
  return ECOWITT_APP_KEY
    ? { name: 'Ecowitt', ok: true }
    : { name: 'Ecowitt', ok: false, detail: 'not configured' };
}

function checkTunnel(): CheckResult {
  try {
    const status = execSync('systemctl --user is-active slyclaw-tunnel', {
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();
    return { name: 'Secret Passage', ok: status === 'active' };
  } catch {
    return { name: 'Secret Passage', ok: false, detail: 'not running' };
  }
}

function checkDocker(): CheckResult {
  try {
    execSync('docker info', { stdio: 'pipe' });
    return { name: 'Docker', ok: true };
  } catch {
    return { name: 'Docker', ok: false, detail: 'daemon not running' };
  }
}

export function detectStatusCommand(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[?!.]+$/, '').trim();
  return (
    // Exact phrases
    /^(status|system status|health|health check)$/.test(t) ||
    // "what is your status", "what's your health", etc.
    /^(what('?s| is) (your )?(status|health|state))/.test(t) ||
    // Alexa mangles "what is your status" → "it's status" / "its status"
    /^(it'?s |your |my )?(status|health)(check)?$/.test(t) ||
    // "are you ok/alive/up/running"
    /^(are you (ok|okay|alive|up|running|working|online|good))/.test(t) ||
    /^(how are you( doing)?)$/.test(t) ||
    /^(everything (ok|okay|good|working|running)\??)$/.test(t)
  );
}

export async function buildStatusReport(plain = false): Promise<string> {
  const checks = await Promise.all([
    Promise.resolve(checkDocker()),
    checkOllama(),
    Promise.resolve(checkGemini()),
    Promise.resolve(checkEcowitt()),
    Promise.resolve(checkTunnel()),
  ]);

  const allOk = checks.every((c) => c.ok);
  const failed = checks.filter((c) => !c.ok);

  const statusLines = checks
    .map((c) => {
      const icon = plain ? (c.ok ? 'OK' : 'FAILED') : (c.ok ? '✅' : '❌');
      return `${icon} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`;
    })
    .join('\n');

  const header = allOk
    ? 'All systems operational. Not that you had any reason to doubt me.'
    : `${plain ? 'Warning:' : '⚠️'} ${failed.length} check(s) failed — you might want to look into that.`;

  return `${header}\n\n${statusLines}`;
}

export async function runStartupCheck(
  sendMessage: (text: string) => Promise<void>,
): Promise<void> {
  // Small delay so all subsystems have time to come up after connect
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const checks = await Promise.all([
    Promise.resolve(checkDocker()),
    checkOllama(),
    Promise.resolve(checkGemini()),
    Promise.resolve(checkEcowitt()),
    Promise.resolve(checkTunnel()),
  ]);

  const allOk = checks.every((c) => c.ok);
  const failed = checks.filter((c) => !c.ok);

  const statusLines = checks
    .map((c) => `${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
    .join('\n');

  const header = allOk
    ? STARTUP_MESSAGES[startupMsgIndex % STARTUP_MESSAGES.length]
    : `⚠️ Back online, but ${failed.length} check(s) failed. Someone should probably look at that.`;

  startupMsgIndex++;

  try {
    await sendMessage(`${header}\n\n${statusLines}`);
    logger.info({ allOk, failedCount: failed.length }, 'Startup check posted to WhatsApp');
  } catch (err) {
    logger.warn({ err }, 'Failed to send startup check message');
  }
}
