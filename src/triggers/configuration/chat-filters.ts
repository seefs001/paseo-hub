import type { TriggerDocument } from "./schema.js";

/** The chat events whose filters the form edits beyond the shared ones. */
const CHAT_FORM_EVENTS = [
  "discord.mention",
  "discord.reaction_added",
  "telegram.mention",
  "telegram.reaction_added",
] as const;
const REACTION_EVENTS = new Set(["discord.reaction_added", "telegram.reaction_added"]);

type Filters = TriggerDocument["on"][string]["filters"];

/** The chat filter values the form owns. Each is absent when it narrows nothing. */
export interface ChatFormFilters {
  /** Discord channel IDs an event must arrive in, or under as a thread. Never an empty list. */
  channels?: string[];
  /** Unaddressed messages continue a conversation the bot takes part in. */
  threadMessages?: true;
  /** Reactions that start a run, as typed: emoji separated by commas or spaces. */
  emojis?: string;
}

export function isChatFormEvent(event: string): boolean {
  return CHAT_FORM_EVENTS.some((candidate) => candidate === event);
}

export function isReactionEvent(event: string): boolean {
  return REACTION_EVENTS.has(event);
}

/** The form picks Discord channels by name; Telegram topic IDs are edited in YAML. */
export function hasChannelPicker(event: string): boolean {
  return event.startsWith("discord.") && isChatFormEvent(event);
}

/** Why a document's chat filters cannot be shown in the form, if they cannot. */
export function chatYamlOnlyReason(event: string, filters: Filters): string | undefined {
  if (!isChatFormEvent(event)) return undefined;
  if (hasChannelPicker(event) && filters?.channels?.length === 0) {
    return "An empty channel list matches no Discord channel. Remove it or name channels in YAML.";
  }
  if (!hasChannelPicker(event) && filters?.channels !== undefined) {
    return "Telegram topic filters can only be edited in YAML.";
  }
  return undefined;
}

export function readChatFilters(event: string, filters: Filters): ChatFormFilters {
  if (!isChatFormEvent(event)) return {};
  const channels = hasChannelPicker(event) ? (filters?.channels ?? []) : [];
  const emojis = filters?.emojis ?? [];
  return {
    ...(channels.length === 0 ? {} : { channels: [...channels] }),
    ...(filters?.thread_messages === true ? { threadMessages: true as const } : {}),
    ...(isReactionEvent(event) && emojis.length > 0 ? { emojis: emojis.join(" ") } : {}),
  };
}

/** The YAML filter values for an event, `undefined` for each one the event does not carry. */
export function authoredChatFilters(
  event: string,
  value: ChatFormFilters,
): { channels?: string[]; thread_messages?: true; emojis?: string[] } {
  if (!isChatFormEvent(event)) return {};
  const channels = hasChannelPicker(event) ? (value.channels ?? []) : [];
  const emojis = isReactionEvent(event) ? parseEmojis(value.emojis ?? "") : [];
  return {
    ...(channels.length === 0 ? {} : { channels }),
    ...(value.threadMessages === true ? { thread_messages: true as const } : {}),
    ...(emojis.length === 0 ? {} : { emojis }),
  };
}

export const CHAT_FILTER_KEYS = ["channels", "thread_messages", "emojis"] as const;

/**
 * Chat filters survive a change between events of the same provider, except emojis, which only
 * a reaction has. Another provider's event takes none of them.
 */
export function carriedChatFilters(
  previous: string,
  next: string,
  value: ChatFormFilters,
): ChatFormFilters {
  if (!isChatFormEvent(previous) || !isChatFormEvent(next)) return {};
  if (previous.split(".", 1)[0] !== next.split(".", 1)[0]) return {};
  return {
    ...(value.channels === undefined || !hasChannelPicker(next)
      ? {}
      : { channels: value.channels }),
    ...(value.threadMessages === undefined ? {} : { threadMessages: value.threadMessages }),
    ...(isReactionEvent(next) && value.emojis !== undefined ? { emojis: value.emojis } : {}),
  };
}

export function chatFilterErrors(event: string, value: ChatFormFilters): { emojis?: string } {
  return isReactionEvent(event) && parseEmojis(value.emojis ?? "").length === 0
    ? { emojis: "Name at least one emoji, or every reaction would start a run." }
    : {};
}

function parseEmojis(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/u).filter(Boolean))];
}
