import type { Message } from "discord.js";
import {
  choiceClickNotice,
  choiceResolutionText,
  type ConversationChoices,
} from "../../conversation-choices/index.js";
import type { ProviderEventAcceptance } from "../../db/types.js";
import type { TriggerHandler, TriggerSource } from "../index.js";
import type { ProviderEventDropReasonCode } from "../drop-reason.js";
import { logProviderEventIntake } from "../audit.js";
import type {
  DiscordBotClient,
  DiscordButtonClick,
  DiscordButtonClickResult,
  DiscordReactionAddHandler,
} from "./bot.js";
import { NormalizedDiscordMessageEventSchema } from "./events.js";
import type { NormalizedDiscordMessageEvent } from "./events.js";

export interface CreateDiscordGatewaySourceOptions {
  bot: DiscordBotClient;
  accept(input: {
    guildId: string;
    deliveryId: string;
    source: string;
    payload: unknown;
    receivedAt: Date;
    dropReason?: ProviderEventDropReasonCode;
  }): Promise<ProviderEventAcceptance>;
  applyGuildDelete(guildId: string, unavailable: boolean): Promise<void>;
  /** Resolves clicks on choice buttons; without it the bot ignores button clicks. */
  choices?: ConversationChoices;
}

export function createDiscordGatewaySource(
  options: CreateDiscordGatewaySourceOptions,
): TriggerSource {
  const handlers = new Set<TriggerHandler>();
  let unsubscribe: (() => void) | undefined;
  let unsubscribeReactions: (() => void) | undefined;
  let unsubscribeGuildDelete: (() => void) | undefined;
  let unsubscribeButtons: (() => void) | undefined;

  return {
    async start(handler) {
      handlers.add(handler);
      if (unsubscribe !== undefined) {
        return;
      }
      await options.bot.start();
      unsubscribe = options.bot.onMessageCreate(async (message) => {
        await dispatchMessage(message, handlers, options.bot.getSelfUserId(), options);
      });
      unsubscribeReactions = options.bot.onReactionAdd?.(async (reaction) => {
        await dispatchReaction(reaction, handlers, options.bot.getSelfUserId(), options);
      });
      unsubscribeGuildDelete = options.bot.onGuildDelete(async (guild) => {
        await options.applyGuildDelete(guild.id, guild.unavailable);
      });
      const choices = options.choices;
      if (choices !== undefined) {
        unsubscribeButtons = options.bot.onButtonClick?.((click) =>
          dispatchChoice(click, choices, handlers, options),
        );
      }
    },
    async stop() {
      handlers.clear();
      if (unsubscribe !== undefined) {
        unsubscribe();
        unsubscribe = undefined;
      }
      unsubscribeReactions?.();
      unsubscribeReactions = undefined;
      unsubscribeGuildDelete?.();
      unsubscribeGuildDelete = undefined;
      unsubscribeButtons?.();
      unsubscribeButtons = undefined;
      await options.bot.stop();
    },
  };
}

export function normalizeMessage(
  message: Message,
  botUserId?: string,
  type: NormalizedDiscordMessageEvent["type"] = "mention",
): NormalizedDiscordMessageEvent | undefined {
  if (message.guildId === null) {
    return undefined;
  }
  const channel = message.channel;
  if (channel === null) {
    return undefined;
  }

  const isThread = typeof channel.isThread === "function" && channel.isThread();
  const parentChannelId = isThread ? (channel.parentId ?? null) : null;
  const mentionedBotRoleIds =
    botUserId === undefined
      ? []
      : message.mentions.roles
          .filter((role) => role.tags?.botId === botUserId)
          .map((role) => role.id);

  return NormalizedDiscordMessageEventSchema.parse({
    type,
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    threadId: isThread ? message.channelId : null,
    parentChannelId,
    messageId: message.id,
    content: message.content,
    mentionedUserIds: message.mentions.users.map((user) => user.id),
    mentionedBotRoleIds,
    author: {
      id: message.author.id,
      username: message.author.username,
      bot: message.author.bot,
    },
    createdAt: message.createdAt.toISOString(),
    attachments: normalizeAttachments(message),
    referencedMessage: normalizeReferencedMessage(message),
  });
}

