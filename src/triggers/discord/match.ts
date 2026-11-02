import type {
  CompiledTriggerConfig as CompiledTrigger,
  TriggerFilter,
} from "../../config/index.js";
import { choiceBelongsToTrigger } from "../../conversation-choices/index.js";
import type { NormalizedDiscordMessageEvent } from "./events.js";

type MatchedTriggerDefinition = Pick<CompiledTrigger, "name" | "on" | "filters">;

export interface MatchedDiscordTrigger {
  event: NormalizedDiscordMessageEvent;
  trigger: MatchedTriggerDefinition;
}

export function matchDiscordTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedDiscordMessageEvent,
  botClientId: string,
  connectionId?: string | null,
): MatchedDiscordTrigger[] {
  const matches: MatchedDiscordTrigger[] = [];

  for (const trigger of config.triggers) {
    if (
      !acceptsEvent(trigger, event) ||
      !matchesFilter(event, trigger.filters, botClientId, connectionId)
    ) {
      continue;
    }

    matches.push({ event, trigger });
  }

  return matches;
}

const MENTION_EVENT = "discord.mention";
const REACTION_EVENT = "discord.reaction_added";

/**
 * A mention and a reaction each start their own trigger's runs. An unmentioned thread message
 * starts nothing: it is offered to the triggers that opted into continuing their thread
 * conversations, and the provider keeps it only where that conversation already exists.
 */
function acceptsEvent(
  trigger: MatchedTriggerDefinition,
  event: NormalizedDiscordMessageEvent,
): boolean {
  if (event.type === "mention") return trigger.on === MENTION_EVENT;
  if (event.type === "reaction") return trigger.on === REACTION_EVENT;
  // A choice continues the conversation of the trigger whose reply carried the buttons.
  if (event.type === "choice") {
    return (
      event.choice !== undefined &&
      trigger.on.startsWith("discord.") &&
      choiceBelongsToTrigger(trigger.name, event.choice)
    );
  }
  return (
    (trigger.on === MENTION_EVENT || trigger.on === REACTION_EVENT) &&
    trigger.filters?.thread_messages === true
  );
}

/** Whether any trigger in a configuration can take this kind of Discord event at all. */
export function discordEventHasTrigger(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedDiscordMessageEvent,
): boolean {
  return config.triggers.some((trigger) => acceptsEvent(trigger, event));
}

function matchesFilter(
  event: NormalizedDiscordMessageEvent,
  filter: TriggerFilter | undefined,
  botClientId: string,
  connectionId?: string | null,
): boolean {
  if (!matchesEventGate(event, filter, botClientId)) {
    return false;
  }

  if (filter === undefined) {
    return false;
  }

  if (filter.connectionId !== undefined && filter.connectionId !== connectionId) {
    return false;
  }

  if (filter.from_users === undefined || filter.from_users.length === 0) {
    return false;
  }

  const guild = readStringFilter(filter, "guild");
  if (guild !== undefined && guild !== event.guildId) {
    return false;
  }

  const channels = readStringArrayFilter(filter, "channels");
  if (channels !== undefined && !matchesChannel(event, channels)) {
    return false;
  }

  const actor = discordEventActor(event);
  if (
    !filter.from_users.includes("*") &&
    !filter.from_users.includes(actor.username) &&
    !filter.from_users.includes(actor.id)
  ) {
    return false;
  }

  return true;
}

/** Who caused the event: the reacting user for a reaction, otherwise the message author. */
export function discordEventActor(event: NormalizedDiscordMessageEvent) {
  return event.reaction?.user ?? event.author;
}

/**
 * What each kind of event must carry before the shared filters apply. A mention names the bot
 * and its command marker; a reaction uses one of the trigger's emojis; a thread message carries
 * neither, since it continues a conversation that already passed them.
 */
function matchesEventGate(
  event: NormalizedDiscordMessageEvent,
  filter: TriggerFilter | undefined,
  botClientId: string,
): boolean {
  if (event.type === "mention") {
    const pattern = filter === undefined ? undefined : readPatternFilter(filter);
    return matchesBotMentionPattern(event, botClientId, pattern);
  }
  if (event.type === "reaction") {
    const reaction = event.reaction;
    const emojis = new Set((filter?.emojis ?? []).map(withoutVariationSelector));
    return (
      reaction !== undefined &&
      (emojis.has(withoutVariationSelector(reaction.emoji)) ||
        (reaction.emojiId !== null && emojis.has(reaction.emojiId)))
    );
  }
  return true;
}

/** "\u2764\ufe0f" and "\u2764" are the same reaction; typed emoji often differ only by this. */
function withoutVariationSelector(emoji: string): string {
  return emoji.replaceAll("\ufe0f", "");
}

export function readDiscordPromptBody(
  event: NormalizedDiscordMessageEvent,
  botClientId: string,
): string {
  const mention = findBotMention(event, botClientId);
  return mention === undefined
    ? event.content
    : event.content.slice(mention.index + mention.token.length).trimStart();
}

export function readDiscordMentionToken(
  event: NormalizedDiscordMessageEvent,
  botClientId: string,
): string | undefined {
  return findBotMention(event, botClientId)?.token;
}

export function readDiscordInvocationParserMessage(
  event: NormalizedDiscordMessageEvent,
  botClientId: string,
  filter: TriggerFilter | undefined,
): string {
  const body = readDiscordPromptBody(event, botClientId);
  const marker = filter === undefined ? undefined : readPatternFilter(filter);
  if (
    marker === undefined ||
    marker.length === 0 ||
    marker.includes("=") ||
    !body.startsWith(marker)
  )
    return body;
  const nextCharacter = body.at(marker.length);
  return nextCharacter === undefined || /\s/u.test(nextCharacter)
    ? body.slice(marker.length).trimStart()
    : body;
}

function matchesBotMentionPattern(
  event: NormalizedDiscordMessageEvent,
  botClientId: string,
  pattern: string | undefined,
): boolean {
  if (
    !event.mentionedUserIds.includes(botClientId) &&
    (event.mentionedBotRoleIds ?? []).length === 0
  ) {
    return false;
  }

  const afterMention = readDiscordPromptBody(event, botClientId);
  if (pattern === undefined || pattern.length === 0) {
    return true;
  }

  if (!afterMention.startsWith(pattern)) {
    return false;
  }

  const nextCharacter = afterMention.at(pattern.length);
  return nextCharacter === undefined || /\s/u.test(nextCharacter);
}

function findBotMention(
  event: NormalizedDiscordMessageEvent,
  botClientId: string,
): { index: number; token: string } | undefined {
  const tokens = [
    ...(event.mentionedUserIds.includes(botClientId)
      ? [`<@${botClientId}>`, `<@!${botClientId}>`]
      : []),
    ...(event.mentionedBotRoleIds ?? []).map((roleId) => `<@&${roleId}>`),
  ];

  return tokens
    .map((token) => ({ index: event.content.indexOf(token), token }))
    .find((mention) => mention.index >= 0);
}

function readPatternFilter(filter: TriggerFilter): string | undefined {
  return readStringFilter(filter, "pattern") ?? readStringFilter(filter, "contains");
}

function matchesChannel(event: NormalizedDiscordMessageEvent, channels: string[]): boolean {
  if (channels.includes(event.channelId)) {
    return true;
  }

  return event.parentChannelId !== null && channels.includes(event.parentChannelId);
}

function readStringFilter(
  filter: TriggerFilter,
  key: "guild" | "pattern" | "contains",
): string | undefined {
  const value = filter[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringArrayFilter(filter: TriggerFilter, key: "channels"): string[] | undefined {
  const value = filter[key];

  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}
