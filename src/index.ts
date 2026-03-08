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
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ALEXA_PORT,
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from './config.js';
import {
  LlmChoice,
  callOllama,
  clearOllamaHistory,
  detectLlmCommand,
  formatLlmName,
  getAvailableLlms,
  getGroupLlm,
  readGroupSystemPrompt,
  serializeLlm,
  setGroupLlm,
} from './llm.js';
import { DelegateToClaudeError } from './ollama-tools.js';
import { AlexaChannel, ALEXA_JID } from './channels/alexa.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const SNAPPY_ACKS = [
  "Oh great, another request. On it. 🙄",
  "Ugh, fine. Give me a second.",
  "Yes, yes, I heard you. Working on it...",
  "Wow, can't you see I'm busy? Hold on.",
  "This had better be important. Looking into it now.",
  "Oh sure, drop everything for YOU. One moment.",
  "Working on it. Try to contain your excitement.",
  "Do I look like I have infinite speed? Processing...",
  "I heard you the first time. Relax.",
  "On it. Please stand by and try not to message again.",
  "Oh, another one. How delightful. Computing...",
  "Fine. I'll stop what I was doing and help you. Happy?",
];
let snappyAckIndex = 0;

// Matches responses where the local model incorrectly claims it cannot use
// a capability it actually has (web search, current time/date awareness).
// When detected, we auto-delegate to Claude instead of sending a useless reply.
const CAPABILITY_DENIAL_RE =
  /I (don't|do not|can't|cannot|am unable to|am not able to) (have )?(the ability to |access to |)?(browse|search the web|access (the internet|external|real.?time|current)|check the (current|present) (time|date)|provide (current|real.?time|up.?to.?date))/i;

let whatsapp: WhatsAppChannel;
const channels: Channel[] = [];
const queue = new GroupQueue();

function getChannelForJid(jid: string): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

async function sendToChannel(jid: string, text: string): Promise<void> {
  const ch = getChannelForJid(jid);
  if (ch) {
    await ch.sendMessage(jid, text);
  } else {
    logger.warn({ jid }, 'No channel found for JID, dropping message');
  }
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.jid.endsWith('@g.us'))
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

function ensureAlexaRegistered(): void {
  if (!ALEXA_PORT) return;
  if (!registeredGroups[ALEXA_JID]) {
    registerGroup(ALEXA_JID, {
      name: 'Alexa',
      folder: 'alexa',
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    });
    logger.info('Alexa chat auto-registered');
  }
}

/**
 * Handle LLM management commands ("what llm", "switch to ollama", "list models", etc.)
 * Returns true if the message was an LLM command and was handled, false otherwise.
 */
async function tryHandleLlmCommand(
  group: RegisteredGroup,
  isMainGroup: boolean,
  messages: NewMessage[],
  chatJid: string,
): Promise<boolean> {
  // Find the last triggered message to extract the command text
  const lastTriggered = [...messages].reverse().find((m) =>
    isMainGroup || group.requiresTrigger === false
      ? true
      : TRIGGER_PATTERN.test(m.content.trim()),
  );
  if (!lastTriggered) return false;

  const rawText = lastTriggered.content.replace(TRIGGER_PATTERN, '').trim();
  const cmd = detectLlmCommand(rawText);
  if (!cmd) return false;

  const current = getGroupLlm(group.folder);
  let response: string;

  if (cmd.action === 'status') {
    response =
      `Currently using: *${formatLlmName(current)}*\n` +
      (current.type === 'ollama'
        ? '_(local model — web search + URL fetching via tools)_'
        : '_(full agent with tools, web search, and file access)_');
  } else if (cmd.action === 'list') {
    const available = await getAvailableLlms();
    const lines = available.map((a) => {
      const isCurrent = a.id === serializeLlm(current);
      return `${isCurrent ? '✓' : '•'} ${a.label}`;
    });
    response =
      `Available LLMs:\n${lines.join('\n')}\n\n` +
      `To switch: "@${ASSISTANT_NAME} use claude" or "@${ASSISTANT_NAME} use qwen2.5:7b"`;
  } else {
    // switch
    const { choice } = cmd;
    setGroupLlm(group.folder, choice);
    clearOllamaHistory(group.folder);
    response =
      `✓ Switched to *${formatLlmName(choice)}*\n` +
      (choice.type === 'ollama'
        ? '_(local model — web search + URL fetching via tools)_'
        : '_(full agent mode with tools restored)_');
  }

  await sendToChannel(chatJid,response);
  return true;
}

/**
 * Run a request through Ollama (local HTTP API).
 * Falls back to Claude if Ollama fails.
 */
