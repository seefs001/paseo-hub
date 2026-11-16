import { setTimeout } from "node:timers/promises";
import type {
  Database,
  ProviderEventAcceptance,
  TelegramConnectionRecord,
  TelegramMessageRecord,
} from "../../db/types.js";
import type { ConversationChoices } from "../../conversation-choices/index.js";
import { choiceClickNotice, choiceResolutionText } from "../../conversation-choices/index.js";
import { reportFailure } from "../../failures/index.js";
import { logProviderEventIntake } from "../audit.js";
import type { TriggerHandler, TriggerSource } from "../index.js";
import {
  TelegramUpdateSchema,
  type TelegramBotApi,
  type TelegramChat,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramUser,
} from "./api.js";
import {
  NormalizedTelegramEventSchema,
  type NormalizedTelegramEvent,
  type TelegramAttachment,
  type TelegramAuthor,
} from "./events.js";

import {
  createTelegramAlbumCollector,
  groupTelegramUpdates,
  hasTelegramAlbum,
  TELEGRAM_ALBUM_WINDOW_MS,
} from "./albums.js";

const POLL_TIMEOUT_SECONDS = 30;
const POLL_RETRY_MS = 5_000;
const WEBHOOK_SECRET_HEADER = "x-telegram-bot-api-secret-token";

export type TelegramTransport =
  | { kind: "webhook"; url: string; secretToken: string }
  | { kind: "polling" };

type SourceDatabase = Pick<
  Database,
  | "acceptTelegramEvent"
  | "findTelegramConnection"
  | "recordTelegramMessages"
  | "findTelegramMessage"
  | "listTelegramConversation"
  | "removeTelegramConnection"
  | "moveTelegramConnection"
>;

export interface TelegramSource extends TriggerSource {
  /** The webhook endpoint. Only answers while the source runs in webhook mode. */
  handleWebhook(request: Request): Promise<Response>;
}

export interface CreateTelegramSourceOptions {
  api: TelegramBotApi;
  identity(): Promise<TelegramUser>;
  transport: TelegramTransport;
  database: SourceDatabase;
  choices: ConversationChoices;
  /** Recorded on each receipt, so the app page can show when the bot last heard anything. */
  configurationVersion: number;
  /** Binds the chat a `/start <state>` arrived in; returns the message the bot posts there. */
  bind(state: string, chat: TelegramChat): Promise<string>;
}

export function createTelegramSource(options: CreateTelegramSourceOptions): TelegramSource {
  const handlers = new Set<TriggerHandler>();
  let polling: AbortController | undefined;
  let pollLoop: Promise<void> | undefined;
  let started = false;
  const webhookRequests = new Set<Promise<void>>();

  const albums = createTelegramAlbumCollector(async (updates) => {
    const bot = await options.identity();
    const anchor =
      updates.find(
        (update) =>
          update.message !== undefined && findBotMention(update.message, bot) !== undefined,
      ) ?? updates[0];
    if (anchor === undefined) return;
    const messages = updates.flatMap((update) =>
      update.message === undefined ? [] : [update.message],
    );
    const replyTo =
      anchor.message?.reply_to_message ??
      messages.find((message) => message.reply_to_message !== undefined)?.reply_to_message;
    const selected =
      anchor.message === undefined || replyTo === undefined
        ? anchor
        : {
            ...anchor,
            message: { ...anchor.message, reply_to_message: replyTo },
          };
    await processUpdate(selected, bot, handlers, options, messages);
  });
  const process = async (raw: unknown): Promise<void> => {
    const parsed = TelegramUpdateSchema.safeParse(raw);
    if (!parsed.success) return;
    await albums.accept(parsed.data);
  };

  return {
    async start(handler) {
      handlers.add(handler);
      if (started) return;
      started = true;
      await options.identity();
      if (options.transport.kind === "webhook") {
        await options.api.setWebhook({
          url: options.transport.url,
          secretToken: options.transport.secretToken,
        });
        return;
      }
      await options.api.deleteWebhook();
      const controller = new AbortController();
      polling = controller;
      pollLoop = poll(options.api, controller.signal, process);
    },
    async stop() {
      started = false;
      polling?.abort();
      polling = undefined;
      try {
        await albums.flush();
        await Promise.allSettled(webhookRequests);
        await pollLoop;
      } finally {
        handlers.clear();
        pollLoop = undefined;
      }
    },
    async handleWebhook(request) {
      if (options.transport.kind !== "webhook" || !started) {
        return new Response("Not Found", { status: 404 });
      }
      if (request.headers.get(WEBHOOK_SECRET_HEADER) !== options.transport.secretToken) {
        return new Response("Unauthorized", { status: 401 });
      }
      const processing = request
        .json()
        .catch(() => undefined)
        .then(process);
      webhookRequests.add(processing);
      try {
        await processing;
        return new Response(null, { status: 200 });
      } finally {
        webhookRequests.delete(processing);
      }
    },
  };
}

