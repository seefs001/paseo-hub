import type { Message } from "discord.js";
import type { z } from "zod";
import type { DiscordMessageAttachmentSchema } from "./events.js";

type Attachment = z.infer<typeof DiscordMessageAttachmentSchema>;

/** Discord stores native stickers separately from uploaded message attachments. */
export function normalizeDiscordAttachments(
  message: Pick<Message, "attachments" | "stickers">,
): Attachment[] {
  const files: Attachment[] = Array.from(message.attachments.values(), (file) => ({
    id: file.id,
    filename: file.name,
    url: file.url,
    contentType: file.contentType,
    size: file.size,
  }));
  for (const sticker of message.stickers?.values() ?? []) {
    const format = stickerFormat(sticker.format);
    if (format === undefined) continue;
    files.push({
      id: sticker.id,
      filename: `sticker-${sticker.id}.${format.extension}`,
      url: `https://cdn.discordapp.com/stickers/${sticker.id}.${format.extension}`,
      contentType: format.contentType,
      size: null,
    });
  }
  return files;
}

function stickerFormat(format: number): { extension: string; contentType: string } | undefined {
  switch (format) {
    case 1:
    case 2:
      return { extension: "png", contentType: "image/png" };
    case 3:
      return { extension: "json", contentType: "application/json" };
    case 4:
      return { extension: "gif", contentType: "image/gif" };
    default:
      return undefined;
  }
}
