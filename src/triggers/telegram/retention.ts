import type { QueryHandle } from "../../db/runtime/index.js";
import { reportFailure } from "../../failures/index.js";
import { logger } from "../../logger.js";

const RETENTION_MS = 30 * 24 * 60 * 60_000;
const BATCH_SIZE = 500;
const BATCH_DELAY_MS = 250;
const SWEEP_DELAY_MS = 60 * 60_000;
const RETRY_DELAY_MS = 60_000;

/**
 * Deletes Telegram transcript messages older than 30 days, in bounded batches. A conversation
 * quiet for that long loses its earlier context; a disconnected chat loses all of it at once.
 */
export class TelegramTranscriptRetention {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private stopped = true;

  constructor(private readonly database: QueryHandle) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
  }

  async runBatch(now = new Date()): Promise<number> {
    const result = await this.database.query<{ chat_id: string }>(
      `delete from telegram_messages
       where (chat_id, message_id) in (
         select chat_id, message_id from telegram_messages
         where created_at < $1
         order by created_at
         limit $2
       )
       returning chat_id`,
      [new Date(now.getTime() - RETENTION_MS), BATCH_SIZE],
    );
    return result.rows.length;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.active = this.tick();
    }, delay);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    let delay = RETRY_DELAY_MS;
    try {
      const deleted = await this.runBatch();
      if (deleted > 0) {
        logger.info(
          { operation: "telegram_transcript_retention.cleanup", deleted },
          "telegram transcript retention cleanup",
        );
      }
      delay = deleted === BATCH_SIZE ? BATCH_DELAY_MS : SWEEP_DELAY_MS;
    } catch (error) {
      reportFailure(error, {
        operation: "telegram_transcript_retention.cleanup",
        component: "triggers",
        provider: "telegram",
      });
    }
    this.schedule(delay);
  }
}