async function poll(
  api: TelegramBotApi,
  signal: AbortSignal,
  process: (update: unknown) => Promise<void>,
): Promise<void> {
  let offset = 0;
  while (!signal.aborted) {
    try {
      let updates = await api.getUpdates({
        offset,
        timeoutSeconds: POLL_TIMEOUT_SECONDS,
        signal,
      });
      if (hasTelegramAlbum(updates)) {
        // Read again at the same offset: the first batch remains unacknowledged while collecting.
        await delay(TELEGRAM_ALBUM_WINDOW_MS, signal);
        if (signal.aborted) return;
        const more = await api.getUpdates({ offset, timeoutSeconds: 0, signal });
        const unique = new Map(updates.map((update) => [readUpdateId(update), update]));
        for (const update of more) unique.set(readUpdateId(update), update);
        updates = [...unique.values()];
      }
      for (const group of groupTelegramUpdates(updates)) {
        await Promise.all(
          group.map(async (update) => {
            try {
              await process(update);
            } catch (error) {
              reportFailure(error, {
                operation: "telegram.update.process",
                component: "triggers",
                provider: "telegram",
              });
            }
            const updateId = readUpdateId(update);
            if (updateId !== undefined) offset = Math.max(offset, updateId + 1);
          }),
        );
      }
    } catch (error) {
      if (signal.aborted) return;
      reportFailure(error, {
        operation: "telegram.updates.poll",
        component: "triggers",
        provider: "telegram",
      });
      await delay(POLL_RETRY_MS, signal);
    }
  }
}

async function processUpdate(
  update: TelegramUpdate,
  bot: TelegramUser,
  handlers: Set<TriggerHandler>,
  options: CreateTelegramSourceOptions,
  album: readonly TelegramMessage[],
): Promise<void> {
  if (update.message !== undefined) {
    await processMessage(update.update_id, update.message, bot, handlers, options, album);
    return;
  }
  if (update.message_reaction !== undefined) {
    await processReaction(update.update_id, update.message_reaction, handlers, options);
    return;
  }
  if (update.callback_query !== undefined) {
    await processChoice(update.update_id, update.callback_query, handlers, options);
    return;
  }
  const member = update.my_chat_member;
  if (member !== undefined && ["left", "kicked"].includes(member.new_chat_member.status)) {
    await options.database.removeTelegramConnection(String(member.chat.id));
  }
}

