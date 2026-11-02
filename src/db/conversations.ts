import { and, desc, eq, gt, isNull, lt } from "drizzle-orm";
import type { DatabaseRuntime, DrizzleHandle } from "./runtime/index.js";
import * as schema from "./schema.js";
import type {
  ConversationChoiceRecord,
  InsertConversationChoiceInput,
  ResolveConversationChoiceResult,
  TelegramMessageRecord,
} from "./types.js";
import type { JsonValue } from "../config/compiler.js";

/** Telegram transcripts and conversation choices: the state Hub keeps for chat conversations. */
export class ConversationRepository {
  private readonly database: DrizzleHandle;

  constructor(runtime: DatabaseRuntime) {
    this.database = runtime.drizzle();
  }

  async recordTelegramMessages(messages: readonly TelegramMessageRecord[]): Promise<void> {
    if (messages.length === 0) return;
    await this.database
      .insert(schema.telegramMessages)
      .values(messages.map((message) => ({ ...message })))
      .onConflictDoNothing();
  }

  async findTelegramMessage(
    chatId: string,
    messageId: number,
  ): Promise<TelegramMessageRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.telegramMessages)
      .where(
        and(
          eq(schema.telegramMessages.chatId, chatId),
          eq(schema.telegramMessages.messageId, messageId),
        ),
      )
      .limit(1);
    return row === undefined ? undefined : telegramMessage(row);
  }

  async listTelegramConversation(input: {
    chatId: string;
    conversationId: string;
    beforeMessageId: number;
    limit: number;
  }): Promise<TelegramMessageRecord[]> {
    const rows = await this.database
      .select()
      .from(schema.telegramMessages)
      .where(
        and(
          eq(schema.telegramMessages.chatId, input.chatId),
          eq(schema.telegramMessages.conversationId, input.conversationId),
          lt(schema.telegramMessages.messageId, input.beforeMessageId),
        ),
      )
      .orderBy(desc(schema.telegramMessages.messageId))
      .limit(input.limit);
    return rows.map(telegramMessage).toReversed();
  }

  async insertConversationChoice(
    input: InsertConversationChoiceInput,
  ): Promise<ConversationChoiceRecord> {
    const [row] = await this.database
      .insert(schema.conversationChoices)
      .values({ ...input, messageLocator: {} })
      .returning();
    if (row === undefined) throw new Error("conversation choice unavailable");
    return conversationChoice(row);
  }

  async setConversationChoiceMessage(id: string, messageLocator: JsonValue): Promise<void> {
    await this.database
      .update(schema.conversationChoices)
      .set({ messageLocator })
      .where(eq(schema.conversationChoices.id, id));
  }

  async findConversationChoice(id: string): Promise<ConversationChoiceRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.conversationChoices)
      .where(eq(schema.conversationChoices.id, id))
      .limit(1);
    return row === undefined ? undefined : conversationChoice(row);
  }

  async resolveConversationChoice(input: {
    id: string;
    index: number;
    userId: string;
    userName: string;
    now: Date;
  }): Promise<ResolveConversationChoiceResult> {
    const [resolved] = await this.database
      .update(schema.conversationChoices)
      .set({
        resolvedIndex: input.index,
        resolvedByUserId: input.userId,
        resolvedByName: input.userName,
        resolvedAt: input.now,
      })
      .where(
        and(
          eq(schema.conversationChoices.id, input.id),
          isNull(schema.conversationChoices.resolvedIndex),
          gt(schema.conversationChoices.expiresAt, input.now),
        ),
      )
      .returning();
    if (resolved !== undefined) return { status: "resolved", choice: conversationChoice(resolved) };
    const existing = await this.findConversationChoice(input.id);
    return existing?.resolvedIndex === null || existing === undefined
      ? { status: "unavailable" }
      : { status: "alreadyResolved", choice: existing };
  }
}

function telegramMessage(row: typeof schema.telegramMessages.$inferSelect): TelegramMessageRecord {
  return {
    connectionId: row.connectionId,
    chatId: row.chatId,
    messageId: row.messageId,
    conversationId: row.conversationId,
    topicId: row.topicId,
    replyToMessageId: row.replyToMessageId,
    authorId: row.authorId,
    authorUsername: row.authorUsername,
    fromBot: row.fromBot,
    text: row.text,
    attachments: row.attachments,
    createdAt: row.createdAt,
  };
}

function conversationChoice(
  row: typeof schema.conversationChoices.$inferSelect,
): ConversationChoiceRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    provider: row.provider,
    connectionId: row.connectionId,
    triggerName: row.triggerName,
    conversationKey: row.conversationKey,
    agentExecutionId: row.agentExecutionId,
    messageLocator: row.messageLocator,
    origin: row.origin,
    options: row.options,
    resolvedIndex: row.resolvedIndex,
    resolvedByUserId: row.resolvedByUserId,
    resolvedByName: row.resolvedByName,
    resolvedAt: row.resolvedAt,
    expiresAt: row.expiresAt,
  };
}
