import type {
  CompiledTriggerConfig as CompiledTrigger,
  TriggerFilter,
} from "../../config/index.js";
import { choiceBelongsToTrigger } from "../../conversation-choices/index.js";
import type { NormalizedTelegramEvent } from "./events.js";

type MatchedTriggerDefinition = Pick<CompiledTrigger, "name" | "on" | "filters">;

const MENTION_EVENT = "telegram.mention";
const REACTION_EVENT = "telegram.reaction_added";

export function matchTelegramTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedTelegramEvent,
  connectionId?: string | null,
): MatchedTriggerDefinition[] {
  return config.triggers.filter(
    (trigger) =>
      acceptsEvent(trigger, event) && matchesFilter(event, trigger.filters, connectionId),
  );
}

/** Whether any trigger in a configuration can take this kind of Telegram event at all. */
export function telegramEventHasTrigger(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedTelegramEvent,
): boolean {
  return config.triggers.some((trigger) => acceptsEvent(trigger, event));
}

/**
 * A mention and a reaction each start their own trigger's runs. An unaddressed message only
 * continues a conversation, for triggers that opted in. A choice continues the conversation of
 * the trigger whose reply carried the buttons, and only that trigger's.
 */
function acceptsEvent(trigger: MatchedTriggerDefinition, event: NormalizedTelegramEvent): boolean {
  if (event.type === "mention") return trigger.on === MENTION_EVENT;
  if (event.type === "reaction") return trigger.on === REACTION_EVENT;
  if (event.type === "choice") {
    return (
      event.choice !== undefined &&
      trigger.on.startsWith("telegram.") &&
      choiceBelongsToTrigger(trigger.name, event.choice)
    );
  }
  return (
    (trigger.on === MENTION_EVENT || trigger.on === REACTION_EVENT) &&
    trigger.filters?.thread_messages === true
  );
}

function matchesFilter(
  event: NormalizedTelegramEvent,
  filter: TriggerFilter | undefined,
  connectionId?: string | null,
): boolean {
  if (filter === undefined || !matchesEventGate(event, filter)) return false;
  if (filter.connectionId !== undefined && filter.connectionId !== connectionId) return false;
  if (filter.from_users === undefined || filter.from_users.length === 0) return false;
  const topics = filter.channels?.filter((channel) => channel.length > 0);
  if (
    topics !== undefined &&
    topics.length > 0 &&
    (event.topicId === null || !topics.includes(String(event.topicId)))
  ) {
    return false;
  }
  const actor = telegramEventActor(event);
  return (
    filter.from_users.includes("*") ||
    filter.from_users.includes(actor.username) ||
    filter.from_users.includes(actor.id)
  );
}

/** Who caused the event: the reacting user for a reaction, otherwise the message author. */
export function telegramEventActor(event: NormalizedTelegramEvent) {
  return event.reaction?.user ?? event.author;
}

/**
 * What each kind of event must carry before the shared filters apply. A mention starts with the
 * trigger's command marker; a reaction uses one of its emojis; continuations carry neither.
 */
function matchesEventGate(event: NormalizedTelegramEvent, filter: TriggerFilter): boolean {
  if (event.type === "mention") {
    const marker = readPattern(filter);
    return marker === undefined || startsWithMarker(event.body, marker);
  }
  if (event.type === "reaction") {
    const emojis = new Set((filter.emojis ?? []).map(withoutVariationSelector));
    return (
      event.reaction !== undefined && emojis.has(withoutVariationSelector(event.reaction.emoji))
    );
  }
  return true;
}

/** The message the invocation parser reads: the body after the trigger's command marker. */
export function readTelegramInvocationMessage(
  event: NormalizedTelegramEvent,
  filter: TriggerFilter | undefined,
): string {
  const marker = filter === undefined ? undefined : readPattern(filter);
  if (marker === undefined || marker.includes("=") || !startsWithMarker(event.body, marker)) {
    return event.body;
  }
  return event.body.slice(marker.length).trimStart();
}

function startsWithMarker(body: string, marker: string): boolean {
  if (!body.startsWith(marker)) return false;
  const next = body.at(marker.length);
  return next === undefined || /\s/u.test(next);
}

function readPattern(filter: TriggerFilter): string | undefined {
  const value = filter.pattern ?? filter.contains;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function withoutVariationSelector(emoji: string): string {
  return emoji.replaceAll("\ufe0f", "");
}