async function processMessage(
  updateId: number,
  message: TelegramMessage,
  bot: TelegramUser,
  handlers: Set<TriggerHandler>,
  options: CreateTelegramSourceOptions,
  album: readonly TelegramMessage[],
): Promise<void> {
  if (message.migrate_to_chat_id !== undefined) {
    await options.database.moveTelegramConnection(
      String(message.chat.id),
      String(message.migrate_to_chat_id),
    );
    return;
  }
  const from = message.from;
  if (from === undefined || from.is_bot || message.chat.type === "channel") return;

  const text = message.text ?? message.caption ?? "";
  const state = readStartState(text, bot);
  if (state !== undefined) {
    const reply = await options.bind(state, message.chat).catch((error: unknown) => {
      reportFailure(error, {
        operation: "telegram.connection.bind",
        component: "connections",
        provider: "telegram",
      });
      return "Hub couldn't connect this chat. Start the connection again from Hub.";
    });
    await options.api.sendMessage(
      { chatId: String(message.chat.id), topicId: topicOf(message), replyToMessageId: null },
      reply,
    );
    return;
  }

  const connection = await options.database.findTelegramConnection(String(message.chat.id));
  if (connection === undefined) return;
  const mention = findBotMention(message, bot);
  const placement = await conversationOf(message, options.database);
  const addressed = mention !== undefined || message.chat.type === "private";
  // Everything else in the chat is not Hub's business: it is neither delivered nor kept.
  if (!addressed && !placement.known) return;
  const type = addressed ? "mention" : "thread_message";

  const event = NormalizedTelegramEventSchema.parse({
    type,
    chatId: String(message.chat.id),
    chatType: message.chat.type,
    chatTitle: chatTitle(message.chat),
    topicId: topicOf(message),
    messageId: message.message_id,
    conversationId: placement.conversationId,
    replyToMessageId: message.reply_to_message?.message_id ?? null,
    body: mention === undefined ? text.trim() : withoutMention(text, mention).trim(),
    text,
    author: author(from),
    createdAt: new Date(message.date * 1_000).toISOString(),
    attachments: album.flatMap(attachmentsOf),
    ...externalReplyOf(message),
  } satisfies NormalizedTelegramEvent);
  await options.database.recordTelegramMessages(
    transcriptRecords(event, connection, [message.reply_to_message, ...album]),
  );
  await deliver(
    event,
    type === "mention" ? "telegram.mention" : "telegram.thread_message",
    `telegram-${String(bot.id)}-${String(updateId)}`,
    handlers,
    options,
  );
}

async function processReaction(
  updateId: number,
  reaction: NonNullable<TelegramUpdate["message_reaction"]>,
  handlers: Set<TriggerHandler>,
  options: CreateTelegramSourceOptions,
): Promise<void> {
  const user = reaction.user;
  if (user === undefined || user.is_bot || reaction.chat.type === "channel") return;
  const previous = new Set(reaction.old_reaction.flatMap(emojiOf));
  const added = reaction.new_reaction.flatMap(emojiOf).filter((emoji) => !previous.has(emoji));
  if (added.length === 0) return;
  const chatId = String(reaction.chat.id);
  if ((await options.database.findTelegramConnection(chatId)) === undefined) return;
  const stored = await options.database.findTelegramMessage(chatId, reaction.message_id);
  for (const emoji of added) {
    const event = NormalizedTelegramEventSchema.parse({
      type: "reaction",
      chatId,
      chatType: reaction.chat.type,
      chatTitle: chatTitle(reaction.chat),
      topicId: stored?.topicId ?? null,
      messageId: reaction.message_id,
      conversationId: stored?.conversationId ?? `root:${String(reaction.message_id)}`,
      replyToMessageId: stored?.replyToMessageId ?? null,
      body: stored?.text ?? "",
      text: stored?.text ?? "",
      author: stored === undefined ? author(user) : storedAuthor(stored),
      createdAt: new Date(reaction.date * 1_000).toISOString(),
      attachments: storedAttachments(stored),
      reaction: { emoji, user: author(user) },
    } satisfies NormalizedTelegramEvent);
    await deliver(
      event,
      "telegram.reaction_added",
      `telegram-reaction-${chatId}-${String(reaction.message_id)}-${String(user.id)}-${emoji}-${String(updateId)}`,
      handlers,
      options,
    );
  }
}

