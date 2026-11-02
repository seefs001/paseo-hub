import { z } from "zod";
import {
  choiceButtonId,
  readChoiceOptions,
  type ConversationChoices,
} from "../../conversation-choices/index.js";
import { DiscordSnowflakeSchema } from "../../discord/snowflake.js";
import {
  replyWithFilesOutputTool,
  type OutputExecutor,
  type OutputToolDefinition,
} from "../../execution-capabilities/outputs.js";
import { DISCORD_THREAD_NAME_MAX_LENGTH, type DiscordBotClient } from "./bot.js";
import { discordConversationKey } from "./provider.js";

const DiscordReplyArgsSchema = z.object({
  content: z.string().min(1),
  threadTitle: z.string().min(1).optional(),
});

/** Discord replies open a thread under the trigger message, so the agent can name it. */
export const discordReplyOutputTool: OutputToolDefinition = {
  ...replyWithFilesOutputTool,
  inputSchema: {
    ...replyWithFilesOutputTool.inputSchema,
    properties: {
      ...replyWithFilesOutputTool.inputSchema.properties,
      threadTitle: {
        type: "string",
        minLength: 1,
        maxLength: DISCORD_THREAD_NAME_MAX_LENGTH,
        description:
          "Name for the Discord thread this reply opens: a few words that summarize the request. Used only when the reply starts a new thread; ignored in an existing thread.",
      },
    },
  },
};

const DiscordReplyOutputContextSchema = z.object({
  /** Needed only to key the conversation a choice continues. */
  guildId: DiscordSnowflakeSchema.optional(),
  channelId: DiscordSnowflakeSchema,
  threadId: DiscordSnowflakeSchema.nullable().optional(),
  messageId: DiscordSnowflakeSchema,
});

export interface CreateDiscordReplyExecutorOptions {
  bot: DiscordBotClient;
  /** Records choice sets; without it a reply cannot carry buttons. */
  choices?: ConversationChoices;
}

export function createDiscordReplyExecutor(
  options: CreateDiscordReplyExecutorOptions,
): OutputExecutor {
  return async function executeDiscordReply(input) {
    const args = DiscordReplyArgsSchema.parse(input.args);
    const context = DiscordReplyOutputContextSchema.parse(input.outputContext);
    const choiceOptions = readChoiceOptions(input.args);
    if (
      choiceOptions !== undefined &&
      (options.choices === undefined || context.guildId === undefined)
    ) {
      throw new Error("choices unavailable");
    }
    const choiceSet =
      choiceOptions === undefined
        ? undefined
        : await options.choices!.create({
            agentExecutionId: input.agentExecutionId,
            provider: "discord",
            // The reply opens the trigger message's thread, which shares the message's ID.
            conversationKey: discordConversationKey({
              guildId: context.guildId!,
              threadId: context.threadId ?? null,
              messageId: context.messageId,
            }),
            options: choiceOptions,
          });

    const sent = await options.bot.sendConversationReply({
      channelId: context.channelId,
      threadId: context.threadId ?? null,
      messageId: context.messageId,
      content: args.content,
      ...(args.threadTitle === undefined ? {} : { threadTitle: args.threadTitle }),
      ...(input.files === undefined ? {} : { files: input.files }),
      ...(choiceSet === undefined
        ? {}
        : {
            buttons: choiceSet.options.map((option, index) => ({
              label: option.label,
              customId: choiceButtonId(choiceSet.id, index),
              ...(option.style === undefined ? {} : { style: option.style }),
            })),
          }),
    });
    if (choiceSet !== undefined && sent !== undefined) {
      await options.choices!.attachMessage(choiceSet.id, { ...sent });
    }
  };
}
