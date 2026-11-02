import { createHmac } from "node:crypto";
import type { AuthServer } from "../../auth/server.js";
import {
  CONNECTION_ATTEMPT_LIFETIME_MINUTES,
  connectionAccess,
  connectionActionFailure,
  manageConnectionAccess,
  newConnectionState,
  requiredConnectionId,
  stateHash,
} from "../../connections/shared.js";
import { createConversationChoices } from "../../conversation-choices/index.js";
import { ConnectionAttemptUnavailableError, ConnectionConflictError } from "../../db/errors.js";
import type { Database, TelegramConnectionRecord } from "../../db/types.js";
import {
  outputContextProvider,
  replyWithFilesOutputTool,
} from "../../execution-capabilities/outputs.js";
import { reportFailure } from "../../failures/index.js";
import { organizationBillingUrl } from "../../triggers/failure-notice.js";
import {
  createTelegramBotApi,
  type TelegramBotApi,
  type TelegramUser,
} from "../../triggers/telegram/api.js";
import { createTelegramAttachmentResolver } from "../../triggers/telegram/attachments.js";
import { createTelegramTriggerProvider } from "../../triggers/telegram/provider.js";
import { createTelegramReplyExecutor } from "../../triggers/telegram/reply.js";
import {
  chatTitle,
  createTelegramSource,
  type TelegramTransport,
} from "../../triggers/telegram/source.js";
import type { ProviderConnectionRegistration, ProviderRegistration } from "../registration.js";

export interface TelegramRegistrationConfiguration {
  botToken: string;
}

export interface CreateTelegramRegistrationOptions {
  database: Database | null;
  auth: AuthServer | null;
  applicationBaseUrl: string;
  publicBaseUrl?: string;
  configuration?: TelegramRegistrationConfiguration | null;
  api?: TelegramBotApi;
  fetch?: typeof fetch;
  configurationVersion?: number;
}

/** Telegram delivers webhooks only over HTTPS to these ports. */
const WEBHOOK_PORTS = new Set(["", "443", "88", "8443"]);

