import {
  ButtonStyle,
  Client,
  ComponentType,
  DiscordAPIError,
  GatewayIntentBits,
  Partials,
  RESTJSONErrorCodes,
  type GuildBasedChannel,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import { Routes } from "discord-api-types/v10";
import { reportFailure } from "../../failures/index.js";
import { DiscordSnowflakeSchema } from "../../discord/snowflake.js";
import { NormalizedDiscordContextMessageSchema } from "./events.js";
import type { NormalizedDiscordContextMessage } from "./events.js";

type DiscordGatewayFailure =
  | "authenticationFailed"
  | "invalidShard"
  | "shardingRequired"
  | "invalidApiVersion"
  | "invalidIntents"
  | "disallowedIntents";

type DiscordGatewayFailureCode = "credentialsRejected" | "permissionMissing" | "internal";

const UNRECOVERABLE_GATEWAY_FAILURES = new Map<
  number,
  { failure: DiscordGatewayFailure; code: DiscordGatewayFailureCode }
>([
  [4004, { failure: "authenticationFailed", code: "credentialsRejected" }],
  [4010, { failure: "invalidShard", code: "internal" }],
  [4011, { failure: "shardingRequired", code: "internal" }],
  [4012, { failure: "invalidApiVersion", code: "internal" }],
  [4013, { failure: "invalidIntents", code: "internal" }],
  [4014, { failure: "disallowedIntents", code: "permissionMissing" }],
]);

class DiscordGatewayError extends Error {
  override readonly name = "DiscordGatewayError";

  constructor(
    readonly gatewayCloseCode: number,
    readonly gatewayFailure: DiscordGatewayFailure,
    readonly code: DiscordGatewayFailureCode,
    options?: ErrorOptions,
  ) {
    super("Discord gateway rejected the connection", options);
  }
}

function discordGatewayError(closeCode: number, cause: unknown): DiscordGatewayError | undefined {
  const classification = UNRECOVERABLE_GATEWAY_FAILURES.get(closeCode);
  if (classification === undefined) return undefined;
  return new DiscordGatewayError(closeCode, classification.failure, classification.code, {
    cause,
  });
}

export interface DiscordReactionInput {
  channelId: string;
  messageId: string;
  emoji: string;
}

export interface DiscordPostInput {
  channelId: string;
  threadId?: string | null;
  content: string;
}

export interface DiscordConversationReplyInput extends DiscordPostInput {
  messageId: string;
  /** Name for the thread this reply opens; ignored when the message already has a thread. */
  threadTitle?: string;
  files?: readonly { name: string; bytes: Buffer }[];
  /** Buttons under the reply, one row; each click arrives through `onButtonClick`. */
  buttons?: readonly DiscordButton[];
}

export interface DiscordButton {
  label: string;
  customId: string;
  style?: "primary" | "success" | "danger";
}

/** Where a reply landed: the thread or channel, and the message itself. */
export interface DiscordSentMessage {
  channelId: string;
  messageId: string;
}

export interface DiscordButtonClick {
  customId: string;
  guildId: string;
  channelId: string;
  /** The parent channel, when the button sits in a thread. */
  parentChannelId: string | null;
  threadId: string | null;
  messageId: string;
  user: { id: string; username: string; bot: boolean };
}

/**
 * What a click handler wants shown. `notice` goes to the clicker alone; `resolved` replaces the
 * buttons for everyone.
 */
export interface DiscordButtonClickResult {
  notice?: string;
  resolved?: string;
}

export type DiscordButtonClickHandler = (
  click: DiscordButtonClick,
) => Promise<DiscordButtonClickResult>;

export const DISCORD_THREAD_NAME_MAX_LENGTH = 100;

export interface DiscordBotClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  getSelfUserId(): string;
  createReaction(input: DiscordReactionInput): Promise<void>;
  deleteOwnReaction(input: DiscordReactionInput): Promise<void>;
  sendChannelMessage(input: DiscordPostInput): Promise<void>;
  sendConversationReply(input: DiscordConversationReplyInput): Promise<DiscordSentMessage | void>;
  readMessage(input: {
    channelId: string;
    messageId: string;
  }): Promise<NormalizedDiscordContextMessage>;
  readThreadMessages(input: {
    channelId: string;
    beforeMessageId: string;
  }): Promise<NormalizedDiscordContextMessage[]>;
  onMessageCreate(handler: DiscordRawMessageHandler): () => void;
  /** Reactions added in a server, with the reacted message and the reacting user fetched. */
  onReactionAdd?(handler: DiscordReactionAddHandler): () => void;
  onGuildDelete(handler: DiscordGuildDeleteHandler): () => void;
  /** Button clicks on the bot's messages. One handler answers each click. */
  onButtonClick?(handler: DiscordButtonClickHandler): () => void;
}