async function processChoice(
  updateId: number,
  query: NonNullable<TelegramUpdate["callback_query"]>,
  handlers: Set<TriggerHandler>,
  options: CreateTelegramSourceOptions,
): Promise<void> {
  const message = query.message;
  if (query.data === undefined || message === undefined || message.chat.type === "channel") {
    await options.api.answerCallbackQuery({ callbackQueryId: query.id });
    return;
  }
  const user = author(query.from);
  const click = await options.choices.select({
    provider: "telegram",
    buttonId: query.data,
    user: { id: user.id, username: user.username },
  });
  if (click.status !== "selected") {
    await options.api.answerCallbackQuery({
      callbackQueryId: query.id,
      text: choiceClickNotice(click),
    });
    return;
  }
  await options.api.answerCallbackQuery({ callbackQueryId: query.id });
  const chatId = String(message.chat.id);
  await options.api
    .editMessageReplyMarkup({
      chatId,
      messageId: message.message_id,
      buttons: [{ text: choiceResolutionText(click.choice), callback_data: query.data }],
    })
    .catch((error: unknown) => {
      reportFailure(error, {
        operation: "telegram.choice.resolve_markup",
        component: "triggers",
        provider: "telegram",
      });
    });
  const stored = await options.database.findTelegramMessage(chatId, message.message_id);
  const event = NormalizedTelegramEventSchema.parse({
    type: "choice",
    chatId,
    chatType: message.chat.type,
    chatTitle: chatTitle(message.chat),
    topicId: message.message_thread_id ?? stored?.topicId ?? null,
    messageId: message.message_id,
    conversationId: stored?.conversationId ?? `root:${String(message.message_id)}`,
    replyToMessageId: null,
    body: click.selection.label,
    text: click.selection.label,
    author: user,
    createdAt: new Date().toISOString(),
    attachments: [],
    choice: click.selection,
  } satisfies NormalizedTelegramEvent);
  await deliver(
    event,
    "telegram.choice_selected",
    `telegram-choice-${click.choice.id}-${String(updateId)}`,
    handlers,
    options,
  );
}

async function deliver(
  event: NormalizedTelegramEvent,
  source: string,
  deliveryId: string,
  handlers: Set<TriggerHandler>,
  options: CreateTelegramSourceOptions,
): Promise<void> {
  const bot = await options.identity();
  const acceptance: ProviderEventAcceptance = await options.database.acceptTelegramEvent({
    chatId: event.chatId,
    source,
    deliveryId,
    receivedAt: new Date(),
    providerApplicationId: String(bot.id),
    providerConfigurationVersion: options.configurationVersion,
    payload: event,
    ...(handlers.size === 0 ? { dropReason: "configuration_unavailable" } : {}),
  });
  logProviderEventIntake({
    provider: "telegram",
    source,
    deliveryId,
    resourceId: event.chatId,
    acceptance,
  });
  if (acceptance.status !== "accepted") return;
  for (const accepted of acceptance.events) {
    for (const handler of handlers) await handler(accepted);
  }
}

/** Where a message sits: its topic, existing reply chain, album, or the whole private chat. */
async function conversationOf(
  message: TelegramMessage,
  database: SourceDatabase,
): Promise<{ conversationId: string; known: boolean }> {
  const chatId = String(message.chat.id);
  const topicId = topicOf(message);
  if (topicId !== null) {
    const conversationId = `topic:${String(topicId)}`;
    const earlier = await database.listTelegramConversation({
      chatId,
      conversationId,
      beforeMessageId: message.message_id,
      limit: 1,
    });
    return { conversationId, known: earlier.length > 0 };
  }
  if (message.chat.type === "private") return { conversationId: "chat", known: true };
  if (message.media_group_id !== undefined) {
    const parent =
      message.reply_to_message === undefined
        ? undefined
        : await database.findTelegramMessage(chatId, message.reply_to_message.message_id);
    if (parent !== undefined) return { conversationId: parent.conversationId, known: true };
    const conversationId = `album:${message.media_group_id}`;
    const earlier = await database.listTelegramConversation({
      chatId,
      conversationId,
      beforeMessageId: Number.MAX_SAFE_INTEGER,
      limit: 1,
    });
    return { conversationId, known: earlier.length > 0 };
  }
  const replyTo = message.reply_to_message;
  if (replyTo === undefined) {
    return { conversationId: `root:${String(message.message_id)}`, known: false };
  }
  const parent = await database.findTelegramMessage(chatId, replyTo.message_id);
  return parent === undefined
    ? { conversationId: `root:${String(replyTo.message_id)}`, known: false }
    : { conversationId: parent.conversationId, known: true };
}