export function createTelegramRegistration(
  options: CreateTelegramRegistrationOptions,
): ProviderRegistration {
  const configuration = options.configuration ?? null;
  if (configuration === null || options.publicBaseUrl === undefined) {
    return emptyRegistration(false);
  }
  if (options.database === null) return emptyRegistration(true);
  const database = options.database;
  const publicBaseUrl = options.publicBaseUrl;
  const api =
    options.api ??
    createTelegramBotApi({
      token: configuration.botToken,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  let me: Promise<TelegramUser> | undefined;
  const identity = () => {
    me ??= api.getMe().catch((error: unknown) => {
      me = undefined;
      throw error;
    });
    return me;
  };
  const choices = createConversationChoices({ database });
  const source = createTelegramSource({
    api,
    identity,
    transport: telegramTransport(publicBaseUrl, configuration.botToken),
    database,
    choices,
    configurationVersion: options.configurationVersion ?? 0,
    bind: async (state, chat) => {
      const bot = await identity();
      if (chat.type === "channel") return "Hub connects groups and private chats, not channels.";
      try {
        const bound = await database.bindTelegramConnection({
          stateVerifier: stateHash(state),
          providerApplicationId: String(bot.id),
          chatId: String(chat.id),
          chatType: chat.type,
          chatTitle: chatTitle(chat),
        });
        return `Connected this chat to the Paseo Hub organization "${bound.organizationName}" as ${bound.connection.slug}.`;
      } catch (error) {
        if (error instanceof ConnectionAttemptUnavailableError) {
          return "This connection link expired or was already used. Start the connection again from Hub.";
        }
        if (error instanceof ConnectionConflictError) {
          return "This chat is already connected to a Paseo Hub organization.";
        }
        throw error;
      }
    },
  });

  return {
    configurationSnapshot: {
      version: options.configurationVersion ?? 0,
      callbackOrigin: publicBaseUrl,
    },
    connection:
      options.auth === null
        ? connectionStatus(true)
        : createTelegramConnection({
            database,
            auth: options.auth,
            api,
            identity,
            callbackOrigin: publicBaseUrl,
            configurationVersion: options.configurationVersion ?? 0,
            configuration,
          }),
    triggerProviders: [
      ({ configurationStoreForProject, attachments }) =>
        createTelegramTriggerProvider({
          configurationStoreForProject,
          api,
          database,
          ...(attachments === undefined ? {} : { attachments }),
          billingUrlForOrganization: (organizationId) =>
            organizationBillingUrl(database, publicBaseUrl, organizationId),
          hasConversation: async (projectId, conversationKey) =>
            (await database.findAgentSessionByKey(projectId, conversationKey)) !== undefined,
        }),
    ],
    sources: [source],
    outputs: [
      {
        type: "telegram.reply",
        tool: replyWithFilesOutputTool,
        available: outputContextProvider("telegram"),
        choices: true,
        execute: createTelegramReplyExecutor({ api, identity, database, choices }),
      },
    ],
    requests: [{ name: "telegram.events", handle: (request) => source.handleWebhook(request) }],
    attachment: { provider: "telegram", resolve: createTelegramAttachmentResolver(api) },
  };
}

/**
 * Webhooks when Telegram can reach this Hub, long polling otherwise, such as a local Hub. The
 * webhook secret is derived from the bot token: whoever holds the token controls the bot anyway.
 */
export function telegramTransport(publicBaseUrl: string, botToken: string): TelegramTransport {
  const url = new URL(publicBaseUrl);
  if (url.protocol !== "https:" || !WEBHOOK_PORTS.has(url.port)) return { kind: "polling" };
  return {
    kind: "webhook",
    url: new URL("/api/integrations/telegram/events", url).toString(),
    secretToken: createHmac("sha256", botToken)
      .update("paseo-hub/telegram-webhook/v1")
      .digest("base64url"),
  };
}

function createTelegramConnection(options: {
  database: Database;
  auth: AuthServer;
  api: TelegramBotApi;
  identity: () => Promise<TelegramUser>;
  callbackOrigin: string;
  configurationVersion: number;
  configuration: TelegramRegistrationConfiguration;
}): ProviderConnectionRegistration {
  const start = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      const bot = await options.identity();
      if (bot.username === undefined) throw new Error("Telegram bot has no username");
      const state = newConnectionState();
      await options.database.startConnectionAttempt({
        provider: "telegram",
        stateVerifier: stateHash(state),
        access: connectionAccess(access),
        lifetimeMinutes: CONNECTION_ATTEMPT_LIFETIME_MINUTES,
        callbackOrigin: options.callbackOrigin,
        configurationVersion: options.configurationVersion,
        providerApplicationId: String(bot.id),
        configurationSnapshot: { provider: "telegram", ...options.configuration },
        expectedConfigurationVersion: null,
        activateConfiguration: false,
      });
      // Telegram asks the person to pick a group and delivers `/start@bot <state>` there.
      return Response.json({ url: `https://t.me/${bot.username}?startgroup=${state}` });
    } catch (error) {
      return connectionActionFailure(error, "telegram", "start");
    }
  };

  const disconnect = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      const disconnected = await options.database.disconnectConnection(
        "telegram",
        requiredConnectionId(request),
        connectionAccess(access),
      );
      if (disconnected.provider === "telegram" && disconnected.chatId !== undefined) {
        void options.api.leaveChat(disconnected.chatId).catch((error: unknown) => {
          reportFailure(
            error,
            {
              operation: "connection.disconnect.cleanup",
              component: "connections",
              provider: "telegram",
            },
            { kind: "internal" },
          );
        });
      }
      return Response.json({ disconnected: true });
    } catch (error) {
      return connectionActionFailure(error, "telegram", "disconnect");
    }
  };

  return {
    name: "telegram",
    status: (connections) => telegramStatus(true, connections.telegram ?? []),
    actions: { start, disconnect },
  };
}

function emptyRegistration(configured: boolean): ProviderRegistration {
  return {
    connection: connectionStatus(configured),
    triggerProviders: [],
    sources: [],
    outputs: [],
    requests: [],
  };
}

function connectionStatus(configured: boolean): ProviderConnectionRegistration {
  return {
    name: "telegram",
    status: (connections) => telegramStatus(configured, connections.telegram ?? []),
    actions: {},
  };
}

function telegramStatus(configured: boolean, bindings: readonly TelegramConnectionRecord[]) {
  if (!configured) return { status: "notConfigured" as const };
  return bindings.length === 0
    ? { status: "disconnected" as const }
    : { status: "connected" as const };
}
