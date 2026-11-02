import type { ProjectConfigurationStore } from "../../configuration/store.js";
import type {
  AttachmentCapabilityRegistry,
  AttachmentDescriptor,
} from "../../attachments/capabilities.js";
import type { Database, TelegramMessageRecord } from "../../db/types.js";
import { reportFailure } from "../../failures/index.js";
import { agentFailureNotice, missingBillingUrl } from "../failure-notice.js";
import type { TriggerProvider, TriggerProviderMatch } from "../index.js";
import { matchesInputFilters, parseInvocation } from "../invocation.js";
import type { TelegramBotApi } from "./api.js";
import {
  NormalizedTelegramEventSchema,
  telegramConversationKey,
  type NormalizedTelegramEvent,
  type TelegramAttachment,
} from "./events.js";
import {
  matchTelegramTriggers,
  readTelegramInvocationMessage,
  telegramEventActor,
  telegramEventHasTrigger,
} from "./match.js";

const TRANSCRIPT_LIMIT = 50;

export const TELEGRAM_EVENT_SOURCES = [
  "telegram.mention",
  "telegram.thread_message",
  "telegram.reaction_added",
  "telegram.choice_selected",
] as const;

/**
 * Run status on the trigger message. A bot sets one reaction per message, so each phase replaces
 * the last; Telegram's fixed reaction set has no hourglass or check mark.
 */
const STATUS_REACTIONS = {
  accepted: "👀",
  started: "✍",
  succeeded: "👌",
  failed: "👎",
} as const;

export interface TelegramOutputContext {
  provider: "telegram";
  connectionId: string | null;
  chatId: string;
  topicId: number | null;
  messageId: number;
  conversationId: string;
}

export interface TelegramMergeMessage {
  id: number;
  text: string;
  author: { id: string; username: string; bot: boolean };
  created_at: string;
  reply_to_message_id: number | null;
}

export interface TelegramMergeData {
  telegram: {
    event_type: NormalizedTelegramEvent["type"];
    connection_id: string | null;
    chat: { id: string; type: string; title: string };
    topic_id: number | null;
    reaction?: { emoji: string; user: { id: string; username: string } };
    choice?: {
      label: string;
      index: number;
      question_message: { id: number };
      user: { id: string; username: string };
    };
    trigger_message: TelegramMergeMessage & {
      body: string;
      attachments: Omit<TelegramAttachment, "fileId">[];
    };
  };
}

export interface TelegramTriggerContext {
  provider: "telegram";
  organizationId: string;
  target: TelegramOutputContext;
  event: TelegramMergeData;
}

export interface TelegramMaterializedMessage extends TelegramMergeMessage {
  attachments: AttachmentDescriptor[];
}

export interface TelegramMaterializedContext {
  telegram: {
    reply_to_message: TelegramMaterializedMessage | null;
    conversation: { messages: TelegramMaterializedMessage[] };
    trigger_attachments: AttachmentDescriptor[];
  };
}

export function createTelegramTriggerProvider(options: {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  api: TelegramBotApi;
  database: Pick<Database, "findTelegramMessage" | "listTelegramConversation">;
  attachments?: AttachmentCapabilityRegistry;
  billingUrlForOrganization?: (organizationId: string) => Promise<string>;
  /** Whether a project already has an agent conversation under this continuation key. */
  hasConversation?: (projectId: string, conversationKey: string) => Promise<boolean>;
}): TriggerProvider<
  "telegram",
  TelegramTriggerContext,
  TelegramOutputContext,
  TelegramMaterializedContext