/** A topic message's thread; a reply's `message_thread_id` outside a forum is not a topic. */
export function topicOf(message: TelegramMessage): number | null {
  return message.is_topic_message === true ? (message.message_thread_id ?? null) : null;
}

interface BotMention {
  offset: number;
  length: number;
  /** For `/command@bot`, the command stays in the body; only `@bot` is removed. */
  keep: number;
}

function findBotMention(message: TelegramMessage, bot: TelegramUser): BotMention | undefined {
  const text = message.text ?? message.caption ?? "";
  const entities = message.entities ?? message.caption_entities ?? [];
  const handle = `@${bot.username ?? ""}`.toLowerCase();
  for (const entity of entities) {
    const value = text.slice(entity.offset, entity.offset + entity.length);
    if (entity.type === "mention" && bot.username !== undefined && value.toLowerCase() === handle) {
      return { offset: entity.offset, length: entity.length, keep: 0 };
    }
    if (entity.type === "text_mention" && entity.user?.id === bot.id) {
      return { offset: entity.offset, length: entity.length, keep: 0 };
    }
    if (
      entity.type === "bot_command" &&
      bot.username !== undefined &&
      value.toLowerCase().endsWith(handle)
    ) {
      return { offset: entity.offset, length: entity.length, keep: entity.length - handle.length };
    }
  }
  return undefined;
}

function withoutMention(text: string, mention: BotMention): string {
  return (
    text.slice(0, mention.offset + mention.keep) + text.slice(mention.offset + mention.length)
  ).replaceAll(/\s{2,}/gu, " ");
}

/** `/start <state>` or `/start@bot <state>`, as sent by the connection deep links. */
function readStartState(text: string, bot: TelegramUser): string | undefined {
  const match = /^\/start(?:@([A-Za-z0-9_]+))?\s+([A-Za-z0-9_-]{16,64})\s*$/u.exec(text);
  if (match === null) return undefined;
  const addressed = match[1];
  if (addressed !== undefined && addressed.toLowerCase() !== (bot.username ?? "").toLowerCase()) {
    return undefined;
  }
  return match[2];
}

export function attachmentsOf(
  message: Pick<
    TelegramMessage,
    "message_id" | "document" | "photo" | "audio" | "video" | "voice" | "sticker" | "video_note"
  >,
): TelegramAttachment[] {
  const files: TelegramAttachment[] = [];
  const add = (
    file: { file_id: string; file_unique_id: string; file_size?: number | undefined } | undefined,
    filename: string,
    contentType: string | null,
  ) => {
    if (file === undefined) return;
    files.push({
      fileId: file.file_id,
      fileUniqueId: file.file_unique_id,
      filename,
      contentType,
      size: file.file_size ?? null,
    });
  };
  const largestPhoto = message.photo?.at(-1);
  add(largestPhoto, `photo-${String(message.message_id)}.jpg`, "image/jpeg");
  const sticker = message.sticker;
  if (sticker !== undefined) {
    let format = { extension: "webp", contentType: "image/webp" };
    if (sticker.is_animated) {
      format = { extension: "tgs", contentType: "application/x-tgsticker" };
    } else if (sticker.is_video) {
      format = { extension: "webm", contentType: "video/webm" };
    }
    add(sticker, `sticker-${String(message.message_id)}.${format.extension}`, format.contentType);
    if (sticker.is_animated || sticker.is_video) {
      // Telegram thumbnails may be JPEG or WebP; leave the type for the downloaded bytes.
      add(sticker.thumbnail, `sticker-${String(message.message_id)}-thumbnail`, null);
    }
  }
  for (const [kind, file] of [
    ["document", message.document],
    ["audio", message.audio],
    ["video", message.video],
    ["voice", message.voice],
  ] as const) {
    add(file, file?.file_name ?? `${kind}-${String(message.message_id)}`, file?.mime_type ?? null);
  }
  add(message.video_note, `video-note-${String(message.message_id)}.mp4`, "video/mp4");
  return files;
}

