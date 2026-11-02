import type { AuthServer } from "../../auth/server.js";
import type { Database } from "../../db/types.js";
import { resolveRouteTenant } from "../../projects/access.js";
import type { DiscordChannelSummary } from "../../providers/discord/client.js";

/** The channels of one of an organization's Discord connections, for the trigger form. */
export class DiscordChannelCatalog {
  constructor(
    private readonly database: Database,
    private readonly auth: AuthServer,
    private readonly listChannels: (guildId: string) => Promise<DiscordChannelSummary[]>,
  ) {}

  async read(
    request: Request,
    input: { organizationSlug: string; connectionSlug: string },
  ): Promise<DiscordChannelSummary[]> {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug: input.organizationSlug,
    });
    const usage = await this.database.organizationConnectionUsage(tenant.organization.id);
    const connection = usage.discord.find(({ slug }) => slug === input.connectionSlug);
    if (connection === undefined) throw new Error("discord_connection_unavailable");
    return this.listChannels(connection.guildId);
  }
}