> {
  const setStatus = async (target: TelegramOutputContext, emoji: string | null) => {
    try {
      await options.api.setMessageReaction({
        chatId: target.chatId,
        messageId: target.messageId,
        emoji,
      });
    } catch (error) {
      // Groups can restrict reactions; status is a courtesy, not part of the run.
      reportFailure(
        error,
        { operation: "telegram.reaction.set", component: "triggers", provider: "telegram" },
        { diagnostic: { chatId: target.chatId, messageId: target.messageId } },
      );
    }
  };
  const notice = (target: TelegramOutputContext, text: string) =>
    options.api.sendMessage(
      { chatId: target.chatId, topicId: target.topicId, replyToMessageId: target.messageId },
      text,
    );

  return {
    name: "telegram",
    eventNames: TELEGRAM_EVENT_SOURCES,
    async match(externalTrigger) {
      const event = NormalizedTelegramEventSchema.parse(externalTrigger.payload);
      if (event.choice !== undefined && event.choice.projectId !== externalTrigger.projectId) {
        return "trigger_filters_rejected";
      }
      const stored = await options
        .configurationStoreForProject(externalTrigger.projectId)
        .getRevision(externalTrigger.configurationRevisionId);
      if (stored === undefined) return "configuration_unavailable";
      if (!telegramEventHasTrigger(stored.configuration, event)) return "no_trigger_for_source";
      const conversationKey =
        event.choice?.conversationKey ??
        telegramConversationKey(event.chatId, event.conversationId);
      // An unaddressed message only continues: where this project has no conversation there,
      // nobody asked for a run.
      if (
        event.type === "thread_message" &&
        (options.hasConversation === undefined ||
          !(await options.hasConversation(externalTrigger.projectId, conversationKey)))
      ) {
        return "trigger_filters_rejected";
      }
      const outputContext: TelegramOutputContext = {
        provider: "telegram",
        connectionId: externalTrigger.connectionId ?? null,
        chatId: event.chatId,
        topicId: event.topicId,
        messageId: event.messageId,
        conversationId: event.conversationId,
      };
      const triggerContext: TelegramTriggerContext = {
        provider: "telegram",
        organizationId: externalTrigger.organizationId,
        target: outputContext,
        event: buildTelegramMergeData(event, externalTrigger.connectionId ?? null),
      };
      const matches = invocationMatches(stored, event, externalTrigger.connectionId, {
        triggerContext,
        outputContext,
        conversation: { key: conversationKey, label: "Telegram conversation" },
      });
      if (matches.length === 0) return "trigger_filters_rejected";
      // One conversation per project: a continuation is one run.
      return event.type === "thread_message" || event.type === "choice"
        ? matches.slice(0, 1)
        : matches;
    },
    async materializeContext(launch) {
      const target = launch.triggerContext.target;
      const register = (attachments: readonly TelegramAttachment[], sourceId: string) =>
        registerAttachments(
          attachments,
          sourceId,
          launch,
          target.connectionId,
          options.attachments,
        );
      const transcript = await options.database.listTelegramConversation({
        chatId: target.chatId,
        conversationId: target.conversationId,
        beforeMessageId: target.messageId,
        limit: TRANSCRIPT_LIMIT,
      });
      const messages = await Promise.all(
        transcript.map((message) => materializeMessage(message, register)),
      );
      const replyToId = launch.triggerContext.event.telegram.trigger_message.reply_to_message_id;
      const replyTo =
        replyToId === null
          ? undefined
          : (transcript.find((message) => message.messageId === replyToId) ??
            (await options.database.findTelegramMessage(target.chatId, replyToId)));
      const trigger = await options.database.findTelegramMessage(target.chatId, target.messageId);
      return {
        telegram: {
          reply_to_message:
            replyTo === undefined ? null : await materializeMessage(replyTo, register),
          conversation: { messages },
          trigger_attachments:
            trigger === undefined
              ? []
              : await register(trigger.attachments, String(trigger.messageId)),
        },
      };
    },
    async onDispatchAccepted(triggerContext) {
      await setStatus(triggerContext.target, STATUS_REACTIONS.accepted);
      return { phase: "accepted" };
    },
    async onAgentExecutionStarted(triggerContext) {
      await setStatus(triggerContext.target, STATUS_REACTIONS.started);
      return { phase: "started" };
    },
    async onAgentExecutionCompleted(triggerContext) {
      await setStatus(triggerContext.target, STATUS_REACTIONS.succeeded);
      return null;
    },
    async onAgentExecutionFailed(triggerContext, _outputContext, reason) {
      await setStatus(triggerContext.target, STATUS_REACTIONS.failed);
      await notice(
        triggerContext.target,
        await agentFailureNotice(
          reason,
          triggerContext.organizationId,
          options.billingUrlForOrganization ?? missingBillingUrl,
        ),
      );
      return null;
    },
    async onMachineTerminated(triggerContext, reason, reactionState) {
      if (reason !== "launch_failed" && reason !== "daemon_disconnected") return reactionState;
      await setStatus(triggerContext.target, STATUS_REACTIONS.failed);
      await notice(
        triggerContext.target,
        `Paseo machine terminated before the agent could complete: ${reason}`,
      );
      return null;
    },
  };
}

