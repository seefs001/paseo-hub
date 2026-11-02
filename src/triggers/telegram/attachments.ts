import { z } from "zod";
import type { AttachmentResolver } from "../../attachments/capabilities.js";
import type { TelegramBotApi } from "./api.js";

const TELEGRAM_ATTACHMENT_TIMEOUT_MS = 30_000;
const LocatorSchema = z.object({ fileId: z.string().min(1) });

/**
 * Telegram file links name the bot token, so Hub resolves the file id at download time instead
 * of storing a link. The Bot API serves files up to 20 MB; larger ones fail here.
 */
export function createTelegramAttachmentResolver(api: TelegramBotApi): AttachmentResolver {
  return async (input) => {
    const locator = LocatorSchema.parse(input.locator);
    const file = await api.getFile(locator.fileId);
    return api.downloadFile(file.filePath, AbortSignal.timeout(TELEGRAM_ATTACHMENT_TIMEOUT_MS));
  };
}
