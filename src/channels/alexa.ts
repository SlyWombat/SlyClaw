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

// How long to wait for the agent to respond before sending a timeout reply
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
  // Most recent pending requestId
  private latestRequestId: string | null = null;

  constructor(opts: AlexaChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const app = express();

    const LaunchHandler: Alexa.RequestHandler = {
      canHandle: (input) =>
        Alexa.getRequestType(input.requestEnvelope) === 'LaunchRequest',
      handle: (input) => {
        return input.responseBuilder
          .speak(`${ASSISTANT_NAME} is ready. What would you like to ask?`)
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
            await directiveServiceClient.enqueue({
              header: {
                requestId: requestId,
              },
              directive: {
                type: 'VoicePlayer.Speak',
                speech: '<speak>Let me think about that.</speak>',
              },
            });
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
              "I'm still working on that. Check back in a moment or look at your phone for the result.",
            );
          }, RESPONSE_TIMEOUT_MS);
          this.pending.set(requestId, { resolve, timer });
        });

        const speech =
          responseText.length > MAX_SPEECH_CHARS
            ? responseText.slice(0, MAX_SPEECH_CHARS) +
              '... The full response was sent to your phone.'
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

    const skillBuilder = Alexa.SkillBuilders.custom()
      .addRequestHandlers(
        LaunchHandler,
        QueryIntentHandler,
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
    logger.debug(
      { textLength: text.length },
      'Alexa: agent response arrived but no pending request',
    );
  }

  isConnected(): boolean {
    return this.server !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('alexa:');
  }

  async disconnect(): Promise<void> {
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
