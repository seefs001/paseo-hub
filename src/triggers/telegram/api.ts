import { z } from "zod";

const TELEGRAM_API = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 15_000;

/** The update kinds Hub asks for. Telegram omits `message_reaction` unless it is listed. */
export const TELEGRAM_ALLOWED_UPDATES = [
  "message",
  "message_reaction",
  "callback_query",
  "my_chat_member",
] as const;

export const TelegramUserSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
});

export const TelegramChatSchema = z.object({
  id: z.number().int(),
  type: z.enum(["private", "group", "supergroup", "channel"]),
  title: z.string().optional(),
  username: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  is_forum: z.boolean().optional(),
});

const TelegramEntitySchema = z.object({
  type: z.string(),
  offset: z.number().int(),
  length: z.number().int(),
  user: TelegramUserSchema.optional(),
});

const TelegramFileSchema = z.object({
  file_id: z.string(),
  file_unique_id: z.string(),
  file_size: z.number().int().optional(),
  file_name: z.string().optional(),
  mime_type: z.string().optional(),
});

const TelegramPhotoSizeSchema = z.object({
  file_id: z.string(),
  file_unique_id: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  file_size: z.number().int().optional(),
});

interface TelegramMessageShape {
  message_id: number;
  message_thread_id?: number | undefined;
  is_topic_message?: boolean | undefined;
  from?: z.infer<typeof TelegramUserSchema> | undefined;
  sender_chat?: z.infer<typeof TelegramChatSchema> | undefined;
  chat: z.infer<typeof TelegramChatSchema>;
  date: number;
  text?: string | undefined;
  caption?: string | undefined;
  entities?: z.infer<typeof TelegramEntitySchema>[] | undefined;
  caption_entities?: z.infer<typeof TelegramEntitySchema>[] | undefined;
  reply_to_message?: TelegramMessageShape | undefined;
  document?: z.infer<typeof TelegramFileSchema> | undefined;
  photo?: z.infer<typeof TelegramPhotoSizeSchema>[] | undefined;
  audio?: z.infer<typeof TelegramFileSchema> | undefined;
  video?: z.infer<typeof TelegramFileSchema> | undefined;
  voice?: z.infer<typeof TelegramFileSchema> | undefined;
  migrate_to_chat_id?: number | undefined;
}

export const TelegramMessageSchema: z.ZodType<TelegramMessageShape> = z.lazy(() =>
  z.object({
    message_id: z.number().int(),
    message_thread_id: z.number().int().optional(),
    is_topic_message: z.boolean().optional(),
    from: TelegramUserSchema.optional(),
    sender_chat: TelegramChatSchema.optional(),
    chat: TelegramChatSchema,
    date: z.number().int(),
    text: z.string().optional(),
    caption: z.string().optional(),
    entities: z.array(TelegramEntitySchema).optional(),
    caption_entities: z.array(TelegramEntitySchema).optional(),
    reply_to_message: TelegramMessageSchema.optional(),
    document: TelegramFileSchema.optional(),
    photo: z.array(TelegramPhotoSizeSchema).optional(),
    audio: TelegramFileSchema.optional(),
    video: TelegramFileSchema.optional(),
    voice: TelegramFileSchema.optional(),
    migrate_to_chat_id: z.number().int().optional(),
  }),
);

const TelegramReactionTypeSchema = z.union([
  z.object({ type: z.literal("emoji"), emoji: z.string() }),
  z.object({ type: z.literal("custom_emoji"), custom_emoji_id: z.string() }),
  z.object({ type: z.literal("paid") }),
]);

export const TelegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: TelegramMessageSchema.optional(),
  message_reaction: z
    .object({
      chat: TelegramChatSchema,
      message_id: z.number().int(),
      user: TelegramUserSchema.optional(),
      date: z.number().int(),
      old_reaction: z.array(TelegramReactionTypeSchema),
      new_reaction: z.array(TelegramReactionTypeSchema),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: TelegramUserSchema,
      message: z
        .object({
          message_id: z.number().int(),
          chat: TelegramChatSchema,
          message_thread_id: z.number().int().optional(),
        })
        .loose()
        .optional(),
      data: z.string().optional(),
    })
    .optional(),
  my_chat_member: z
    .object({
      chat: TelegramChatSchema,
      from: TelegramUserSchema,
      new_chat_member: z.object({ status: z.string() }).loose(),
    })
    .optional(),
});

export type TelegramUser = z.infer<typeof TelegramUserSchema>;
export type TelegramChat = z.infer<typeof TelegramChatSchema>;
export type TelegramMessage = TelegramMessageShape;
export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;

export interface TelegramInlineButton {
  text: string;
  callback_data: string;
  style?: "primary" | "success" | "danger";
}

export interface TelegramSendTarget {
  chatId: string;
  topicId: number | null;
  replyToMessageId: number | null;
}

export interface TelegramUploadFile {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Buffer;
}

export class TelegramApiError extends Error {
  override readonly name = "TelegramApiError";

  constructor(
    readonly method: string,
    readonly status: number,
    readonly errorCode: number | undefined,
    description: string,
  ) {
    super(`Telegram ${method} failed: ${description}`);
  }
}

const ResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  error_code: z.number().int().optional(),
});