async function runOllamaRequest(
  group: RegisteredGroup,
  messages: NewMessage[],
  chatJid: string,
  model: string,
): Promise<'success' | 'error' | 'fallback'> {
  // Build a plain-text user message from the pending messages (strip trigger prefix)
  const userText = messages
    .map((m) => {
      const content = m.content.replace(TRIGGER_PATTERN, '').trim();
      return messages.length > 1 ? `${m.sender_name}: ${content}` : content;
    })
    .filter(Boolean)
    .join('\n');

  if (!userText) return 'success'; // nothing to say

  const systemPrompt = readGroupSystemPrompt(group.folder);

  try {
    logger.info({ group: group.name, model }, 'Running Ollama request');
    const reply = await callOllama(model, group.folder, chatJid, userText, systemPrompt);

    // If the model denies a capability it actually has (web search, current info),
    // auto-delegate to Claude rather than sending a useless response.
    if (reply && CAPABILITY_DENIAL_RE.test(reply)) {
      logger.info({ group: group.name, model, reply }, 'Ollama denied capability — delegating to Claude');
      throw new DelegateToClaudeError('model declined to use available tools');
    }

    if (reply) {
      await sendToChannel(chatJid,reply);
    } else {
      await sendToChannel(chatJid,'_(no response from model)_');
    }
    return 'success';
  } catch (err: unknown) {
    if (err instanceof DelegateToClaudeError) {
      logger.info({ group: group.name, model, reason: err.message }, 'Ollama delegating to Claude');
      await sendToChannel(chatJid,`_(handing off to Claude: ${err.message})_`);
      return 'fallback';
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ group: group.name, model, err }, 'Ollama request failed');
    await sendToChannel(chatJid, `⚠️ *${model}* failed: ${errMsg}\nFalling back to Claude...`);
    return 'fallback';
  }
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  // --- LLM management commands (status / list / switch) ---
  // Handled before the cursor advances so no cursor side-effects.
  const wasLlmCommand = await tryHandleLlmCommand(
    group,
    isMainGroup,
    missedMessages,
    chatJid,
  );
  if (wasLlmCommand) {
    // Advance cursor so the command is not re-processed on next poll
    lastAgentTimestamp[chatJid] = missedMessages[missedMessages.length - 1].timestamp;
    saveState();
    return true;
  }

  // --- Route to selected LLM ---
  const currentLlm: LlmChoice = getGroupLlm(group.folder);
  const prompt = formatMessages(missedMessages);

  // Advance cursor (save old for rollback on error)
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] = missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length, llm: formatLlmName(currentLlm) },
    'Processing messages',
  );

  await getChannelForJid(chatJid)?.setTyping?.(chatJid, true);
  // Skip sarcastic acks for voice channels — they consume the pending HTTP response slot
  if (!chatJid.startsWith('alexa:')) {
    await sendToChannel(chatJid, SNAPPY_ACKS[snappyAckIndex % SNAPPY_ACKS.length]);
    snappyAckIndex++;
  }

  // --- Ollama path ---
  if (currentLlm.type === 'ollama') {
    const result = await runOllamaRequest(group, missedMessages, chatJid, currentLlm.model);
    await getChannelForJid(chatJid)?.setTyping?.(chatJid, false);

    if (result === 'fallback') {
      // Ollama failed — fall through to Claude below (don't return)
    } else {
      if (result === 'error') {
        lastAgentTimestamp[chatJid] = previousCursor;
        saveState();
        return false;
      }
      return true;
    }
  }

  // --- Claude path (original) ---
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await sendToChannel(chatJid,text);
        outputSentToUser = true;
      }
      resetIdleTimer();
      queue.killContainer(chatJid);
    }
    if (result.status === 'error') {
      hadError = true;
    }
  });

  await getChannelForJid(chatJid)?.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);
  queue.killContainer(chatJid);

  if (output === 'error' || hadError) {
    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      return true;
    }
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`SlyClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            getChannelForJid(chatJid)?.setTyping?.(chatJid, true);
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe' });
    logger.debug('Docker daemon is running');
  } catch {
    logger.error('Docker daemon is not running');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Docker daemon is not running                           ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without Docker. To fix:                    ║',
    );
    console.error(
      '║  1. Start Docker: sudo systemctl start docker                 ║',
    );
    console.error(
      '║  2. Restart SlyClaw                                          ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Docker daemon is required but not running');
  }
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  ensureAlexaRegistered();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Shared inbound message handler — saves image attachments to disk before storing
  const handleInbound = (chatJid: string, msg: NewMessage): void => {
    if (msg.imageAttachment) {
      const group = registeredGroups[chatJid];
      if (group) {
        try {
          const imgDir = path.join(GROUPS_DIR, group.folder, 'images');
          fs.mkdirSync(imgDir, { recursive: true });
          const ext = msg.imageAttachment.mimeType.includes('png') ? 'png' : 'jpg';
          const filename = `${new Date(msg.timestamp).toISOString().replace(/[:.]/g, '-')}.${ext}`;
          const hostPath = path.join(imgDir, filename);
          fs.writeFileSync(hostPath, Buffer.from(msg.imageAttachment.base64, 'base64'));
          const containerPath = `/workspace/group/images/${filename}`;
          msg = {
            ...msg,
            content: msg.content
              ? `${msg.content} [Image: ${containerPath}]`
              : `[Image: ${containerPath}]`,
            imageAttachment: undefined,
          };
          logger.info({ chatJid, path: containerPath }, 'Image attachment saved');
        } catch (err) {
          logger.warn({ err, chatJid }, 'Failed to save image attachment');
          msg = { ...msg, content: `${msg.content} [Image - save failed]`, imageAttachment: undefined };
        }
      }
    }
    storeMessage(msg);
  };

  // Create WhatsApp channel
  whatsapp = new WhatsAppChannel({
    onMessage: handleInbound,
    onChatMetadata: (chatJid, timestamp) => storeChatMetadata(chatJid, timestamp),
    registeredGroups: () => registeredGroups,
  });
  channels.push(whatsapp);

  // Connect WhatsApp — resolves when first connected
  await whatsapp.connect();

  // Connect Alexa channel if port is configured
  if (ALEXA_PORT) {
    const alexa = new AlexaChannel({
      onMessage: handleInbound,
      onChatMetadata: (chatJid, timestamp, name) => storeChatMetadata(chatJid, timestamp, name),
    });
    channels.push(alexa);
    await alexa.connect();
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const text = formatOutbound(rawText);
      if (text) await sendToChannel(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => sendToChannel(jid, text),
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) => whatsapp.syncGroupMetadata(force),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop();
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start SlyClaw');
    process.exit(1);
  });
}
