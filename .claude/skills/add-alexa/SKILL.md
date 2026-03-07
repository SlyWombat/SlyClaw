---
name: add-alexa
description: Add Amazon Alexa as a channel. Speak to SlyClaw via any Alexa device and hear responses spoken back. Uses a local HTTPS endpoint exposed via Cloudflare Tunnel and a custom Alexa skill in the Amazon Developer Console.
---

# Add Alexa Channel

This skill adds Amazon Alexa as a voice channel for SlyClaw. After setup:

- Say **"Alexa, open SlyClaw"** to start a conversation session
- Say **"Alexa, ask SlyClaw [anything]"** for one-shot queries
- Alexa speaks the agent's response aloud
- Uses progressive responses so Alexa says "thinking..." while the agent runs

**Architecture:**
- SlyClaw runs a local Express HTTPS endpoint (`/alexa`)
- Cloudflare Tunnel exposes it publicly with a valid TLS cert (required by Alexa)
- A custom Alexa skill in the Amazon Developer Console points at this URL
- `AlexaChannel` implements the `Channel` interface — inbound speech comes in as messages, outbound text goes back to Alexa as speech

**JID format:** `alexa:default` (all Alexa requests route to a single registered chat)

---

## Prerequisites

### 1. Amazon Developer Account

Tell the user:

> You need a free Amazon Developer account:
>
> 1. Go to https://developer.amazon.com and sign in (or create account)
> 2. Make sure it's linked to the same Amazon account as your Alexa device

### 2. Install Dependencies

```bash
npm install ask-sdk-core ask-sdk-express-adapter express
npm install --save-dev @types/express
```

### 3. Install Cloudflare Tunnel

```bash
# Install cloudflared
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
rm cloudflared.deb
```

Verify: `cloudflared --version`

---

## Implementation

### Step 1: Update Configuration

Read `src/config.ts` and add Alexa config exports:

```typescript
export const ALEXA_PORT = parseInt(process.env.ALEXA_PORT || '3456', 10);
export const ALEXA_SKILL_ID = process.env.ALEXA_SKILL_ID || '';
```

### Step 2: Create the Alexa Channel

Create `src/channels/alexa.ts`:

