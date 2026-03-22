import WebSocket from "ws";
import Twilio from "twilio";
import pool from './services/db.js'; // Import the shared pool
import { validateWebSocketToken } from './middleware/internal-auth.js';
import { reportSessionComplete, calculateDuration } from './services/session-complete.js';

const LOG_PREFIX = '[OutboundNP]';

export function registerOutboundRoutesNp(fastify) {

  async function getSignedUrl(apiKey, agentId) {
    try {
      console.log(`${LOG_PREFIX} Getting signed URL for agentId=${agentId}`);
      const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
        {
          method: 'GET',
          headers: {
            'xi-api-key': apiKey
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to get signed URL: ${response.statusText}`);
      }

      const data = await response.json();
      return data.signed_url;
    } catch (error) {
      console.error(`${LOG_PREFIX} Error getting signed URL:`, error);
      throw error;
    }
  }

  /**
   * Internal endpoint - receives forwarded outbound calls from TEIA-users.
   * Authenticated via internal HMAC headers (handled by internalAuthHook).
   *
   * Initiates call and returns TwiML that connects to WebSocket with credentials as Parameters.
   */
  fastify.post("/internal/outbound-call-np", async (request, reply) => {
    const {
      sessionId,
      clientId,
      sessionToken,
      to,
      nombre,
      items,
      // Decrypted credentials from TEIA-users
      twilioAccountSid,
      twilioAuthToken,
      twilioPhoneNumber,
      elevenLabsApiKey,
      elevenLabsAgentId
    } = request.body;

    console.log(`${LOG_PREFIX} Initiating outbound call: sessionId=${sessionId}, clientId=${clientId}, to=${to}`);

    if (!sessionId || !clientId || !sessionToken) {
      return reply.code(400).send({ error: "Missing required session fields" });
    }

    if (!to) {
      return reply.code(400).send({ error: "To phone number is required" });
    }

    if (!nombre) {
      return reply.code(400).send({ error: "nombre is required" });
    }

    if (!items) {
      return reply.code(400).send({ error: "items is required" });
    }

    if (!twilioAccountSid || !twilioAuthToken || !twilioPhoneNumber) {
      return reply.code(400).send({ error: "Missing Twilio credentials" });
    }

    if (!elevenLabsApiKey || !elevenLabsAgentId) {
      return reply.code(400).send({ error: "Missing ElevenLabs credentials" });
    }

    try {
      const twilioClient = new Twilio(twilioAccountSid, twilioAuthToken);

      // Build TwiML URL that returns Connect/Stream with credentials
      // Use internal TwiML endpoint that accepts POST with credentials
      const twimlUrl = `https://${request.headers.host}/internal/outbound-call-twiml-np`;

      const call = await twilioClient.calls.create({
        from: twilioPhoneNumber,
        to: to,
        url: twimlUrl,
        // Pass all parameters via StatusCallback or use a stateful approach
        // For simplicity, we embed a webhook that Twilio will POST to
        // But we need to pass credentials securely - use TwiML response here
      });

      console.log(`${LOG_PREFIX} Call initiated: callSid=${call.sid}`);

      // Return TwiML directly (Twilio will use the url we provided)
      // Actually, the Twilio call.create will fetch the TwiML from url
      // We need a different approach - return the call details and have TEIA-users
      // configure the url to point directly to our TwiML endpoint

      // Better approach: return TwiML directly as the response
      // TEIA-users will initiate the call with our TwiML

      // Build TwiML with credentials as Parameters (not query string)
      const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Connect>
            <Stream url="wss://${request.headers.host}/outbound-media-stream-np">
              <Parameter name="session_token" value="${sessionToken}" />
              <Parameter name="client_id" value="${clientId}" />
              <Parameter name="session_id" value="${sessionId}" />
              <Parameter name="elevenlabs_api_key" value="${elevenLabsApiKey}" />
              <Parameter name="elevenlabs_agent_id" value="${elevenLabsAgentId}" />
              <Parameter name="nombre" value="${encodeURIComponent(nombre)}" />
              <Parameter name="items" value="${encodeURIComponent(items)}" />
            </Stream>
          </Connect>
        </Response>`;

      // Return call details - TEIA-users will handle the call initiation
      reply.send({
        success: true,
        message: "Call initiated",
        callSid: call.sid
      });

    } catch (error) {
      console.error(`${LOG_PREFIX} Error initiating call: ${error.message}`);

      // Report failure (fire-and-forget)
      reportSessionComplete({
        clientId,
        sessionId,
        type: 'CALL',
        actualDurationSeconds: 0,
        status: 'FAILED'
      });

      reply.code(500).send({
        success: false,
        error: "Failed to initiate call"
      });
    }
  });

  /**
   * Internal TwiML endpoint - returns TwiML for outbound calls.
   * Called by Twilio when the outbound call connects.
   * Receives credentials from TEIA-users via POST body.
   */
  fastify.post("/internal/outbound-call-twiml-np", async (request, reply) => {
    const {
      sessionId,
      clientId,
      sessionToken,
      nombre,
      items,
      elevenLabsApiKey,
      elevenLabsAgentId
    } = request.body;

    console.log(`${LOG_PREFIX} Generating TwiML: sessionId=${sessionId}, clientId=${clientId}`);

    if (!sessionToken || !clientId || !elevenLabsApiKey || !elevenLabsAgentId) {
      console.error(`${LOG_PREFIX} Missing required TwiML parameters`);
      return reply.code(400).send({ error: "Missing required parameters" });
    }

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/outbound-media-stream-np">
            <Parameter name="session_token" value="${sessionToken}" />
            <Parameter name="client_id" value="${clientId}" />
            <Parameter name="session_id" value="${sessionId || ''}" />
            <Parameter name="elevenlabs_api_key" value="${elevenLabsApiKey}" />
            <Parameter name="elevenlabs_agent_id" value="${elevenLabsAgentId}" />
            <Parameter name="nombre" value="${encodeURIComponent(nombre || '')}" />
            <Parameter name="items" value="${encodeURIComponent(items || '')}" />
          </Stream>
        </Connect>
      </Response>`;

    reply.type("text/xml").send(twimlResponse);
  });

  /**
   * Legacy endpoint - direct API call.
   * DEPRECATED: Traffic should flow through TEIA-users first.
   */
  fastify.post("/outbound-call-np", async (request, reply) => {
    console.warn("[DEPRECATED] /outbound-call-np bypasses TEIA-users and will be removed. Migrate to the internal API flow.");

    const { to, from, nombre, items } = request.body;

    if (!to) {
      return reply.code(400).send({ error: "to Phone number is required" });
    }

    if (!from) {
      return reply.code(400).send({ error: "from Phone number is required" });
    }

    if (!nombre) {
      return reply.code(400).send({ error: "nombre is required" });
    }

    if (!items) {
      return reply.code(400).send({ error: "items is required" });
    }

    let client;
    try {
      client = await pool.connect();

      const dbInfoRes = await client.query(`
        SELECT * FROM twilio_info ti
        JOIN teia_user tu ON ti.id = tu.twilio_info_id
        JOIN eleven_labs_info eli ON tu.eleven_labs_info_id = eli.id
        WHERE ti.twilio_phone_number_calls= $1
      `, [from]);

      if (dbInfoRes.rows.length === 0) {
        throw new Error("Twilio information not found for the given phone number");
      }
      const dbInfo = dbInfoRes.rows[0];
      console.log('dbInfo:', dbInfo);

      const { twilio_acc_sid: TWILIO_ACCOUNT_SID, twilio_auth_token: TWILIO_AUTH_TOKEN, twilio_phone_number_calls: TWILIO_PHONE_NUMBER, eleven_labs_api_key: ELEVENLABS_API_KEY , eleven_labs_agent_id: ELEVENLABS_AGENT_ID } = dbInfo;

      const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

      const call = await twilioClient.calls.create({
            from: TWILIO_PHONE_NUMBER,
            to: to,
            url: `https://${request.headers.host}/outbound-call-twiml-np?apiKey=${ELEVENLABS_API_KEY}&agentId=${ELEVENLABS_AGENT_ID}&nombre=${encodeURIComponent(nombre)}&items=${encodeURIComponent(items)}`,
          });

      reply.send({
        success: true,
        message: "Call initiated",
        callSid: call.sid,
        ELEVENLABS_API_KEY,
        ELEVENLABS_AGENT_ID
      });
    } catch (error) {
      console.error("Error initiating outbound call:", error);
      reply.code(500).send({
        success: false,
        error: "Failed to initiate call"
      });
    } finally {
      if (client) {
        client.release();
      }
    }
  });

  /**
   * Legacy TwiML endpoint - receives credentials via query string.
   * DEPRECATED: Use internal endpoint with credentials in body.
   */
  fastify.all("/outbound-call-twiml-np", async (request, reply) => {
    console.warn("[DEPRECATED] /outbound-call-twiml-np receives credentials via query string. Migrate to internal flow.");

    const { apiKey: ELEVENLABS_API_KEY, agentId: ELEVENLABS_AGENT_ID, nombre, items } = request.query;
    console.log('twiml ELEVENLABS_API_KEY:', ELEVENLABS_API_KEY);
    console.log('twiml ELEVENLABS_AGENT_ID:', ELEVENLABS_AGENT_ID);
    console.log('twiml nombre:', nombre);
    console.log('twiml objetos:', items);

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/outbound-media-stream-np">
                    <Parameter name="apiKey" value="${ELEVENLABS_API_KEY}" />
                    <Parameter name="agentId" value="${ELEVENLABS_AGENT_ID}" />
                    <Parameter name="name" value="${encodeURIComponent(nombre)}" />
                    <Parameter name="items" value="${encodeURIComponent(items)}" />
                  </Stream>
        </Connect>
      </Response>`;

    reply.type("text/xml").send(twimlResponse);
  });

  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get("/outbound-media-stream-np", { websocket: true }, (ws, req) => {
      console.info(`${LOG_PREFIX} Twilio connected to outbound media stream`);

      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
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

      ws.on('error', async (error) => {
        console.error(`${LOG_PREFIX} WebSocket error:`, error);
        await handleSessionEnd('FAILED');
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      });

      /**
       * Reports session completion to TEIA-users (fire-and-forget).
       */
      const handleSessionEnd = async (status) => {
        if (sessionInfo.authenticated && sessionInfo.sessionId && sessionInfo.clientId) {
          const durationSeconds = sessionStartTime ? calculateDuration(sessionStartTime) : 0;
          console.log(`${LOG_PREFIX} Session ending: sessionId=${sessionInfo.sessionId}, status=${status}, duration=${durationSeconds}s`);

          // Fire-and-forget
          reportSessionComplete({
            clientId: sessionInfo.clientId,
            sessionId: sessionInfo.sessionId,
            type: 'CALL',
            actualDurationSeconds: durationSeconds,
            status
          });
        }
      };

      const setupElevenLabs = async (apiKey, agentId, name, items) => {
        try {
          const signedUrl = await getSignedUrl(apiKey, agentId);
          elevenLabsWs = new WebSocket(signedUrl);

          const decodedNombre = name ? decodeURIComponent(name) : '';
          const decodedItems = items ? decodeURIComponent(items) : '';

          elevenLabsWs.on("open", () => {
            console.log(`${LOG_PREFIX} [ElevenLabs] Connected to Conversational AI`);
            const initialConfig = {
              type: "conversation_initiation_client_data",
              dynamic_variables: {
                name: decodedNombre,
                items: decodedItems
              }
            };
            elevenLabsWs.send(JSON.stringify(initialConfig));
          });

          elevenLabsWs.on("message", (data) => {
            try {
              const message = JSON.parse(data);

              switch (message.type) {
                case "conversation_initiation_metadata":
                  console.log(`${LOG_PREFIX} [ElevenLabs] Received initiation metadata`);
                  break;

                case "audio":
                  if (streamSid) {
                    if (message.audio?.chunk) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: message.audio.chunk
                        }
                      };
                      ws.send(JSON.stringify(audioData));
                    } else if (message.audio_event?.audio_base_64) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: message.audio_event.audio_base_64
                        }
                      };
                      ws.send(JSON.stringify(audioData));
                    }
                  } else {
                    console.log(`${LOG_PREFIX} [ElevenLabs] Received audio but no StreamSid yet`);
                  }
                  break;

                case "agent_tool_response":
                  // Detect and close on end_call tool execution
                  if (message.agent_tool_response?.tool_name === "end_call") {
                    console.log(`${LOG_PREFIX} [ElevenLabs] Received end_call tool response - closing connections.`);
                    try {
                      if (ws?.readyState === WebSocket.OPEN) {
                        ws.close();
                      }
                      if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                        elevenLabsWs.close();
                      }
                    } catch (err) {
                      console.error(`${LOG_PREFIX} Error while closing sockets:`, err);
                    }
                    return;
                  }
                  break;

                case "interruption":
                  if (streamSid) {
                    ws.send(JSON.stringify({ event: "clear", streamSid }));
                  }
                  break;

                case "ping":
                  if (message.ping_event?.event_id) {
                    elevenLabsWs.send(JSON.stringify({ type: "pong", event_id: message.ping_event.event_id }));
                  }
                  break;

                default:
                  console.log(`${LOG_PREFIX} [ElevenLabs] Unhandled message type: ${message.type}`);
              }
            } catch (error) {
              console.error(`${LOG_PREFIX} [ElevenLabs] Error processing message:`, error);
            }
          });

          elevenLabsWs.on("error", (error) => {
            console.error(`${LOG_PREFIX} [ElevenLabs] WebSocket error:`, error);
          });

          elevenLabsWs.on("close", () => {
            console.log(`${LOG_PREFIX} [ElevenLabs] Disconnected`);
            if (ws?.readyState === WebSocket.OPEN) {
                ws.close();
              }
          });

        } catch (error) {
          console.error(`${LOG_PREFIX} [ElevenLabs] Setup error:`, error);
        }
      };

      ws.on("message", async (message) => {
        try {
          const msg = JSON.parse(message);

          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              sessionStartTime = Date.now();

              const customParams = msg.start.customParameters || {};
              console.log(`${LOG_PREFIX} Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
              console.log(`${LOG_PREFIX} Custom parameters received:`, Object.keys(customParams));

              // Check if this is a new-style request with session token
              if (customParams.session_token && customParams.client_id) {
                // Validate session token
                const validation = validateWebSocketToken(customParams);

                if (!validation.valid) {
                  console.error(`${LOG_PREFIX} Token validation failed: ${validation.error}`);
                  ws.close(4001, validation.error || 'Invalid token');
                  return;
                }

                sessionInfo = {
                  clientId: validation.clientId || customParams.client_id,
                  sessionId: validation.sessionId || customParams.session_id,
                  authenticated: true
                };

                credentials = {
                  elevenLabsApiKey: customParams.elevenlabs_api_key,
                  elevenLabsAgentId: customParams.elevenlabs_agent_id
                };

                console.log(`${LOG_PREFIX} Session authenticated: clientId=${sessionInfo.clientId}, sessionId=${sessionInfo.sessionId}`);

                if (!credentials.elevenLabsApiKey || !credentials.elevenLabsAgentId) {
                  console.error(`${LOG_PREFIX} Missing ElevenLabs credentials in customParameters`);
                  ws.close(4002, 'Missing ElevenLabs credentials');
                  return;
                }

                // Setup ElevenLabs with passed credentials
                const nombre = customParams.nombre;
                const items = customParams.items;
                await setupElevenLabs(credentials.elevenLabsApiKey, credentials.elevenLabsAgentId, nombre, items);

              } else if (customParams.apiKey && customParams.agentId) {
                // Legacy mode - no token validation (deprecated)
                console.warn(`${LOG_PREFIX} Legacy mode: no session token validation`);

                // Legacy credentials from query string (deprecated)
                const { apiKey, agentId, name, items } = customParams;
                await setupElevenLabs(apiKey, agentId, name, items);

              } else {
                console.error(`${LOG_PREFIX} No valid credentials in customParameters`);
                ws.close(4002, 'Missing credentials');
                return;
              }
              break;

            case "media":
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                const audioMessage = {
                  user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64")
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));
              }
              break;

            case "stop":
              console.log(`${LOG_PREFIX} Stream ${streamSid} ended`);
              await handleSessionEnd('COMPLETED');
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                elevenLabsWs.close();
              }
              break;

            default:
              console.log(`${LOG_PREFIX} Unhandled event: ${msg.event}`);
          }
        } catch (error) {
          console.error(`${LOG_PREFIX} Error processing message:`, error);
        }
      });

      ws.on("close", async () => {
        console.log(`${LOG_PREFIX} Client disconnected`);
        await handleSessionEnd('COMPLETED');
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      });
    });
  });
}