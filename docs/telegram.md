# Telegram integration

Status: design, not implemented. Telegram facts below were checked against the Bot API
documentation at `core.telegram.org/bots/api` and `core.telegram.org/bots/features` on
2026-11-02, except where marked **unverified**.

Telegram joins Slack and Discord as a conversation provider. It reuses the existing
`ProviderRegistration` seam (`src/providers/registration.ts`) and mirrors the Discord provider
(`src/providers/discord/`, `src/triggers/discord/`) wherever Telegram allows it. Cross-provider
interactive replies are specified separately in [conversation-choices.md](conversation-choices.md).

## Scope

In scope for the first release:

- One Telegram bot per Hub instance, configured as a provider application.
- Connecting a group, supergroup, or private chat to an organization.
- Triggers: `telegram.mention`, `telegram.reaction_added`, and thread continuation.
- Event context: the trigger message, its reply target, and the conversation transcript.
- Output: `telegram.reply`, with files.
- Run status as reactions on the trigger message.
- Attachments from the trigger and transcript.

Out of scope: channels, inline mode, guest mode, business accounts, Mini Apps, and any MTProto
(user account) access. Hub never holds a Telegram user's credentials.

## Provider application

The operator creates a bot with @BotFather and saves its token in Hub. The environment form is:

| Variable                  | Required          | Meaning                                |
| ------------------------- | ----------------- | -------------------------------------- |
| `TELEGRAM_BOT_TOKEN`      | yes               | Bot token from @BotFather.             |
| `TELEGRAM_TRANSPORT`      | no                | `webhook` or `polling`. See Transport. |
| `TELEGRAM_WEBHOOK_SECRET` | only for webhooks | Value for `setWebhook` `secret_token`. |

