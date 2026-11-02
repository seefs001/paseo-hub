# Conversation choices

Status: design, not implemented. Applies to Discord and Telegram. Slack can adopt the same
contract later through `block_actions`.

An agent can attach buttons to a reply. A user's click continues the same conversation, exactly as
if that user had written the chosen answer in the thread. Typical uses are approve or reject,
pick one of several plans, or confirm a destructive step.

## Why a click is a continuation

Hub already continues a conversation when a new message arrives in it (`discord.thread_message`).
The agent session receives the next prompt even while it is running (`src/agent-sessions/`). A click
uses the same path. This choice has three consequences:

- No tool call blocks while it waits for a human. The agent sends the question, can finish its
  execution, and the click starts the next execution in the same agent session.
- No new paused state in the workflow engine. A workflow-level approval gate is a separate,
  larger feature and is not part of this design.
- Authority stays the same. A click is accepted only from a user who could have continued the
  conversation by message.

## Authoring

Choices are opt-in per reply output, so a trigger never gains a new way to start runs without the
author asking for it:

```yaml
run:
  outputs:
    discord.reply:
      choices: true
    telegram.reply:
      choices: true
```

`TriggerOutputSchema` and the compiled `AllowedOutput` gain `choices?: boolean`. When it is true,
the provider's reply tool exposes an extra argument:

```json
"choices": {
  "type": "array",
  "minItems": 1,
  "maxItems": 5,
  "items": {
    "type": "object",
    "properties": {
      "label": { "type": "string", "minLength": 1, "maxLength": 64 },
      "style": { "enum": ["primary", "success", "danger"] }
    },
    "required": ["label"],
    "additionalProperties": false
  }
}
```

The limits fit both providers: Discord allows five buttons per action row and 80-character labels;
Telegram has `primary`, `success`, and `danger` button styles, matching Discord's styles 1, 3,
and 4.

When `choices` is false or absent, the reply tool schema is unchanged.

## Lifecycle

1. The agent calls `reply` with `choices`. The executor stores one `conversation_choices` row and
   sends the message with buttons. Each button carries an opaque id: `pc:<choice-set-id>:<index>`.
   This fits Telegram's 64-byte `callback_data` and Discord's 100-character `custom_id`.
2. A user clicks. The provider source acknowledges at once: Discord requires an initial response
   within 3 seconds (Hub sends `DEFERRED_UPDATE_MESSAGE`); Telegram shows a spinner until
   `answerCallbackQuery`.
3. Hub loads the choice set and accepts the click if all of these hold:
   - the set is unresolved;
   - the clicker passes the originating trigger's `from_users` filter;
   - the originating trigger still exists in the active configuration revision.
4. Hub resolves the set in the same transaction that accepts the provider event. The first valid
   click wins. Later clicks get a short notice: "Already answered by <user>."
5. Hub edits the message: buttons are removed, and a line records the selected label and the user.
6. The event `<provider>.choice_selected` runs through the normal intake and matching. It is
   offered only to the trigger named in the choice set and continues the stored conversation key.

Rejected clicks get an ephemeral notice and do not create a run. On Telegram the notice is the
`answerCallbackQuery` text (at most 200 characters); on Discord it is an ephemeral follow-up.

## Event context

`${{ paseo.context }}` for a choice event carries:

```json
{
  "<provider>": {
    "event_type": "choice_selected",
    "choice": {
      "label": "Approve",
      "index": 0,
      "question_message": { "id": "...", "url": "..." },
      "user": { "id": "...", "username": "..." }
    }
  }
}
```

The prompt body for the continuation is the chosen label, so prompts that use the message body
work unchanged.

## Data

`conversation_choices`:

| Column                                           | Meaning                                               |
| ------------------------------------------------ | ----------------------------------------------------- |
| `id`                                             | Choice-set id used in button payloads.                |
| `organization_id`, `project_id`, `connection_id` | Ownership and routing.                                |
| `provider`                                       | `discord` or `telegram`.                              |
| `trigger_name`, `configuration_revision_id`      | The trigger that the click continues.                 |
| `conversation_key`                               | The conversation the click continues.                 |
| `agent_execution_id`                             | The execution that asked.                             |
| `message_locator`                                | Provider message coordinates, for the edit in step 5. |
| `options`                                        | Labels and styles.                                    |
| `resolved_index`, `resolved_by`, `resolved_at`   | Null until answered.                                  |
| `expires_at`                                     | 7 days after creation. Expired sets reject clicks.    |

## Provider work

| Provider | Send                                 | Receive                                     | Edit after resolve                  |
| -------- | ------------------------------------ | ------------------------------------------- | ----------------------------------- |
| Discord  | Action row with buttons on the reply | `interactionCreate` on the existing gateway | Edit original via interaction token |
| Telegram | `reply_markup` inline keyboard       | `callback_query` update                     | `editMessageReplyMarkup`            |

Discord interactions arrive over the gateway only when the application has no Interactions
Endpoint URL. The Discord setup guide states this.

## Not included

- Free-text forms and select menus.
- Stop or cancel buttons for a running execution. A later design can reuse the same button and
  authorization path to call the existing session `interrupt` control.
- Streaming progress. Telegram `sendMessageDraft` works only in private chats and has a native
  Stop button; Discord has no equivalent. Both stay out of this design.
