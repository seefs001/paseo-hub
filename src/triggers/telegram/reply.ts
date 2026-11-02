import { z } from "zod";
import {
  choiceButtonId,
  readChoiceOptions,
  type ConversationChoices,
} from "../../conversation-choices/index.js";
import type { Database } from "../../db/types.js";
import type { OutputExecutor } from "../../execution-capabilities/outputs.js";
import type { TelegramBotApi, TelegramInlineButton, TelegramMessage, TelegramUser } from "./api.js";
import { telegramConversationKey } from "./events.js";
import { author } from "./source.js";

/** Rich messages hold 32768 characters; a reply is split at paragraphs below that. */
const MAX_RICH_MESSAGE_LENGTH = 32_000;

const TelegramReplyArgsSchema = z.object({ content: z.string().min(1) }).loose();

const TelegramOutputContextSchema = z.object({
  connectionId: z.string().nullable(),
  chatId: z.string(),
  topicId: z.number().int().nullable(),
  messageId: z.number().int(),
  conversationId: z.string(),
});

export function createTelegramReplyExecutor(options: {
  api: TelegramBotApi;
  identity(): Promise<TelegramUser>;
  database: Pick<Database, "recordTelegramMessages">;
  choices: ConversationChoices;
}): OutputExecutor {
  return async function executeTelegramReply(input) {
    const args = TelegramReplyArgsSchema.parse(input.args);
    const context = TelegramOutputContextSchema.parse(input.outputContext);
    const target = {
      chatId: context.chatId,
      topicId: context.topicId,
      replyToMessageId: context.messageId,
    };
    const choiceOptions = readChoiceOptions(input.args);
    const choiceSet =
      choiceOptions === undefined
        ? undefined
        : await options.choices.create({
            agentExecutionId: input.agentExecutionId,
            provider: "telegram",
            connectionId: context.connectionId,
            conversationKey: telegramConversationKey(context.chatId, context.conversationId),
            options: choiceOptions,
          });
    const buttons: TelegramInlineButton[] =
      choiceSet === undefined
        ? []
        : choiceSet.options.map((option, index) => ({
            text: option.label,
            callback_data: choiceButtonId(choiceSet.id, index),
            ...(option.style === undefined ? {} : { style: option.style }),
          }));

    const sent: TelegramMessage[] = [];
    const chunks = splitMessage(args.content);
    for (const [index, chunk] of chunks.entries()) {
      sent.push(
        await options.api.sendRichMessage(
          target,
          chunk,
          index === chunks.length - 1 ? buttons : undefined,
        ),
      );
    }
    for (const file of input.files ?? []) {
      sent.push(await options.api.sendDocument(target, file));
    }
    const question = sent.at(chunks.length - 1);
    if (choiceSet !== undefined && question !== undefined) {
      await options.choices.attachMessage(choiceSet.id, {
        chatId: context.chatId,
        messageId: question.message_id,
      });
    }
    if (context.connectionId !== null) {
      const bot = author(await options.identity());
      await options.database.recordTelegramMessages(
        sent.map((message, index) => ({
          connectionId: context.connectionId!,
          chatId: context.chatId,
          messageId: message.message_id,
          conversationId: context.conversationId,
          topicId: context.topicId,
          replyToMessageId: context.messageId,
          authorId: bot.id,
          authorUsername: bot.username,
          fromBot: true,
          text: chunks[index] ?? "",
          attachments: [],
          createdAt: new Date(message.date * 1_000),
        })),
      );
    }
  };
}

function splitMessage(content: string): string[] {
  const chunks: string[] = [];
  let rest = content;
  while (rest.length > MAX_RICH_MESSAGE_LENGTH) {
    const window = rest.slice(0, MAX_RICH_MESSAGE_LENGTH);
    const paragraph = window.lastIndexOf("\n\n");
    const cut = paragraph > MAX_RICH_MESSAGE_LENGTH / 2 ? paragraph : MAX_RICH_MESSAGE_LENGTH;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  chunks.push(rest);
  return chunks;
}