export type DiscordRawMessageHandler = (message: Message) => Promise<void>;
export type DiscordReactionAddHandler = (reaction: {
  message: Message;
  emoji: { name: string; id: string | null };
  user: { id: string; username: string; bot: boolean };
}) => Promise<void>;
export type DiscordGuildDeleteHandler = (guild: {
  id: string;
  unavailable: boolean;
}) => Promise<void>;

type DiscordSendableChannel = TextBasedChannel & {
  send: (...args: unknown[]) => Promise<unknown>;
};

type DiscordReadableThread = TextBasedChannel & {
  fetchStarterMessage(): Promise<Message | null>;
};

const DISCORD_THREAD_CONTEXT_LIMIT = 50;

export interface CreateDiscordBotClientOptions {
  token: string;
  clientId?: string;
  client?: Client;
}

export function createDiscordBotClient(options: CreateDiscordBotClientOptions): DiscordBotClient {
  const client =
    options.client ??
    new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
      ],
      // A reaction can land on a message from before the bot started, which it has not cached.
      partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
    });
  const handlers = new Set<DiscordRawMessageHandler>();
  const reactionHandlers = new Set<DiscordReactionAddHandler>();
  const guildDeleteHandlers = new Set<DiscordGuildDeleteHandler>();
  let buttonClickHandler: DiscordButtonClickHandler | undefined;
  const pendingReplyDestinations = new Map<string, Promise<DiscordSendableChannel>>();
  let started = false;

  client.on("messageCreate", (message: Message) => {
    void Promise.all(Array.from(handlers, (handler) => handler(message))).catch(
      (error: unknown) => {
        reportFailure(
          error,
          { operation: "discord.event.handoff", component: "triggers", provider: "discord" },
          {
            scrubValues: [options.token],
            diagnostic: {
              deliveryId: `discord-${message.id}`,
              guildId: message.guildId,
              channelId: message.channelId,
            },
          },
        );
      },
    );
  });
  client.on("messageReactionAdd", (partialReaction, partialUser) => {
    if (reactionHandlers.size === 0 || partialUser.id === client.user?.id) return;
    void (async () => {
      const reaction = partialReaction.partial ? await partialReaction.fetch() : partialReaction;
      const user = partialUser.partial ? await partialUser.fetch() : partialUser;
      if (user.bot || reaction.message.guildId === null) return;
      const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
      const name = reaction.emoji.name;
      if (name === null) return;
      await Promise.all(
        Array.from(reactionHandlers, (handler) =>
          handler({
            message,
            emoji: { name, id: reaction.emoji.id },
            user: { id: user.id, username: user.username, bot: user.bot },
          }),
        ),
      );
    })().catch((error: unknown) => {
      reportFailure(
        error,
        { operation: "discord.reaction.handoff", component: "triggers", provider: "discord" },
        {
          scrubValues: [options.token],
          diagnostic: {
            channelId: partialReaction.message.channelId,
            messageId: partialReaction.message.id,
          },
        },
      );
    });
  });
  client.on("interactionCreate", (interaction) => {
    if (!interaction.isButton() || interaction.guildId === null) return;
    const handler = buttonClickHandler;
    if (handler === undefined) return;
    void (async () => {
      // Discord voids the interaction unless it is answered within three seconds.
      await interaction.deferUpdate();
      const channel = interaction.channel;
      const isThread =
        channel !== null && typeof channel.isThread === "function" && channel.isThread();
      const result = await handler({
        customId: interaction.customId,
        guildId: DiscordSnowflakeSchema.parse(interaction.guildId),
        channelId: DiscordSnowflakeSchema.parse(interaction.channelId),
        parentChannelId: isThread ? (channel.parentId ?? null) : null,
        threadId: isThread ? interaction.channelId : null,
        messageId: DiscordSnowflakeSchema.parse(interaction.message.id),
        user: {
          id: interaction.user.id,
          username: interaction.user.username,
          bot: interaction.user.bot,
        },
      });
      if (result.resolved !== undefined) {
        await interaction.editReply({
          components: [
            {
              type: ComponentType.ActionRow,
              components: [
                {
                  type: ComponentType.Button,
                  style: ButtonStyle.Secondary,
                  label: result.resolved.slice(0, 80),
                  customId: interaction.customId,
                  disabled: true,
                },
              ],
            },
          ],
        });
      }
      if (result.notice !== undefined) {
        await interaction.followUp({ content: result.notice, ephemeral: true });
      }
    })().catch((error: unknown) => {
      reportFailure(
        error,
        { operation: "discord.button.handoff", component: "triggers", provider: "discord" },
        {
          scrubValues: [options.token],
          diagnostic: { channelId: interaction.channelId, messageId: interaction.message.id },
        },
      );
    });
  });
  client.on("guildDelete", (guild) => {
    const guildId = DiscordSnowflakeSchema.parse(guild.id);
    void Promise.all(
      Array.from(guildDeleteHandlers, (handler) =>
        handler({ id: guildId, unavailable: !guild.available }),
      ),
    ).catch((error: unknown) =>
      reportFailure(
        error,
        { operation: "discord.guild-delete.handoff", component: "triggers", provider: "discord" },
        { scrubValues: [options.token], diagnostic: { guildId } },
      ),
    );
  });

  return {
    async start() {
      if (started) {
        return;
      }
      let gatewayCloseCode: number | undefined;
      const observeGatewayClose = (event: { code: number }) => {
        gatewayCloseCode = event.code;
      };
      client.on("shardDisconnect", observeGatewayClose);
      try {
        await client.login(options.token);
        started = true;
      } catch (error) {
        const classified =
          gatewayCloseCode === undefined ? undefined : discordGatewayError(gatewayCloseCode, error);
        throw classified ?? error;
      } finally {
        client.off("shardDisconnect", observeGatewayClose);
      }
    },
    async stop() {
      if (!started) {
        return;
      }
      await client.destroy();
      started = false;
    },
    getSelfUserId() {
      const id = options.clientId ?? client.user?.id;
      if (id === undefined) {
        throw new Error("discord bot client has not received a self user yet");
      }
      return DiscordSnowflakeSchema.parse(id);
    },
    async createReaction(input) {
      await ignoreDeletedMessage(async () => {
        const message = await fetchMessage(
          client,
          DiscordSnowflakeSchema.parse(input.channelId),
          DiscordSnowflakeSchema.parse(input.messageId),
        );
        await message.react(input.emoji);
      });
    },
    async deleteOwnReaction(input) {
      const channelId = DiscordSnowflakeSchema.parse(input.channelId);
      const messageId = DiscordSnowflakeSchema.parse(input.messageId);
      await ignoreDeletedMessage(async () => {
        await client.rest.delete(
          Routes.channelMessageOwnReaction(channelId, messageId, input.emoji),
        );
      });
    },
    async sendChannelMessage(input) {
      const channelId = DiscordSnowflakeSchema.parse(input.threadId ?? input.channelId);
      const channel = await client.channels.fetch(channelId);
      if (channel === null || !isSendableChannel(channel)) {
        throw new Error(`discord channel not sendable: ${channelId}`);
      }
      await channel.send({ content: input.content, allowedMentions: { parse: [] } });
    },
    async sendConversationReply(input) {
      const channel =
        input.threadId === undefined || input.threadId === null
          ? await resolveReplyDestination(client, input, pendingReplyDestinations)
          : await fetchSendableChannel(client, input.threadId);
      const sent = await channel.send({
        content: input.content,
        allowedMentions: { parse: [] },
        ...(input.files === undefined || input.files.length === 0
          ? {}
          : { files: input.files.map((file) => ({ attachment: file.bytes, name: file.name })) }),
        ...(input.buttons === undefined || input.buttons.length === 0
          ? {}
          : { components: [buttonRow(input.buttons)] }),
      });
      return sentMessage(sent);
    },
    async readMessage(input) {
      const message = await fetchMessage(
        client,
        DiscordSnowflakeSchema.parse(input.channelId),
        DiscordSnowflakeSchema.parse(input.messageId),
      );
      return normalizeContextMessage(message);
    },
    async readThreadMessages(input) {
      const channelId = DiscordSnowflakeSchema.parse(input.channelId);
      const beforeMessageId = DiscordSnowflakeSchema.parse(input.beforeMessageId);
      const channel = await client.channels.fetch(channelId);
      if (channel === null || !isThreadChannel(channel)) {
        throw new Error(`discord channel is not a readable thread: ${input.channelId}`);
      }
      const [starter, page] = await Promise.all([
        channel.fetchStarterMessage(),
        channel.messages.fetch({ before: beforeMessageId, limit: DISCORD_THREAD_CONTEXT_LIMIT }),
      ]);
      if (starter === null) throw new Error("Discord thread starter unavailable");
      const replies = Array.from(page.values())
        .filter((message) => message.id !== beforeMessageId && message.id !== starter.id)
        .map(normalizeContextMessage)
        .sort(compareThreadMessages)
        .slice(-(DISCORD_THREAD_CONTEXT_LIMIT - 1));
      return [normalizeContextMessage(starter), ...replies];
    },
    onMessageCreate(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    onReactionAdd(handler) {
      reactionHandlers.add(handler);
      return () => {
        reactionHandlers.delete(handler);
      };
    },
    onGuildDelete(handler) {
      guildDeleteHandlers.add(handler);
      return () => guildDeleteHandlers.delete(handler);
    },
    onButtonClick(handler) {
      buttonClickHandler = handler;
      return () => {
        if (buttonClickHandler === handler) buttonClickHandler = undefined;
      };
    },
  };
}