/** The Bot API methods Hub uses. Each call is one HTTPS request; there is no client state. */
export interface TelegramBotApi {
  getMe(): Promise<TelegramUser>;
  getUpdates(input: {
    offset: number;
    timeoutSeconds: number;
    signal?: AbortSignal;
  }): Promise<unknown[]>;
  setWebhook(input: { url: string; secretToken: string }): Promise<void>;
  deleteWebhook(): Promise<void>;
  sendRichMessage(
    target: TelegramSendTarget,
    markdown: string,
    buttons?: readonly TelegramInlineButton[],
  ): Promise<TelegramMessage>;
  sendMessage(target: TelegramSendTarget, text: string): Promise<TelegramMessage>;
  sendDocument(target: TelegramSendTarget, file: TelegramUploadFile): Promise<TelegramMessage>;
  setMessageReaction(input: {
    chatId: string;
    messageId: number;
    emoji: string | null;
  }): Promise<void>;
  editMessageReplyMarkup(input: {
    chatId: string;
    messageId: number;
    buttons: readonly TelegramInlineButton[];
  }): Promise<void>;
  answerCallbackQuery(input: { callbackQueryId: string; text?: string }): Promise<void>;
  getFile(fileId: string): Promise<{ filePath: string; size: number | null }>;
  downloadFile(filePath: string, signal?: AbortSignal): Promise<Response>;
  getChatMemberStatus(chatId: string, userId: number): Promise<string>;
  leaveChat(chatId: string): Promise<void>;
}

export function createTelegramBotApi(options: {
  token: string;
  fetch?: typeof fetch;
}): TelegramBotApi {
  const request = options.fetch ?? fetch;
  const base = `${TELEGRAM_API}/bot${options.token}`;

  async function call(
    method: string,
    body: Record<string, unknown> | FormData,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await request(`${base}/${method}`, {
      method: "POST",
      ...(body instanceof FormData
        ? { body }
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const parsed = ResponseSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success || !parsed.data.ok) {
      throw new TelegramApiError(
        method,
        response.status,
        parsed.success ? parsed.data.error_code : undefined,
        parsed.success ? (parsed.data.description ?? "unknown error") : "malformed response",
      );
    }
    return parsed.data.result;
  }

  function targetFields(target: TelegramSendTarget): Record<string, unknown> {
    return {
      chat_id: target.chatId,
      ...(target.topicId === null ? {} : { message_thread_id: target.topicId }),
      ...(target.replyToMessageId === null
        ? {}
        : {
            reply_parameters: {
              message_id: target.replyToMessageId,
              allow_sending_without_reply: true,
            },
          }),
    };
  }

  function keyboard(buttons: readonly TelegramInlineButton[]) {
    return { inline_keyboard: buttons.map((button) => [button]) };
  }

  return {
    async getMe() {
      return TelegramUserSchema.parse(await call("getMe", {}));
    },
    async getUpdates(input) {
      const result = await call(
        "getUpdates",
        {
          offset: input.offset,
          timeout: input.timeoutSeconds,
          allowed_updates: TELEGRAM_ALLOWED_UPDATES,
        },
        input.signal === undefined
          ? AbortSignal.timeout((input.timeoutSeconds + 10) * 1_000)
          : AbortSignal.any([
              input.signal,
              AbortSignal.timeout((input.timeoutSeconds + 10) * 1_000),
            ]),
      );
      return z.array(z.unknown()).parse(result);
    },
    async setWebhook(input) {
      await call("setWebhook", {
        url: input.url,
        secret_token: input.secretToken,
        allowed_updates: TELEGRAM_ALLOWED_UPDATES,
      });
    },
    async deleteWebhook() {
      await call("deleteWebhook", {});
    },
    async sendRichMessage(target, markdown, buttons) {
      return TelegramMessageSchema.parse(
        await call("sendRichMessage", {
          ...targetFields(target),
          rich_message: { markdown },
          ...(buttons === undefined || buttons.length === 0
            ? {}
            : { reply_markup: keyboard(buttons) }),
        }),
      );
    },
    async sendMessage(target, text) {
      return TelegramMessageSchema.parse(
        await call("sendMessage", { ...targetFields(target), text }),
      );
    },
    async sendDocument(target, file) {
      const form = new FormData();
      for (const [key, value] of Object.entries(targetFields(target))) {
        form.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
      form.set(
        "document",
        new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }),
        file.name,
      );
      return TelegramMessageSchema.parse(await call("sendDocument", form));
    },
    async setMessageReaction(input) {
      await call("setMessageReaction", {
        chat_id: input.chatId,
        message_id: input.messageId,
        reaction: input.emoji === null ? [] : [{ type: "emoji", emoji: input.emoji }],
      });
    },
    async editMessageReplyMarkup(input) {
      await call("editMessageReplyMarkup", {
        chat_id: input.chatId,
        message_id: input.messageId,
        reply_markup: keyboard(input.buttons),
      });
    },
    async answerCallbackQuery(input) {
      await call("answerCallbackQuery", {
        callback_query_id: input.callbackQueryId,
        ...(input.text === undefined ? {} : { text: input.text }),
      });
    },
    async getFile(fileId) {
      const file = z
        .object({ file_path: z.string(), file_size: z.number().int().optional() })
        .parse(await call("getFile", { file_id: fileId }));
      return { filePath: file.file_path, size: file.file_size ?? null };
    },
    downloadFile(filePath, signal) {
      return request(`${TELEGRAM_API}/file/bot${options.token}/${filePath}`, {
        method: "GET",
        signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    },
    async getChatMemberStatus(chatId, userId) {
      const member = z
        .object({ status: z.string() })
        .parse(await call("getChatMember", { chat_id: chatId, user_id: userId }));
      return member.status;
    },
    async leaveChat(chatId) {
      await call("leaveChat", { chat_id: chatId });
    },
  };
}