function externalReplyOf(message: TelegramMessage): Pick<NormalizedTelegramEvent, "externalReply"> {
  const reply = message.external_reply;
  if (reply === undefined) return {};
  return {
    externalReply: {
      chatId: reply.chat === undefined ? null : String(reply.chat.id),
      messageId: reply.message_id ?? null,
      text: message.quote?.text ?? "",
      attachments: attachmentsOf({ ...reply, message_id: reply.message_id ?? message.message_id }),
    },
  };
}

function emojiOf(reaction: TelegramUpdateReaction): string[] {
  return reaction.type === "emoji" ? [reaction.emoji] : [];
}

type TelegramUpdateReaction = NonNullable<
  TelegramUpdate["message_reaction"]
>["new_reaction"][number];

export function author(user: TelegramUser): TelegramAuthor {
  return {
    id: String(user.id),
    username: user.username ?? [user.first_name, user.last_name].filter(Boolean).join(" "),
    bot: user.is_bot,
  };
}

function storedAuthor(stored: TelegramMessageRecord): TelegramAuthor {
  return { id: stored.authorId, username: stored.authorUsername, bot: stored.fromBot };
}

function storedAttachments(stored: TelegramMessageRecord | undefined): TelegramAttachment[] {
  return stored === undefined ? [] : [...stored.attachments];
}

export function chatTitle(chat: TelegramChat): string {
  return (
    chat.title ??
    chat.username ??
    ([chat.first_name, chat.last_name].filter(Boolean).join(" ") || String(chat.id))
  );
}

function transcriptRecords(
  event: NormalizedTelegramEvent,
  connection: TelegramConnectionRecord,
  related: readonly (TelegramMessage | undefined)[],
): TelegramMessageRecord[] {
  const records = [transcriptRecord(event, connection)];
  const seen = new Set([event.messageId]);
  for (const replyTo of related) {
    if (replyTo?.from === undefined || seen.has(replyTo.message_id)) continue;
    seen.add(replyTo.message_id);
    // Keep only explicit references and the members of this addressed album.
    const replyAuthor = author(replyTo.from);
    records.unshift({
      connectionId: connection.id,
      chatId: String(replyTo.chat.id),
      messageId: replyTo.message_id,
      conversationId: event.conversationId,
      topicId: topicOf(replyTo),
      replyToMessageId: replyTo.reply_to_message?.message_id ?? null,
      authorId: replyAuthor.id,
      authorUsername: replyAuthor.username,
      fromBot: replyAuthor.bot,
      text: replyTo.text ?? replyTo.caption ?? "",
      attachments: attachmentsOf(replyTo),
      createdAt: new Date(replyTo.date * 1_000),
    });
  }
  return records;
}

export function transcriptRecord(
  event: NormalizedTelegramEvent,
  connection: TelegramConnectionRecord,
): TelegramMessageRecord {
  return {
    connectionId: connection.id,
    chatId: event.chatId,
    messageId: event.messageId,
    conversationId: event.conversationId,
    topicId: event.topicId,
    replyToMessageId: event.replyToMessageId,
    authorId: event.author.id,
    authorUsername: event.author.username,
    fromBot: event.author.bot,
    text: event.text,
    attachments: event.attachments,
    createdAt: new Date(event.createdAt),
  };
}

function readUpdateId(update: unknown): number | undefined {
  if (typeof update !== "object" || update === null) return undefined;
  const value: unknown = Reflect.get(update, "update_id");
  return typeof value === "number" ? value : undefined;
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await setTimeout(ms, undefined, { signal });
  } catch {
    // Aborted: the source is stopping.
  }
}
