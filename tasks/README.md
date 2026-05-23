# Managed scheduled tasks

Seed files in this directory are loaded on slyclaw startup and upserted into
the SQLite `scheduled_tasks` table. They're the source of truth for any
scheduled task whose prompt/schedule you want version-controlled (rather
than living only in `store/messages.db`, which is gitignored).

## Layout

```
tasks/
  <group-folder>/        # matches the group's `folder` column
    <name>.json          # task metadata
    <name>.prompt.md     # the prompt body (default; can be overridden)
```

## JSON schema

```json
{
  "id": "task-<unique-id>",
  "schedule_type": "cron" | "interval" | "once",
  "schedule_value": "0 8 * * *" | "900000" | "2026-12-25T09:00:00.000Z",
  "context_mode": "isolated" | "group",   // optional, defaults to "isolated"
  "prompt_file": "alt-prompt.md",         // optional, defaults to <name>.prompt.md
  "prompt": "...inline prompt..."         // optional, used only if no prompt_file resolves
}
```

`schedule_value` is the cron expression (for `cron`), the interval in
milliseconds (for `interval`), or an ISO timestamp (for `once`).

`id` must be stable across restarts — it's the primary key. Use the
existing id when migrating a runtime-created task to a seed.

## Behavior

On startup, for each seed file:

- **If a row with `id` exists** → update `prompt`, `schedule_type`,
  `schedule_value`, `context_mode`. **Status, `next_run`, `last_run`, and
  `chat_jid` are preserved** — so a manually-paused task stays paused and
  a runtime-set schedule isn't reset.
- **If no row exists** → create one. `chat_jid` is looked up from the
  registered group whose `folder` matches the parent directory name. If
  the group isn't registered yet, the seed is skipped (and retried on
  the next startup).

Tasks created at runtime via WhatsApp (e.g. "@Nano remind me daily at
8am to...") are NOT affected — they aren't in this directory, so the
loader leaves them alone. Only seeded tasks are managed.

## Editing a managed task

Edit the `.prompt.md` (or `.json`) here, then restart slyclaw:

```bash
systemctl --user restart slyclaw
```

The next startup will update the DB row from the seed.
