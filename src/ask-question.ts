/*
 *   ____  _            ____ _
 *  / ___|| |_   _     / ___| | __ ___      __
 *  \___ \| | | | |   | |   | |/ _` \ \ /\ / /
 *   ___) | | |_| |   | |___| | (_| |\ V  V /
 *  |____/|_|\__, |    \____|_|\__,_| \_/\_/
 *           |___/
 *  Cunning. Sturdy. Open.
 *
 *  Ported from qwibitai/nanoclaw#channels — src/channels/ask-question.ts
 */
/**
 * Shared ask_question payload schema + normalization.
 *
 * Producer: the container-side `ask_user_question` MCP tool (one per
 * agent invocation; the agent picks the title, question, options).
 * Consumer: the channel adapter's askQuestion() method — renders the
 * question in a channel-native way (slash-command list on WhatsApp,
 * numbered buttons on Discord/Slack, etc.).
 */

export interface OptionInput {
  label: string;
  selectedLabel?: string;
  value?: string;
}

export type RawOption = string | OptionInput;

export interface NormalizedOption {
  /** Text shown in the rendered question, e.g. "Send anyway" */
  label: string;
  /** Text used when the answer is fed back to the agent — usually same as label */
  selectedLabel: string;
  /** Internal id the agent's code branches on — usually same as label */
  value: string;
}

export function normalizeOption(raw: RawOption): NormalizedOption {
  if (typeof raw === 'string') {
    return { label: raw, selectedLabel: raw, value: raw };
  }
  const label = raw.label;
  return {
    label,
    selectedLabel: raw.selectedLabel ?? label,
    value: raw.value ?? label,
  };
}

export function normalizeOptions(raws: RawOption[]): NormalizedOption[] {
  return raws.map(normalizeOption);
}

export interface AskQuestionPayload {
  type: 'ask_question';
  questionId: string;
  title: string;
  question: string;
  options: NormalizedOption[];
}

/** Slug an option label into a slash command: "Send anyway" → "/send-anyway". */
export function optionToCommand(label: string): string {
  return (
    '/' +
    label
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
  );
}
