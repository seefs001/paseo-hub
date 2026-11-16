import { TelegramUpdateSchema, type TelegramUpdate } from "./api.js";

export const TELEGRAM_ALBUM_WINDOW_MS = 1_000;

interface PendingAlbum {
  key: string;
  updates: Map<number, TelegramUpdate>;
  timer: ReturnType<typeof setTimeout>;
  done: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

/** A webhook is acknowledged only after its album has been processed, not just buffered. */
export function createTelegramAlbumCollector(
  consume: (updates: TelegramUpdate[]) => Promise<void>,
) {
  const pending = new Map<string, PendingAlbum>();
  const inFlight = new Set<Promise<void>>();

  const flushAlbum = async (album: PendingAlbum): Promise<void> => {
    clearTimeout(album.timer);
    pending.delete(album.key);
    inFlight.add(album.done);
    try {
      await consume([...album.updates.values()].sort((a, b) => a.update_id - b.update_id));
      album.resolve();
    } catch (error) {
      album.reject(error);
    } finally {
      inFlight.delete(album.done);
    }
  };

  return {
    accept(update: TelegramUpdate): Promise<void> {
      const key = albumKey(update);
      if (key === undefined) return consume([update]);
      const existing = pending.get(key);
      if (existing !== undefined) {
        if (!existing.updates.has(update.update_id)) {
          existing.updates.set(update.update_id, update);
          clearTimeout(existing.timer);
          existing.timer = setTimeout(() => void flushAlbum(existing), TELEGRAM_ALBUM_WINDOW_MS);
        }
        return existing.done;
      }
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const done = new Promise<void>((resolveDone, rejectDone) => {
        resolve = resolveDone;
        reject = rejectDone;
      });
      const album: PendingAlbum = {
        key,
        updates: new Map([[update.update_id, update]]),
        timer: setTimeout(() => void flushAlbum(album), TELEGRAM_ALBUM_WINDOW_MS),
        done,
        resolve,
        reject,
      };
      pending.set(key, album);
      return done;
    },
    async flush(): Promise<void> {
      for (const album of pending.values()) void flushAlbum(album);
      await Promise.all(inFlight);
    },
  };
}

/** Process members of an album concurrently so the polling loop never waits on its first member. */
export function groupTelegramUpdates(updates: readonly unknown[]): unknown[][] {
  const groups = new Map<string, unknown[]>();
  for (const [index, raw] of updates.entries()) {
    const parsed = TelegramUpdateSchema.safeParse(raw);
    const key = (parsed.success ? albumKey(parsed.data) : undefined) ?? `update:${String(index)}`;
    const group = groups.get(key) ?? [];
    group.push(raw);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function hasTelegramAlbum(updates: readonly unknown[]): boolean {
  return updates.some((raw) => {
    const parsed = TelegramUpdateSchema.safeParse(raw);
    return parsed.success && albumKey(parsed.data) !== undefined;
  });
}

function albumKey(update: TelegramUpdate): string | undefined {
  const message = update.message;
  return message?.media_group_id === undefined
    ? undefined
    : JSON.stringify([message.chat.id, message.media_group_id]);
}
