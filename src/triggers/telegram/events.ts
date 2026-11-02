import { z } from "zod";
import { ChoiceSelectionSchema } from "../../conversation-choices/index.js";

export const TelegramAuthorSchema = z.object({
  id: z.string(),
  username: z.string(),
  bot: z.boolean(),
});

export const TelegramAttachmentSchema = z.object({
  fileId: z.string(),
  fileUniqueId: z.string(),
  filename: z.string(),
  contentType: z.string().nullable(),
  size: z.number().int().nonnegative().nullable(),
});

export const NormalizedTelegramEventSchema = z.object({
  /**
   * `mention` addresses the bot; `thread_message` is an unaddressed message in a conversation
   * Hub takes part in; `reaction` is a reaction added by `reaction.user`; `choice` is a click on a
   * button an agent attached to a reply.
   */
  type: z.enum(["mention", "thread_message", "reaction", "choice"]),
  chatId: z.string(),
  chatType: z.enum(["private", "group", "supergroup"]),
  chatTitle: z.string(),
  /** The forum topic, when the chat has topics. */
  topicId: z.number().int().nullable(),
  messageId: z.number().int(),
  /** `topic:<id>`, `root:<message id>` for a reply chain, or `chat` for a private chat. */
  conversationId: z.string(),
  replyToMessageId: z.number().int().nullable(),
  /** The message text with the bot's mention or command removed. */
  body: z.string(),
  text: z.string(),
  author: TelegramAuthorSchema,
  createdAt: z.string(),
  attachments: z.array(TelegramAttachmentSchema),
  reaction: z.object({ emoji: z.string(), user: TelegramAuthorSchema }).optional(),
  choice: ChoiceSelectionSchema.optional(),
});

export type TelegramAuthor = z.infer<typeof TelegramAuthorSchema>;
export type TelegramAttachment = z.infer<typeof TelegramAttachmentSchema>;
export type NormalizedTelegramEvent = z.infer<typeof NormalizedTelegramEventSchema>;

export function telegramConversationKey(chatId: string, conversationId: string): string {
  return JSON.stringify(["telegram", chatId, conversationId]);
}