const BUTTON_STYLES = {
  primary: ButtonStyle.Primary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
} as const;

function buttonRow(buttons: readonly DiscordButton[]) {
  return {
    type: ComponentType.ActionRow as const,
    components: buttons.map((button) => ({
      type: ComponentType.Button as const,
      style: BUTTON_STYLES[button.style ?? "primary"],
      label: button.label,
      customId: button.customId,
    })),
  };
}

function sentMessage(sent: unknown): DiscordSentMessage | undefined {
  if (typeof sent !== "object" || sent === null) return undefined;
  const messageId: unknown = Reflect.get(sent, "id");
  const channelId: unknown = Reflect.get(sent, "channelId");
  return typeof messageId === "string" && typeof channelId === "string"
    ? { channelId, messageId }
    : undefined;
}

async function ignoreDeletedMessage(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage) {
      return;
    }
    throw error;
  }
}

async function resolveReplyDestination(
  client: Client,
  input: DiscordConversationReplyInput,
  pending: Map<string, Promise<DiscordSendableChannel>>,
): Promise<DiscordSendableChannel> {
  const channelId = DiscordSnowflakeSchema.parse(input.channelId);
  const messageId = DiscordSnowflakeSchema.parse(input.messageId);
  const key = `${channelId}:${messageId}`;
  const existing = pending.get(key);
  if (existing !== undefined) return existing;

  const resolution = (async () => {
    const message = await fetchMessage(client, channelId, messageId);
    const thread = message.hasThread
      ? await fetchSendableChannel(client, messageId)
      : await message.startThread({
          name: threadName(input.threadTitle) ?? createThreadName(message.content),
        });
    if (!isSendableChannel(thread)) throw new Error(`discord channel not sendable: ${thread.id}`);
    return thread;
  })();
  pending.set(key, resolution);
  try {
    return await resolution;
  } finally {
    pending.delete(key);
  }
}

