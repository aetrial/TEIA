import dotenv from "dotenv";
import WebSocket from "ws";
import { validateWebSocketToken } from './middleware/internal-auth.js';
import { reportSessionComplete, calculateDuration } from './services/session-complete.js';

// Load environment variables
dotenv.config();

export function registerInboundRoutes(fastify) {

  /**
   * Internal endpoint for receiving forwarded inbound calls from TEIA-users.
   * Authenticated via HMAC headers (handled by internalAuthHook).
   *
   * Returns TwiML that connects Twilio to our WebSocket media stream,
   * passing all credentials via <Parameter> elements.
   */
  fastify.post("/internal/call", async (request, reply) => {
    const {
      sessionId,
      clientId,
      sessionToken,
      callSid,
      from,
      to,
      // Decrypted credentials from TEIA-users
      elevenLabsApiKey,
      elevenLabsAgentId
    } = request.body;

    console.log(`[Internal-Call] Received call: sessionId=${sessionId}, clientId=${clientId}, from=${from}, to=${to}`);

    if (!sessionId || !clientId || !sessionToken) {
      return reply.code(400).send({ error: "Missing required session fields" });
    }

    if (!elevenLabsApiKey || !elevenLabsAgentId) {
      return reply.code(400).send({ error: "Missing ElevenLabs credentials" });
    }

    // Build TwiML response that connects to our media stream
    // Credentials are passed as Parameters - Twilio delivers them in customParameters
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/media-stream">
            <Parameter name="session_token" value="${sessionToken}" />
            <Parameter name="client_id" value="${clientId}" />
            <Parameter name="session_id" value="${sessionId}" />
            <Parameter name="elevenlabs_api_key" value="${elevenLabsApiKey}" />
            <Parameter name="elevenlabs_agent_id" value="${elevenLabsAgentId}" />
          </Stream>
        </Connect>
      </Response>`;

    reply.type("text/xml").send(twimlResponse);
  });

  /**
   * Legacy endpoint - direct Twilio webhook.
   * DEPRECATED: Traffic should flow through TEIA-users first.
   */
  fastify.all("/incoming-call-eleven", async (request, reply) => {
    console.warn("[DEPRECATED] /incoming-call-eleven bypasses TEIA-users and will be removed. Migrate to the internal API flow.");

    // This legacy endpoint is kept for backward compatibility but should not be used
    return reply.code(410).send({
      error: "Gone",
      message: "This endpoint is deprecated. Configure Twilio webhooks to point to TEIA-users."
    });
  });

  /**
   * WebSocket media stream handler.
   * Receives audio from Twilio, forwards to ElevenLabs, and returns synthesized audio.
   *
   * Authentication: validates session token from customParameters on 'start' event.
   * Credentials: extracted from customParameters (passed via TwiML <Parameter> elements).
   */
  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get("/media-stream", { websocket: true }, (connection, req) => {
      console.info("[Server] Twilio connected to media stream.");

      let streamSid = null;
      let sessionStartTime = null;
      let sessionInfo = {
        clientId: null,
        sessionId: null,
        authenticated: false
      };
      let credentials = {
        elevenLabsApiKey: null,
        elevenLabsAgentId: null
      };

      // ElevenLabs WebSocket - initialized after authentication
      let elevenLabsWs = null;

      /**
       * Initializes connection to ElevenLabs Conversational AI.
       */
      const initElevenLabs = (apiKey, agentId) => {
        console.log(`[ElevenLabs] Connecting with agentId=${agentId}`);

        elevenLabsWs = new WebSocket(
          `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agentId}`
        );

        elevenLabsWs.on("open", () => {
          console.log("[ElevenLabs] Connected to Conversational AI.");
        });

        elevenLabsWs.on("message", (data) => {
          try {
            const message = JSON.parse(data);
            handleElevenLabsMessage(message, connection);
          } catch (error) {
            console.error("[ElevenLabs] Error parsing message:", error);
          }
        });

        elevenLabsWs.on("error", (error) => {
          console.error("[ElevenLabs] WebSocket error:", error);
        });

        elevenLabsWs.on("close", () => {
          console.log("[ElevenLabs] Disconnected.");
        });
      };

      /**
       * Handles messages from ElevenLabs and forwards audio to Twilio.
       */
      const handleElevenLabsMessage = (message, connection) => {
        switch (message.type) {
          case "conversation_initiation_metadata":
            console.info("[ElevenLabs] Received conversation initiation metadata.");
            break;
          case "audio":
            if (message.audio_event?.audio_base_64) {
              const audioData = {
                event: "media",
                streamSid,
                media: {
                  payload: message.audio_event.audio_base_64,
                },
              };
              connection.send(JSON.stringify(audioData));
            }
            break;
          case "interruption":
            connection.send(JSON.stringify({ event: "clear", streamSid }));
            break;
          case "ping":
            if (message.ping_event?.event_id) {
              const pongResponse = {
                type: "pong",
                event_id: message.ping_event.event_id,
              };
              elevenLabsWs.send(JSON.stringify(pongResponse));
            }
            break;
        }
      };

      /**
       * Reports session completion to TEIA-users (fire-and-forget).
       */
      const handleSessionEnd = async (status) => {
        if (sessionInfo.authenticated && sessionInfo.sessionId && sessionInfo.clientId) {
          const durationSeconds = sessionStartTime ? calculateDuration(sessionStartTime) : 0;
          console.log(`[Session] Ending: sessionId=${sessionInfo.sessionId}, status=${status}, duration=${durationSeconds}s`);

          // Fire-and-forget - reportSessionComplete handles errors internally
          reportSessionComplete({
            clientId: sessionInfo.clientId,
            sessionId: sessionInfo.sessionId,
            type: 'CALL',
            actualDurationSeconds: durationSeconds,
            status
          });
        }
      };

      connection.on("message", async (message) => {
        try {
          const data = JSON.parse(message);

          switch (data.event) {
            case "start":
              streamSid = data.start.streamSid;
              sessionStartTime = Date.now();
              console.log(`[Twilio] Stream started: streamSid=${streamSid}`);

              // Extract and validate credentials from customParameters
              const customParams = data.start.customParameters || {};
              console.log(`[Twilio] Custom parameters received:`, Object.keys(customParams));

              // Validate session token
              const validation = validateWebSocketToken(customParams);

              if (!validation.valid) {
                console.error(`[Session] Token validation failed: ${validation.error}`);
                connection.close(4001, validation.error || 'Invalid token');
                return;
              }

              // Extract session info
              sessionInfo = {
                clientId: validation.clientId || customParams.client_id,
                sessionId: validation.sessionId || customParams.session_id,
                authenticated: true
              };

              // Extract credentials
              credentials = {
                elevenLabsApiKey: customParams.elevenlabs_api_key,
                elevenLabsAgentId: customParams.elevenlabs_agent_id
              };

              console.log(`[Session] Authenticated: clientId=${sessionInfo.clientId}, sessionId=${sessionInfo.sessionId}`);

              // Initialize ElevenLabs with passed credentials
              if (credentials.elevenLabsAgentId) {
                initElevenLabs(credentials.elevenLabsApiKey, credentials.elevenLabsAgentId);
              } else {
                console.error("[Session] Missing ElevenLabs credentials in customParameters");
                connection.close(4002, 'Missing ElevenLabs credentials');
                return;
              }
              break;

            case "media":
              if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                const audioMessage = {
                  user_audio_chunk: Buffer.from(
                    data.media.payload,
                    "base64"
                  ).toString("base64"),
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));
              }
              break;

            case "stop":
              await handleSessionEnd('COMPLETED');
              if (elevenLabsWs) {
                elevenLabsWs.close();
              }
              break;

            default:
              console.log(`[Twilio] Unhandled event: ${data.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      connection.on("close", async () => {
        await handleSessionEnd('COMPLETED');
        if (elevenLabsWs) {
          elevenLabsWs.close();
        }
        console.log("[Twilio] Client disconnected");
      });

      connection.on("error", async (error) => {
        console.error("[Twilio] WebSocket error:", error);
        await handleSessionEnd('FAILED');
        if (elevenLabsWs) {
          elevenLabsWs.close();
        }
      });
    });
  });
}
