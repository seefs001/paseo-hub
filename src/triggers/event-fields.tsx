/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- event controls bind their own configuration */
import { useServerFn } from "@tanstack/react-start";
import { useMemo } from "react";

import { MultiCombobox, type ComboboxOption } from "../components/app/combobox.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { FormField } from "../components/app/form-field.js";
import { useSnapshotQuery } from "../queries/index.js";
import { eventDefinition, type QualifierKey } from "./configuration/events.js";
import type { TriggerFieldErrors, TriggerFormValue } from "./configuration/editor.js";
import type { DiscordChannelSummary } from "../providers/discord/client.js";
import { discordChannels } from "./functions.js";
import { ScheduleFields } from "./schedule/fields.js";

const EVERY_CHANNEL: readonly string[] = [];

/** Source-specific controls live behind the event form boundary. */
export function EventFields({
  organizationSlug,
  value,
  errors,
  onChange,
}: {
  organizationSlug: string;
  value: TriggerFormValue;
  errors: TriggerFieldErrors;
  onChange: (value: TriggerFormValue) => void;
}) {
  const updateQualifier = (key: QualifierKey, next: string) =>
    onChange({ ...value, qualifiers: { ...value.qualifiers, [key]: next } });
  return (
    <>
      <ScheduleFields
        event={value.event}
        value={value.recurrence}
        error={errors.recurrence}
        onChange={(recurrence) => onChange({ ...value, recurrence })}
      />
      {value.event === "discord.mention" ? (
        <DiscordChannelField
          organizationSlug={organizationSlug}
          connection={value.connection}
          channels={value.channels ?? EVERY_CHANNEL}
          onChange={(channels) => {
            const { channels: _previous, ...rest } = value;
            onChange(channels.length === 0 ? rest : { ...rest, channels });
          }}
        />
      ) : null}
      {eventDefinition(value.event).qualifiers.map((qualifier) => {
        const error = errors[`qualifiers.${qualifier.key}`];
        return (
          <FormField
            key={qualifier.key}
            id={`trigger-qualifier-${qualifier.key}`}
            name={qualifier.key}
            label={qualifier.label}
            description={qualifier.description}
            kind="text"
            value={value.qualifiers[qualifier.key] ?? ""}
            onChange={(next) => updateQualifier(qualifier.key, next)}
            required={qualifier.required}
            {...(error === undefined ? {} : { error })}
          />
        );
      })}
    </>
  );
}

/** A channel reads as Discord shows it, under its category, and is found by name, category, or ID. */
function channelOption(channel: DiscordChannelSummary): ComboboxOption {
  const option: ComboboxOption = {
    value: channel.id,
    label: `#${channel.name}`,
    keywords: [channel.name, channel.id],
  };
  if (channel.category !== null) {
    option.detail = channel.category;
    option.keywords = [channel.name, channel.id, channel.category];
  }
  return option;
}

/** The channels a Discord mention must arrive in, picked by name from the connected server. */
function DiscordChannelField({
  organizationSlug,
  connection,
  channels,
  onChange,
}: {
  organizationSlug: string;
  connection: string;
  channels: readonly string[];
  onChange: (channels: string[]) => void;
}) {
  const load = useServerFn(discordChannels);
  const query = useSnapshotQuery({
    queryKey: ["discord-channels", organizationSlug, connection],
    enabled: connection !== "",
    queryFn: () => load({ data: { organizationSlug, connectionSlug: connection } }),
  });
  const options = useMemo(() => (query.data ?? []).map(channelOption), [query.data]);
  return (
    <>
      <FormField
        id="trigger-discord-channels"
        label="Channels"
        description="Only mentions in these channels, or in threads under them, start a run. Leave empty to listen in every channel."
      >
        {(control) => (
          <MultiCombobox
            {...control}
            values={channels}
            options={options}
            placeholder={connection === "" ? "Select a connection first" : "Every channel"}
            searchPlaceholder="Search channels…"
            empty="No channels found."
            loading={connection !== "" && query.status === "pending"}
            disabled={connection === ""}
            onChange={onChange}
          />
        )}
      </FormField>
      {query.status === "error" ? (
        <FailureAlert
          title="Channels unavailable"
          error={query.error}
          fallback="Hub couldn't load this Discord server's channels."
          onRetry={query.refetch}
        />
      ) : null}
    </>
  );
}