/** Each trigger the event passes, with the inputs its message parses to. */
function invocationMatches(
  stored: NonNullable<Awaited<ReturnType<ProjectConfigurationStore["getRevision"]>>>,
  event: NormalizedTelegramEvent,
  connectionId: string | null | undefined,
  shared: Pick<
    TriggerProviderMatch<TelegramTriggerContext, TelegramOutputContext>,
    "triggerContext" | "outputContext"
  > & { conversation: { key: string; label: string } },
): TriggerProviderMatch<TelegramTriggerContext, TelegramOutputContext>[] {
  const matches: TriggerProviderMatch<TelegramTriggerContext, TelegramOutputContext>[] = [];
  for (const trigger of matchTelegramTriggers(stored.configuration, event, connectionId)) {
    const compiled = stored.configuration.triggers.find(
      (candidate) => candidate.name === trigger.name,
    );
    if (compiled === undefined) throw new Error(`compiled trigger not found: ${trigger.name}`);
    const invocation = parseInvocation(
      event.body,
      compiled.inputs,
      undefined,
      readTelegramInvocationMessage(event, compiled.filters),
    );
    if (
      invocation.status === "accepted" &&
      !matchesInputFilters(invocation.inputs, compiled.filters?.inputs)
    ) {
      continue;
    }
    const base = {
      ...shared,
      triggerName: trigger.name,
      configurationRevisionId: stored.revision.id,
      hubConfig: stored.configuration,
    };
    matches.push(
      invocation.status === "accepted" ? { ...base, invocation } : { ...base, invocation },
    );
  }
  return matches;
}

function buildTelegramMergeData(
  event: NormalizedTelegramEvent,
  connectionId: string | null,
): TelegramMergeData {
  const actor = telegramEventActor(event);
  return {
    telegram: {
      event_type: event.type,
      connection_id: connectionId,
      chat: { id: event.chatId, type: event.chatType, title: event.chatTitle },
      topic_id: event.topicId,
      ...(event.reaction === undefined
        ? {}
        : {
            reaction: {
              emoji: event.reaction.emoji,
              user: { id: actor.id, username: actor.username },
            },
          }),
      ...(event.choice === undefined
        ? {}
        : {
            choice: {
              label: event.choice.label,
              index: event.choice.index,
              question_message: { id: event.messageId },
              user: event.choice.user,
            },
          }),
      trigger_message: {
        id: event.messageId,
        text: event.text,
        body: event.body,
        author: event.author,
        created_at: event.createdAt,
        reply_to_message_id: event.replyToMessageId,
        attachments: event.attachments.map(({ fileId: _fileId, ...attachment }) => attachment),
      },
    },
  };
}

async function materializeMessage(
  message: TelegramMessageRecord,
  register: (
    attachments: readonly TelegramAttachment[],
    sourceId: string,
  ) => Promise<AttachmentDescriptor[]>,
): Promise<TelegramMaterializedMessage> {
  return {
    id: message.messageId,
    text: message.text,
    author: { id: message.authorId, username: message.authorUsername, bot: message.fromBot },
    created_at: message.createdAt.toISOString(),
    reply_to_message_id: message.replyToMessageId,
    attachments: await register(message.attachments, String(message.messageId)),
  };
}

async function registerAttachments(
  source: readonly TelegramAttachment[],
  messageId: string,
  launch: { providerEventReceiptId: string; organizationId: string; executionId: string },
  connectionId: string | null,
  attachments: AttachmentCapabilityRegistry | undefined,
): Promise<AttachmentDescriptor[]> {
  if (source.length === 0) return [];
  if (attachments === undefined) throw new Error("attachment capability unavailable");
  if (connectionId === null) throw new Error("attachment ownership unavailable");
  const references = await Promise.all(
    source.map((file) =>
      attachments.register({
        providerEventReceiptId: launch.providerEventReceiptId,
        organizationId: launch.organizationId,
        connectionId,
        provider: "telegram",
        sourceId: `${messageId}:${file.fileUniqueId}`,
        locator: { fileId: file.fileId },
        filename: file.filename,
        contentType: file.contentType,
        byteSize: file.size,
      }),
    ),
  );
  return references.map((reference) => attachments.materialize(reference, launch.executionId));
}