```typescript
import * as Alexa from 'ask-sdk-core';
import { ExpressAdapter } from 'ask-sdk-express-adapter';
import express from 'express';
import { Server } from 'http';

import { ALEXA_PORT, ALEXA_SKILL_ID, ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnChatMetadata, OnInboundMessage } from '../types.js';

export const ALEXA_JID = 'alexa:default';

// Maximum characters Alexa speaks comfortably in one response
const MAX_SPEECH_CHARS = 3000;

// How long to wait for the agent to respond before sending a "still thinking" reply
const RESPONSE_TIMEOUT_MS = 25000;

interface PendingRequest {
  resolve: (text: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface AlexaChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
}

export class AlexaChannel implements Channel {
  name = 'alexa';

  private opts: AlexaChannelOpts;
  private server: Server | null = null;
  // Map from Alexa requestId → pending resolve for outbound response
  private pending = new Map<string, PendingRequest>();
  // Latest pending requestId (most recent active session)
  private latestRequestId: string | null = null;

  constructor(opts: AlexaChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const app = express();

    // --- Alexa request handlers ---

    const LaunchHandler: Alexa.RequestHandler = {
      canHandle: (input) =>
        Alexa.getRequestType(input.requestEnvelope) === 'LaunchRequest',
      handle: (input) => {
        const speechText = `${ASSISTANT_NAME} is ready. What would you like to ask?`;
        return input.responseBuilder
          .speak(speechText)
          .reprompt('What would you like to ask?')
          .getResponse();
      },
    };

    const QueryIntentHandler: Alexa.RequestHandler = {
      canHandle: (input) =>
        Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest' &&
        Alexa.getIntentName(input.requestEnvelope) === 'QueryIntent',
      handle: async (input) => {
        const query =
          Alexa.getSlotValue(input.requestEnvelope, 'query') ||
          Alexa.getSlotValue(input.requestEnvelope, 'Query') ||
          '';

        if (!query.trim()) {
          return input.responseBuilder
            .speak("Sorry, I didn't catch that. What would you like to ask?")
            .reprompt('What would you like to ask?')
            .getResponse();
        }

        const requestId = input.requestEnvelope.request.requestId;
        const timestamp = new Date().toISOString();

        logger.info({ query, requestId }, 'Alexa query received');

        // Send progressive response so Alexa doesn't time out while agent thinks
        try {
          const directiveServiceClient =
            input.serviceClientFactory?.getDirectiveServiceClient();
          if (directiveServiceClient) {
            await directiveServiceClient.enqueue(
              {
                type: 'VoicePlayer.Speak',
                speech: `<speak>Let me think about that.</speak>`,
              },
              input.requestEnvelope.context.System.apiEndpoint,
              input.requestEnvelope.context.System.apiAccessToken,
            );
          }
        } catch {
          // Progressive response is best-effort; continue regardless
        }

        // Deliver inbound message — the message loop will process it
        this.opts.onChatMetadata(ALEXA_JID, timestamp, 'Alexa');
        this.opts.onMessage(ALEXA_JID, {
          id: requestId,
          chat_jid: ALEXA_JID,
          sender: 'alexa-user',
          sender_name: 'Alexa User',
          content: query,
          timestamp,
          is_from_me: false,
        });

        // Wait for sendMessage() to be called with the agent's response
        const responseText = await new Promise<string>((resolve) => {
          this.latestRequestId = requestId;
          const timer = setTimeout(() => {
            this.pending.delete(requestId);
            resolve(
              `I'm still working on that. Check back in a moment or look at your phone for the result.`,
            );
          }, RESPONSE_TIMEOUT_MS);
          this.pending.set(requestId, { resolve, timer });
        });

        const speech =
          responseText.length > MAX_SPEECH_CHARS
            ? responseText.slice(0, MAX_SPEECH_CHARS) + '... The full response was sent to your phone.'
            : responseText;

        return input.responseBuilder
          .speak(speech)
          .reprompt('Is there anything else?')
          .getResponse();
      },
    };

    const StopIntentHandler: Alexa.RequestHandler = {
      canHandle: (input) =>
        Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest' &&
        (Alexa.getIntentName(input.requestEnvelope) === 'AMAZON.StopIntent' ||
          Alexa.getIntentName(input.requestEnvelope) === 'AMAZON.CancelIntent'),
      handle: (input) =>
        input.responseBuilder.speak('Goodbye!').withShouldEndSession(true).getResponse(),
    };

    const SessionEndedHandler: Alexa.RequestHandler = {
      canHandle: (input) =>
        Alexa.getRequestType(input.requestEnvelope) === 'SessionEndedRequest',
      handle: (input) => input.responseBuilder.getResponse(),
    };

    const ErrorHandler: Alexa.ErrorHandler = {
      canHandle: () => true,
      handle: (input, error) => {
        logger.error({ error: error.message }, 'Alexa error handler');
        return input.responseBuilder
          .speak('Sorry, something went wrong. Please try again.')
          .getResponse();
      },
    };

    // Build skill
    const skillBuilder = Alexa.SkillBuilders.custom()
      .addRequestHandlers(
        LaunchHandler,
        QueryIntentHandler,
        StopIntentHandler,
        SessionEndedHandler,
      )
      .addErrorHandlers(ErrorHandler);

    // Verify Alexa skill ID if configured
    if (ALEXA_SKILL_ID) {
      skillBuilder.withSkillId(ALEXA_SKILL_ID);
    }

    const skill = skillBuilder.create();
    const adapter = new ExpressAdapter(skill, true, true);

    app.post('/alexa', adapter.getRequestHandlers());

    app.get('/health', (_req, res) => res.json({ status: 'ok', channel: 'alexa' }));

    await new Promise<void>((resolve) => {
      this.server = app.listen(ALEXA_PORT, () => {
        logger.info({ port: ALEXA_PORT }, 'Alexa endpoint listening');
        console.log(`\n  Alexa endpoint: http://localhost:${ALEXA_PORT}/alexa`);
        console.log(`  Expose with: cloudflared tunnel --url http://localhost:${ALEXA_PORT}\n`);
        resolve();
      });
    });
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    // Route response to the most recent waiting Alexa request
    if (this.latestRequestId) {
      const pending = this.pending.get(this.latestRequestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(this.latestRequestId);
        this.latestRequestId = null;
        pending.resolve(text);
        return;
      }
    }
    // No waiting request — response arrived after timeout, just log it
    logger.debug({ textLength: text.length }, 'Alexa: agent response arrived but no pending request');
  }

  isConnected(): boolean {
    return this.server !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('alexa:');
  }

  async disconnect(): Promise<void> {
    // Resolve all pending with a graceful message
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve('SlyClaw is shutting down. Please try again shortly.');
    }
    this.pending.clear();

    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
      logger.info('Alexa endpoint stopped');
    }
  }
}
```

### Step 3: Wire into Main Application

Read `src/index.ts` and make these changes:

1. **Add imports** near the other channel imports:

```typescript
import { AlexaChannel, ALEXA_JID } from './channels/alexa.js';
import { ALEXA_PORT, ALEXA_SKILL_ID } from './config.js';
```

2. **Create and connect the channel** in `main()`, alongside the other channels:

```typescript
// In main(), after existing channel setup:
if (ALEXA_PORT) {
  const alexa = new AlexaChannel({
    onMessage: (chatJid, msg) => storeMessage(msg),
    onChatMetadata: (chatJid, timestamp, name) => storeChatMetadata(chatJid, timestamp, name),
  });
  channels.push(alexa);
  await alexa.connect();
}
```

3. **Register the Alexa chat** on first start. Add this helper to `src/index.ts` (call it from `main()` after `initDatabase()`):

```typescript
function ensureAlexaRegistered(): void {
  const existing = registeredGroups[ALEXA_JID];
  if (!existing) {
    registerGroup(ALEXA_JID, {
      name: 'Alexa',
      folder: 'alexa',
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false, // All Alexa speech goes straight to agent
    });
    logger.info('Alexa chat auto-registered');
  }
}
```

Call it:
```typescript
initDatabase();
loadState();
ensureAlexaRegistered();
```

Note: `registerGroup` and `loadState` already exist in `src/index.ts` — look at how Telegram registration works for the exact calling pattern.

### Step 4: Add `.env` Variables

Add to `.env`:

```bash
ALEXA_PORT=3456
ALEXA_SKILL_ID=   # Fill in after creating the skill (Step 7)
```

Sync to container env:

```bash
cp .env data/env/env
```

### Step 5: Build and Start

```bash
npm run build
systemctl --user restart slyclaw
```

### Step 6: Expose with Cloudflare Tunnel

Run Cloudflare Tunnel to get a public HTTPS URL:

```bash
cloudflared tunnel --url http://localhost:3456
```

You'll see output like:
```
Your quick Tunnel has been created! Visit it at (it may take some time to start up):
https://some-random-name.trycloudflare.com
```

Copy the full URL — you'll need `https://some-random-name.trycloudflare.com/alexa` for the Alexa skill.