async function dispatchMessage(
  message: Message,
  handlers: Set<TriggerHandler>,
  botUserId: string,
  options: CreateDiscordGatewaySourceOptions,
): Promise<void> {
  const normalized = normalizeMessage(message, botUserId);
  if (normalized === undefined || normalized.author.bot === true) return;

  if (mentionsBot(normalized, botUserId)) {
    await deliver(normalized, "discord.mention", `discord-${normalized.messageId}`, {
      receivedAt: new Date(normalized.createdAt),
      handlers,
      options,
    });
    return;
  }
  // An unmentioned message only matters inside a thread the bot started, where it may continue
  // that thread's conversation. Everything else in the server is not Hub's business.
  if (isBotThread(message, botUserId)) {
    await deliver(
      { ...normalized, type: "thread_message" },
      "discord.thread_message",
      `discord-${normalized.messageId}`,
      { receivedAt: new Date(normalized.createdAt), handlers, options },
    );
  }
}

async function dispatchReaction(
  reaction: Parameters<DiscordReactionAddHandler>[0],
  handlers: Set<TriggerHandler>,
  botUserId: string,
  options: CreateDiscordGatewaySourceOptions,
): Promise<void> {
  if (reaction.user.bot || reaction.user.id === botUserId) return;
  const normalized = normalizeMessage(reaction.message, botUserId, "reaction");
  if (normalized === undefined) return;
  const emojiKey = reaction.emoji.id ?? reaction.emoji.name;
  await deliver(
    NormalizedDiscordMessageEventSchema.parse({
      ...normalized,
      reaction: {
        emoji: reaction.emoji.name,
        emojiId: reaction.emoji.id,
        user: reaction.user,
      },
    }),
    "discord.reaction_added",
    `discord-reaction-${normalized.messageId}-${reaction.user.id}-${emojiKey}`,
    // The reacted message can be old; the event is the reaction, which is now.
    { receivedAt: new Date(), handlers, options },
  );
}

async function dispatchChoice(
  click: DiscordButtonClick,
  choices: ConversationChoices,
  handlers: Set<TriggerHandler>,
  options: CreateDiscordGatewaySourceOptions,
): Promise<DiscordButtonClickResult> {
  const result = await choices.select({
    provider: "discord",
    buttonId: click.customId,
    user: { id: click.user.id, username: click.user.username },
  });
  if (result.status !== "selected") return { notice: choiceClickNotice(result) };
  await deliver(
    NormalizedDiscordMessageEventSchema.parse({
      type: "choice",
      id: click.messageId,
      guildId: click.guildId,
      channelId: click.channelId,
      threadId: click.threadId,
      parentChannelId: click.parentChannelId,
      messageId: click.messageId,
      content: result.selection.label,
      mentionedUserIds: [],
      author: click.user,
      createdAt: new Date().toISOString(),
      attachments: [],
      referencedMessage: null,
      choice: result.selection,
    }),
    "discord.choice_selected",
    `discord-choice-${result.choice.id}`,
    { receivedAt: new Date(), handlers, options },
  );
  return { resolved: choiceResolutionText(result.choice) };
}

async function deliver(
  event: NormalizedDiscordMessageEvent,
  source: string,
  deliveryId: string,
  {
    receivedAt,
    handlers,
    options,
  }: {
    receivedAt: Date;
    handlers: Set<TriggerHandler>;
    options: CreateDiscordGatewaySourceOptions;
  },
): Promise<void> {
  const normalizedEvent = NormalizedDiscordMessageEventSchema.parse(event);
  const acceptance = await options.accept({
    guildId: normalizedEvent.guildId,
    source,
    deliveryId,
    receivedAt,
    payload: normalizedEvent,
    ...(handlers.size === 0 ? { dropReason: "configuration_unavailable" } : {}),
  });
  logProviderEventIntake({
    provider: "discord",
    source,
    deliveryId,
    resourceId: normalizedEvent.guildId,
    acceptance,
  });
  if (acceptance.status !== "accepted") return;

  for (const acceptedEvent of acceptance.events) {
    for (const handler of handlers) await handler(acceptedEvent);
  }
}

function mentionsBot(event: NormalizedDiscordMessageEvent, botUserId: string): boolean {
  return event.mentionedUserIds.includes(botUserId) || (event.mentionedBotRoleIds?.length ?? 0) > 0;
}

function isBotThread(message: Message, botUserId: string): boolean {
  const channel = message.channel;
  return (
    typeof channel.isThread === "function" && channel.isThread() && channel.ownerId === botUserId
  );
}

function normalizeAttachments(message: Message) {
  return Array.from(message.attachments.values(), (attachment) => ({
    id: attachment.id,
    filename: attachment.name,
    url: attachment.url,
    contentType: attachment.contentType,
    size: attachment.size,
  }));
}

function normalizeReferencedMessage(message: Message) {
  const reference = message.reference;
  if (reference === null || reference.messageId === undefined) return null;
  return {
    id: reference.messageId,
    channelId: reference.channelId,
    guildId: reference.guildId ?? null,
  };
}
