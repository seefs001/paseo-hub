import { z } from "zod";
import { DiscordSnowflakeSchema } from "../../discord/snowflake.js";
import {
  replyWithFilesOutputTool,
  type OutputExecutor,
  type OutputToolDefinition,
} from "../../execution-capabilities/outputs.js";
import { DISCORD_THREAD_NAME_MAX_LENGTH, type DiscordBotClient } from "./bot.js";

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
  channelId: DiscordSnowflakeSchema,
  threadId: DiscordSnowflakeSchema.nullable().optional(),
  messageId: DiscordSnowflakeSchema,
});

export interface CreateDiscordReplyExecutorOptions {
  bot: DiscordBotClient;
}

export function createDiscordReplyExecutor(
  options: CreateDiscordReplyExecutorOptions,
): OutputExecutor {
  return async function executeDiscordReply(input) {
    const args = DiscordReplyArgsSchema.parse(input.args);
    const context = DiscordReplyOutputContextSchema.parse(input.outputContext);

    await options.bot.sendConversationReply({
      channelId: context.channelId,
      threadId: context.threadId ?? null,
      messageId: context.messageId,
      content: args.content,
      ...(args.threadTitle === undefined ? {} : { threadTitle: args.threadTitle }),
      ...(input.files === undefined ? {} : { files: input.files }),
    });
  };
}
