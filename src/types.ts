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
export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/slyclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  // Optional image attachment — channel sets this; index.ts saves to disk and rewrites content
  imageAttachment?: { base64: string; mimeType: string };
  // Optional file attachment (PDFs, documents, etc.) — channel sets this; index.ts saves to disk and rewrites content
  fileAttachment?: { base64: string; mimeType: string; filename?: string };
  // Optional list of mentioned JIDs (WhatsApp `@<digits>` mentions resolved by the channel adapter).
  // Phone-format JIDs (`<digits>@s.whatsapp.net`). Empty/absent when no mentions in the message.
  mentioned?: string[];
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: file sending. Channels that support it implement it.
  sendFile?(jid: string, filePath: string, caption?: string): Promise<void>;
  /**
   * Optional: open (or fetch the JID of) a DM with a user. Called by the
   * host when an agent wants to initiate a cold message to a user who may
   * not have an existing chat with the bot — host-initiated alerts,
   * approval prompts, scheduled notifications.
   *
   * For WhatsApp / Telegram / iMessage, the user handle IS already the DM
   * JID (just normalize), so the implementation is essentially a parse.
   * For Discord / Slack, it'd open a real DM channel via the platform API.
   */
  openDM?(userHandle: string): Promise<string>;
  /**
   * Optional: render an `ask_user_question` interactive prompt — multiple
   * choice with channel-native UI. WhatsApp renders as a numbered list of
   * slash commands; Discord/Slack would use native button rows. The
   * channel also tracks a pending entry so the next inbound message in
   * that chat can be translated from a slash-command response back to
   * the human-readable option label before reaching the router.
   */
  askQuestion?(jid: string, payload: import('./ask-question.js').AskQuestionPayload): Promise<void>;
  /**
   * Optional: refresh the channel's cached conversation/group metadata.
   * For WhatsApp this fetches `groupFetchAllParticipating` and updates
   * chat names in the DB; for other channels it might paginate the
   * conversation list. `force=true` bypasses any time-since-last-sync
   * gate the channel uses.
   */
  syncGroupMetadata?(force?: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (WhatsApp syncGroupMetadata) omit it.
export type OnChatMetadata = (chatJid: string, timestamp: string, name?: string) => void;
