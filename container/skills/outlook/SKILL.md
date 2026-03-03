---
name: outlook
description: Read emails from Microsoft Outlook / Microsoft 365. Use to check inbox, read a specific email, or search for messages. Invoke proactively when the user asks about email, their inbox, messages, or anything that might involve checking their Outlook.
allowed-tools: Bash
---

# Outlook Email Reader

Read emails from Microsoft 365 via Microsoft Graph API.

## Commands

```bash
# List inbox (most recent 10)
node /workspace/tools/outlook-read.js list

# List with options
node /workspace/tools/outlook-read.js list --count 20
node /workspace/tools/outlook-read.js list --folder sent
node /workspace/tools/outlook-read.js list --folder drafts
node /workspace/tools/outlook-read.js list --folder junk

# Read a specific email (use the [shortId] shown in list output)
node /workspace/tools/outlook-read.js read <message-id>

# Search emails
node /workspace/tools/outlook-read.js search <query>
node /workspace/tools/outlook-read.js search "project proposal"
node /workspace/tools/outlook-read.js search "from:boss@company.com"
```

## Notes

- The `list` command shows a short 12-char ID for each message. Use the full ID from `read` if the short one doesn't work.
- `search` uses KQL (Keyword Query Language) — supports `from:`, `subject:`, `hasAttachments:true`, etc.
- Body of emails is returned as plain text (HTML tags stripped).
- To read the full content of an email from `list`, copy its `[shortId]` and run `read`.
