import { z } from "zod";
import type { OutputExecutor, OutputFile } from "../../execution-capabilities/outputs.js";
import type { LinearApiClient } from "../../providers/linear/client.js";

const LinearReplyArgsSchema = z.object({ content: z.string().min(1) });
const LinearReplyOutputContextSchema = z.object({
  provider: z.literal("linear"),
  linearOrganizationId: z.string().min(1),
  issueId: z.string().min(1),
});

/** Emits a normal Linear issue comment, suitable for a concise eligibility result or draft PR URL. */
export function createLinearReplyExecutor(options: { client: LinearApiClient }): OutputExecutor {
  return async function executeLinearReply(input) {
    const args = LinearReplyArgsSchema.parse(input.args);
    const context = LinearReplyOutputContextSchema.parse(input.outputContext);
    const links: string[] = [];
    for (const file of input.files ?? []) {
      if (options.client.uploadFile === undefined) {
        throw new Error("Linear client cannot upload files");
      }
      const assetUrl = await options.client.uploadFile({
        linearOrganizationId: context.linearOrganizationId,
        name: file.name,
        mimeType: file.mimeType,
        bytes: file.bytes,
      });
      links.push(markdownLink(file, assetUrl));
    }
    await options.client.createComment({
      linearOrganizationId: context.linearOrganizationId,
      issueId: context.issueId,
      body: links.length === 0 ? args.content : `${args.content}\n\n${links.join("\n")}`,
    });
  };
}

function markdownLink(file: OutputFile, url: string): string {
  const label = file.name.replace(/[[\]\\]/gu, "\\$&");
  return file.mimeType.startsWith("image/") ? `![${label}](${url})` : `[${label}](${url})`;
}
