import * as Alexa from 'ask-sdk-core';
import { ExpressAdapter } from 'ask-sdk-express-adapter';
import express from 'express';
import { Server } from 'http';

import { ALEXA_PORT, ALEXA_SKILL_ID, ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnChatMetadata, OnInboundMessage } from '../types.js';

export const ALEXA_JID = 'alexa:default';

// Alexa has a hard 8-second HTTP timeout on skill responses.
// We respond immediately with "working on it" and cache the result.
// The user then says "what did you find" to hear the answer.
const MAX_SPEECH_CHARS = 3000;
// Wait up to 6s for a fast response (Ollama without tools); otherwise fire-and-forget.
const FAST_RESPONSE_TIMEOUT_MS = 7000;

export interface AlexaChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
}

export class AlexaChannel implements Channel {
  name = 'alexa';

  private opts: AlexaChannelOpts;
  private server: Server | null = null;
  // Pending fast-response: resolve when agent replies within 6s
  private pendingResolve: ((text: string) => void) | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  // Cached result from the last completed query (for "what did you find")
  private lastResult: string | null = null;

  constructor(opts: AlexaChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const app = express();

    const LaunchHandler: Alexa.RequestHandler = {
      canHandle: (input) =>
        Alexa.getRequestType(input.requestEnvelope) === 'LaunchRequest',
      handle: (input) =>
        input.responseBuilder
          .speak(`${ASSISTANT_NAME} is ready. What would you like to ask?`)
          .reprompt('What would you like to ask?')
          .getResponse(),
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

        // Deliver inbound message to the agent
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

        // Try to get a fast response within 6 seconds.
        // If the agent finishes in time, speak it directly.
        // If not, tell the user to ask "what did you find" and cache the result when it arrives.
        const responseText = await new Promise<string | null>((resolve) => {
          this.pendingResolve = resolve;
          this.pendingTimer = setTimeout(() => {
            this.pendingResolve = null;
            this.pendingTimer = null;
            resolve(null); // timed out — will fire-and-forget
          }, FAST_RESPONSE_TIMEOUT_MS);
        });

        if (responseText !== null) {
          // Fast response — speak it and close the session
          const speech =
            responseText.length > MAX_SPEECH_CHARS
              ? responseText.slice(0, MAX_SPEECH_CHARS) + '... The full response is on your phone.'
              : responseText;
          return input.responseBuilder
            .speak(speech)
            .withShouldEndSession(true)
            .getResponse();
        } else {
          // Slow response — agent is still running, cache result when ready
          return input.responseBuilder
            .speak(
              "I'm working on that. Ask me 'what did you find' in a moment when I'm done.",
            )
            .withShouldEndSession(true)
            .getResponse();
        }
      },
    };

    const LastResultIntentHandler: Alexa.RequestHandler = {
      canHandle: (input) =>
        Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest' &&
        Alexa.getIntentName(input.requestEnvelope) === 'LastResultIntent',
      handle: (input) => {
        if (!this.lastResult) {
          return input.responseBuilder
            .speak("I don't have a result yet. I might still be working on it.")
            .reprompt('Is there anything else?')
            .getResponse();
        }
        const speech =
          this.lastResult.length > MAX_SPEECH_CHARS
            ? this.lastResult.slice(0, MAX_SPEECH_CHARS) + '... The full response is on your phone.'
            : this.lastResult;
        this.lastResult = null; // clear after reading
        return input.responseBuilder
          .speak(speech)
          .withShouldEndSession(true)
          .getResponse();
      },
    };

    const FallbackIntentHandler: Alexa.RequestHandler = {
      canHandle: (input) =>
        Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest' &&
        Alexa.getIntentName(input.requestEnvelope) === 'AMAZON.FallbackIntent',
      handle: (input) =>
        input.responseBuilder
          .speak(
            "I didn't catch that. Try saying: ask me, tell me, what is, how do I, or where is — followed by your question.",
          )
          .reprompt('What would you like to ask?')
          .getResponse(),
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
          .speak(
            "I didn't catch that. Try saying: ask me, tell me, what is, how do I, or where is — followed by your question.",
          )
          .reprompt('What would you like to ask?')
          .getResponse();
      },
    };

    const skillBuilder = Alexa.SkillBuilders.custom()
      .addRequestHandlers(
        LaunchHandler,
        QueryIntentHandler,
        LastResultIntentHandler,
        FallbackIntentHandler,
        StopIntentHandler,
        SessionEndedHandler,
      )
      .addErrorHandlers(ErrorHandler);

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
        console.log(`  Expose publicly: cloudflared tunnel --url http://localhost:${ALEXA_PORT}\n`);
        resolve();
      });
    });
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    if (this.pendingResolve) {
      // Fast path: agent replied within 6s, resolve the waiting HTTP request
      clearTimeout(this.pendingTimer!);
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      this.pendingTimer = null;
      resolve(text);
    } else {
      // Slow path: HTTP request already returned "working on it", cache for next ask
      this.lastResult = text;
      logger.info({ textLength: text.length }, 'Alexa: result cached for next LastResultIntent');
    }
  }

  isConnected(): boolean {
    return this.server !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('alexa:');
  }

  async disconnect(): Promise<void> {
    if (this.pendingResolve) {
      clearTimeout(this.pendingTimer!);
      this.pendingResolve('SlyClaw is shutting down. Please try again shortly.');
      this.pendingResolve = null;
    }
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
      logger.info('Alexa endpoint stopped');
    }
  }
}
