import type { TriggerDocument } from "./schema.js";

/** The Discord events whose filters the form edits beyond the shared ones. */
export const DISCORD_FORM_EVENTS = ["discord.mention", "discord.reaction_added"] as const;
const REACTION_EVENT = "discord.reaction_added";

type Filters = TriggerDocument["on"][string]["filters"];

/** The Discord filter values the form owns. Each is absent when it narrows nothing. */
export interface DiscordFormFilters {
  /** Channel IDs an event must arrive in, or under as a thread. Never an empty list. */
  channels?: string[];
  /** Unmentioned messages continue a conversation in a thread the bot started. */
  threadMessages?: true;
  /** Reactions that start a run, as typed: emoji separated by commas or spaces. */
  emojis?: string;
}

export function isDiscordFormEvent(event: string): boolean {
  return DISCORD_FORM_EVENTS.some((candidate) => candidate === event);
}

/** Why a document's Discord filters cannot be shown in the form, if they cannot. */
export function discordYamlOnlyReason(event: string, filters: Filters): string | undefined {
  if (!isDiscordFormEvent(event) || filters?.channels?.length !== 0) return undefined;
  return "An empty channel list matches no Discord channel. Remove it or name channels in YAML.";
}

export function readDiscordFilters(event: string, filters: Filters): DiscordFormFilters {
  if (!isDiscordFormEvent(event)) return {};
  const channels = filters?.channels ?? [];
  const emojis = filters?.emojis ?? [];
  return {
    ...(channels.length === 0 ? {} : { channels: [...channels] }),
    ...(filters?.thread_messages === true ? { threadMessages: true as const } : {}),
    ...(event === REACTION_EVENT && emojis.length > 0 ? { emojis: emojis.join(" ") } : {}),
  };
}

/** The YAML filter values for an event, `undefined` for each one the event does not carry. */
export function authoredDiscordFilters(
  event: string,
  value: DiscordFormFilters,
): { channels?: string[]; thread_messages?: true; emojis?: string[] } {
  if (!isDiscordFormEvent(event)) return {};
  const channels = value.channels ?? [];
  const emojis = event === REACTION_EVENT ? parseEmojis(value.emojis ?? "") : [];
  return {
    ...(channels.length === 0 ? {} : { channels }),
    ...(value.threadMessages === true ? { thread_messages: true as const } : {}),
    ...(emojis.length === 0 ? {} : { emojis }),
  };
}

export const DISCORD_FILTER_KEYS = ["channels", "thread_messages", "emojis"] as const;

/**
 * Discord filters survive a change between Discord events, except emojis, which only a reaction
 * has. Another provider's event takes none of them.
 */
export function carriedDiscordFilters(
  previous: string,
  next: string,
  value: DiscordFormFilters,
): DiscordFormFilters {
  if (!isDiscordFormEvent(previous) || !isDiscordFormEvent(next)) return {};
  return {
    ...(value.channels === undefined ? {} : { channels: value.channels }),
    ...(value.threadMessages === undefined ? {} : { threadMessages: value.threadMessages }),
    ...(next === REACTION_EVENT && value.emojis !== undefined ? { emojis: value.emojis } : {}),
  };
}

export function discordFilterErrors(event: string, value: DiscordFormFilters): { emojis?: string } {
  return event === REACTION_EVENT && parseEmojis(value.emojis ?? "").length === 0
    ? { emojis: "Name at least one emoji, or every reaction would start a run." }
    : {};
}

function parseEmojis(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/u).filter(Boolean))];
}