This follows the Slack precedent of `SLACK_TRANSPORT`. The provider-applications guide lists the
@BotFather steps and the group requirements in [Group access](#group-access). Hub calls `getMe` at
startup to learn the bot's id and username.

## Transport

Telegram delivers updates through `getUpdates` or a webhook. The two are mutually exclusive for a
bot.

- **webhook** (default when `PASEO_HUB_APP_URL` is HTTPS): Hub calls `setWebhook` with
  `https://<app>/api/integrations/telegram/events`, a `secret_token`, and an explicit
  `allowed_updates` list. Telegram accepts only ports 443, 80, 88, and 8443. Hub rejects requests
  whose `X-Telegram-Bot-Api-Secret-Token` header does not match, compared case-insensitively by
  header name. The name is confirmed by the `setWebhook` documentation and by
  `tdlib/telegram-bot-api` `WebhookActor.cpp`.
- **polling** (default otherwise, such as local `npx @getpaseo/hub`): Hub calls `deleteWebhook`,
  then long-polls `getUpdates`. Only one consumer may poll a bot. Hub holds a database advisory lock
  for the poller, so a second Hub process stays idle instead of fighting for updates.

`allowed_updates` is always explicit: `message`, `edited_message`, `message_reaction`,
`callback_query`, `my_chat_member`. Telegram omits `message_reaction` unless it is listed.

Each update is accepted through the shared provider-event intake with delivery id
`telegram-<update_id>`, the same way `acceptDiscordEvent` records Discord events.

## Decision 1: connecting a chat

Telegram has no OAuth for bots. Hub binds a chat with a deep link that carries the existing
connection-attempt state.

1. A manager selects **Connect Telegram**. Hub calls `startConnectionAttempt` with
   `newConnectionState()` (43 base64url characters) and returns two links:
   `https://t.me/<bot>?startgroup=<state>` and `https://t.me/<bot>?start=<state>`.
2. The user picks a group, or opens the private chat. Telegram delivers
   `/start@<bot> <state>` in the group, or `/start <state>` in the private chat.
3. Hub hashes the state with `stateHash`, consumes the attempt if it is live, and creates a
   `telegram_connections` row for that chat. The bot answers in the chat with the organization
   name and the connection slug.
4. The connections page polls the attempt and shows the result. There is no browser redirect,
   unlike Discord's OAuth callback.

Telegram's limit for the parameter is 64 characters from `A-Z a-z 0-9 _ -`. The state fits. The
attempt keeps `CONNECTION_ATTEMPT_LIFETIME_MINUTES`, so a leaked link stops working after that
time, as with OAuth state.

`my_chat_member` reports that the bot left or was removed. Hub then removes the connection, as
`applyGuildRemoval` does for Discord. Disconnecting in Hub calls `leaveChat`. A group that Telegram
migrates to a supergroup gets a new chat id; Hub moves the connection to the new id from the
`migrate_to_chat_id` message.

Data: `telegram_connections` (`id`, `organization_id`, `chat_id` unique, `chat_type`,
`chat_title`, `slug`, `provider_application_id`, `connected_by_user_id`, timestamps), shaped like
`discord_connections`. `telegram` is added to `CONNECTION_PROVIDERS`, the provider check
constraints, and a new `telegram_authorization` connection-attempt phase.

## Group access

By default a bot in a group runs in privacy mode. It then receives only commands addressed to it
(`/command@bot`), replies to its own messages, service messages, and a few other cases. Bots
added as administrators receive all messages. `message_reaction` updates also require the bot to be
an administrator.

Administrator status is optional. Hub does not require it, and the connection page shows which
capabilities the chat has. Without it, `/command@bot`, replies to the bot, and private chats work.
With it (no extra rights needed), these also work:

- `telegram.reaction_added`, because Telegram sends `message_reaction` only to administrators;
- plain `@bot` mentions, which are not in the documented privacy-mode list;
- `thread_messages` continuation for unaddressed messages in a forum topic or reply chain.

Turning privacy mode off in @BotFather gives the same message delivery without administrator
status, but not reactions. Whether a privacy-mode bot receives a plain `@bot` mention is
**unverified**; test it with a real bot before the guide is final.

Hub does not process or store messages that are not addressed to the bot and do not continue an
existing conversation. Administrator status widens what Telegram sends; it does not widen what
Hub keeps.

## Decision 2: conversations and history

The Bot API has no method to read chat history. Hub therefore records the messages of each
conversation itself.

### Conversation key

`["telegram", chat_id, topic_id ?? root_message_id]`, used with `src/triggers/continuation.ts`.

- In a forum supergroup, or a private chat with topics, the topic (`message_thread_id`) is the
  conversation.
- Otherwise the conversation is a reply chain. `root_message_id` is the root of the chain: the
  trigger message itself, or the stored root of the message it replies to.
- In a private chat without topics, the whole chat is one conversation. A trigger that wants a
  fresh agent per message uses `continuation: { mode: new }`.

### Transcript store

`telegram_messages`, primary key (`chat_id`, `message_id`), with `connection_id`,
`conversation_root`, `author`, `text`, `attachments`, `reply_to_message_id`, `from_bot`, and
`created_at`.

Hub writes a row only for:

- a message that starts or continues a run;
- a message that replies to a stored message (so the chain stays complete);
- every message the bot itself sends (Telegram does not echo these to the bot).

Rows older than 30 days are deleted by a sweep shaped like `ReceiptRetention`. Disconnecting a
chat deletes its rows.

`materializeContext` returns the stored transcript of the conversation before the trigger
message, plus `reply_to_message` from the update itself. This gives the agent the same shape of
context that Discord gets from `readThreadMessages`. Messages sent while Hub was not part of the
conversation are absent; that is the cost of having no history API.

## Decision 3: trigger events

| Event                     | Fires when                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `telegram.mention`        | `@bot` in text, `/command@bot`, a reply to a bot message outside any conversation, or any message in a connected private chat.                 |
| `telegram.reaction_added` | A user adds one of the trigger's `emojis` to a message. Needs administrator status.                                                            |
| `telegram.thread_message` | Internal source, like `discord.thread_message`. An unaddressed message in an existing conversation, for triggers with `thread_messages: true`. |

Filters reuse the Discord keys where the meaning is the same: `pattern`, `from_users`,
`thread_messages`, `emojis`, `inputs`, and `connectionId`. `channels` holds topic ids; `guild` is
not used. `from_users` matches the Telegram user id or username. Messages from anonymous group
admins carry `sender_chat` instead of a user; they never match `from_users` and are dropped.

`message_reaction` reports old and new reaction lists. The added emoji is the difference.
Reactions set by bots are never delivered.

## Reply and status

`telegram.reply` sends with `sendRichMessage` using Rich Markdown, which follows GitHub Flavored
Markdown, so agent output needs no MarkdownV2 escaping. The reply targets the trigger message
through `reply_parameters` and keeps `message_thread_id`. Rich-message length limits are
**unverified**; if the limit is the 4096 characters that `sendMessage` has, Hub splits at
paragraph boundaries. Files go through `sendDocument` or `sendMediaGroup`; the upload limit
(50 MB) is above `maxReplyFileBytes`.

Status reactions use `setMessageReaction`. A bot can set only one reaction per message, so each
phase replaces the previous one. Telegram allows only a fixed emoji set, which has no hourglass or
check mark:

| Phase    | Discord            | Telegram |
| -------- | ------------------ | -------- |
| accepted | `eyes`             | 👀       |
| started  | `hourglass`        | ✍        |
| done     | `white_check_mark` | 👌       |
| failed   | `x`                | 👎       |

## Attachments

Hub stores the Telegram `file_id` as the attachment locator and resolves it with `getFile` at
materialization time. Bot API downloads stop at 20 MB; larger files appear in context with their
name and size and no content. `attachment_capabilities.provider` gains `telegram`.

## Implementation map

| Area            | Files                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Registration    | `src/providers/telegram/` (`index.ts`, `client.ts`)                                                                                     |
| Trigger runtime | `src/triggers/telegram/` (`bot.ts`, `source.ts`, `events.ts`, `match.ts`, `provider.ts`, `reply.ts`, `attachments.ts`, `transcript.ts`) |
| Webhook route   | `src/routes/api/integrations/telegram/events.ts`                                                                                        |
| Database        | `schema.ts`, `types.ts`, `pg.ts`, `memory.ts`, `connections.ts`, `trigger-acceptance.ts`, one migration                                 |
| Configuration   | `config/compiler.ts`, `triggers/configuration/{schema,events,editor}.ts`                                                                |
| Setup UI        | `provider-applications/{guides,internal/environment,internal/verifier}.ts`, connections panel                                           |
| Public API      | `public-api/contracts.ts` provider unions                                                                                               |

The Telegram HTTP client is a thin `fetch` wrapper. No new dependency is required.

## Verification

- Unit tests next to each new module, mirroring the Discord tests.
- An embedded-database integration test for binding, transcript writes, and retention.
- A real-bot check, gated like `src/triggers/discord/e2e.real.test.ts`, that covers the
  **unverified** items: plain-mention delivery in privacy mode and the rich-message length limit.