async function fetchSendableChannel(
  client: Client,
  channelId: string,
): Promise<DiscordSendableChannel> {
  const parsedChannelId = DiscordSnowflakeSchema.parse(channelId);
  const channel = await client.channels.fetch(parsedChannelId);
  if (channel === null || !isSendableChannel(channel)) {
    throw new Error(`discord channel not sendable: ${parsedChannelId}`);
  }
  return channel;
}

async function fetchMessage(
  client: Client,
  channelId: string,
  messageId: string,
): Promise<Message> {
  const channel = await client.channels.fetch(channelId);
  if (channel === null || !isTextChannel(channel)) {
    throw new Error(`discord channel not readable: ${channelId}`);
  }
  return channel.messages.fetch(messageId);
}

function isTextChannel(channel: GuildBasedChannel | TextBasedChannel): channel is TextBasedChannel {
  return "messages" in channel;
}

function isThreadChannel(
  channel: GuildBasedChannel | TextBasedChannel,
): channel is DiscordReadableThread {
  return (
    isTextChannel(channel) &&
    typeof channel.isThread === "function" &&
    channel.isThread() &&
    typeof Reflect.get(channel, "fetchStarterMessage") === "function"
  );
}

function isSendableChannel(
  channel: GuildBasedChannel | TextBasedChannel,
): channel is DiscordSendableChannel {
  return "send" in channel && typeof Reflect.get(channel, "send") === "function";
}

function threadName(title: string | undefined): string | undefined {
  const name = title
    ?.replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, DISCORD_THREAD_NAME_MAX_LENGTH)
    .trim();
  return name === undefined || name.length === 0 ? undefined : name;
}

function createThreadName(content: string): string {
  const name = content
    .replaceAll(/<@!?\d+>/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, 50)
    .trim();

  return name.length === 0 ? "paseo response" : name;
}

function normalizeContextMessage(message: Message): NormalizedDiscordContextMessage {
  return NormalizedDiscordContextMessageSchema.parse({
    id: message.id,
    channelId: message.channelId,
    content: message.content,
    author: {
      id: message.author.id,
      username: message.author.username,
      bot: message.author.bot,
    },
    createdAt: message.createdAt.toISOString(),
    attachments: Array.from(message.attachments.values(), (attachment) => ({
      id: attachment.id,
      filename: attachment.name,
      url: attachment.url,
      contentType: attachment.contentType,
      size: attachment.size,
    })),
    referencedMessage:
      message.reference === null || message.reference.messageId === undefined
        ? null
        : {
            id: message.reference.messageId,
            channelId: message.reference.channelId,
            guildId: message.reference.guildId ?? null,
          },
  });
}

function compareThreadMessages(
  left: NormalizedDiscordContextMessage,
  right: NormalizedDiscordContextMessage,
): number {
  const createdAtDifference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return createdAtDifference === 0
    ? left.id.localeCompare(right.id, undefined, { numeric: true })
    : createdAtDifference;
}