**Note:** This URL changes every time you restart. For a stable URL, set up a named tunnel:

```bash
cloudflared tunnel login
cloudflared tunnel create slyclaw
cloudflared tunnel route dns slyclaw your-subdomain.yourdomain.com
cloudflared tunnel run slyclaw
```

For now, the quick tunnel is fine for testing.

### Step 7: Create the Alexa Skill

Tell the user:

> Go to https://developer.amazon.com/alexa/console/ask and:
>
> 1. Click **Create Skill**
> 2. **Skill name**: SlyClaw (or whatever you'd like to say)
> 3. **Primary locale**: English (or your language)
> 4. **Model**: Custom
> 5. **Hosting**: Provision your own
> 6. Click **Create Skill**
>
> Once inside the skill builder:
>
> **Invocation Name** (under Invocations):
> - Set to: `sly claw` (what you say to Alexa, e.g. "Alexa, open sly claw")
>
> **Intents** — Create one intent called `QueryIntent` with:
> - Sample utterances:
>   - `{query}`
>   - `ask {query}`
>   - `tell me {query}`
>   - `what is {query}`
>   - `can you {query}`
> - Slot: name `query`, type `AMAZON.SearchQuery`
>
> **Endpoint** (under Endpoint):
> - Select **HTTPS**
> - Default region URL: `https://YOUR-TUNNEL-URL/alexa`
> - Certificate: **My development endpoint is a sub-domain of a domain that has a wildcard certificate from a certificate authority**
>   - (Cloudflare Tunnel always uses valid TLS, so this option works)
>
> **Save Model**, then **Build Model**, then copy your **Skill ID** (shown at top of page — looks like `amzn1.ask.skill.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)

Wait for the user to provide the Skill ID.

Once provided, add it to `.env`:

```bash
ALEXA_SKILL_ID=amzn1.ask.skill.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

And sync: `cp .env data/env/env`

### Step 8: Test

Tell the user:

> Say: **"Alexa, open SlyClaw"**
>
> Alexa should respond: "*SlyClaw is ready. What would you like to ask?*"
>
> Then say: **"What's the weather like today?"**
>
> Alexa will say "Let me think about that", wait for the agent, then speak the response.
>
> Check logs: `journalctl --user -u slyclaw -f`

---

## Keeping Cloudflare Tunnel Running

The quick tunnel (`cloudflared tunnel --url`) stops when you close the terminal. To run it persistently:

```bash
# Add to .env:
# CLOUDFLARE_TUNNEL=true

# Create a systemd service for the tunnel:
cat > ~/.config/systemd/user/slyclaw-tunnel.service << 'EOF'
[Unit]
Description=Cloudflare Tunnel for SlyClaw Alexa
After=network.target

[Service]
ExecStart=/usr/bin/cloudflared tunnel --url http://localhost:3456
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user enable slyclaw-tunnel
systemctl --user start slyclaw-tunnel
journalctl --user -u slyclaw-tunnel -f   # see the tunnel URL
```

**Note:** The quick tunnel URL changes on each restart. For a stable URL, use a named Cloudflare Tunnel (requires a domain). The Alexa skill endpoint URL must be updated in the developer console whenever it changes.

---

## How Responses Work

**Timing:**
- Alexa sends speech → SlyClaw receives it as a message
- Agent processes (Ollama: ~2–5s, Claude: ~10–30s)
- Alexa sends a progressive "Let me think about that" while waiting (up to 25s)
- Agent response is spoken by Alexa

**Character limit:** Alexa speaks up to 3000 characters. Longer responses are truncated with "...the full response was sent to your phone."

**Session handling:** Alexa keeps the session open after each response (repromptes with "Is there anything else?"), so you can have a back-and-forth conversation without re-invoking the skill.

**No trigger word needed:** Alexa queries always go straight to the agent — no `@Nano` prefix required.

---

## Interaction Examples

```
You:   "Alexa, open SlyClaw"
Alexa: "SlyClaw is ready. What would you like to ask?"

You:   "What's on my calendar today?"
Alexa: "Let me think about that."   ← progressive response
Alexa: "You have a team standup at 9am and a dentist appointment at 3pm."

You:   "Set a reminder for my dentist appointment"
Alexa: "Done! I've added a reminder for your 3pm dentist appointment."

You:   "Alexa, stop"
Alexa: "Goodbye!"
```

---

## Troubleshooting

### "The requested skill's response was invalid"

- Skill ID mismatch: verify `ALEXA_SKILL_ID` matches the console
- Endpoint URL is wrong or tunnel is down: `curl https://YOUR-TUNNEL/health`
- Certificate error: Cloudflare Tunnel is always valid, but re-check the cert type selected in skill settings

### Alexa times out / says "something went wrong"

- Agent is taking longer than 25 seconds — try switching to Ollama: `@Nano use qwen`
- Check logs: `journalctl --user -u slyclaw -f`

### "I didn't catch that" every time

- The `QueryIntent` slots need the exact name `query` — check Alexa developer console
- Try more specific utterances in the intent

### Tunnel URL changed

- Restart the tunnel: `systemctl --user restart slyclaw-tunnel`
- Check new URL: `journalctl --user -u slyclaw-tunnel | grep trycloudflare`
- Update the endpoint URL in the Alexa developer console → Endpoint

### Alexa doesn't hear all messages

- Make sure the `QueryIntent` has `{query}` as a catch-all utterance (just the slot, no surrounding words)
- Add `{query}` as the first utterance in the list

---

## Removal

1. Delete `src/channels/alexa.ts`
2. Remove `AlexaChannel` import and creation from `src/index.ts`
3. Remove `ensureAlexaRegistered()` call
4. Remove `ALEXA_PORT` and `ALEXA_SKILL_ID` from `src/config.ts`
5. Remove from `.env`
6. Uninstall: `npm uninstall ask-sdk-core ask-sdk-express-adapter express`
7. Stop tunnel: `systemctl --user stop slyclaw-tunnel && systemctl --user disable slyclaw-tunnel`
8. Delete `~/.config/systemd/user/slyclaw-tunnel.service`
9. Delete Alexa skill: go to developer console → delete skill
10. Rebuild: `npm run build && systemctl --user restart slyclaw`
