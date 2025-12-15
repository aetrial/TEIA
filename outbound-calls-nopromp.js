import WebSocket from "ws";
import Twilio from "twilio";
import pool from './services/db.js'; // Import the shared pool

export function registerOutboundRoutesNp(fastify) {

  async function getSignedUrl(apiKey, agentId) {
    try {
      console.log('getSignedUrl apiKey:', apiKey);
      console.log('getSignedUrl agentId:', agentId);
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
      console.error("Error getting signed URL:", error);
      throw error;
    }
  }

  fastify.post("/outbound-call-np", async (request, reply) => {
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

  fastify.all("/outbound-call-twiml-np", async (request, reply) => {
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
      console.info("[Server] Twilio connected to outbound media stream");

      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;

      ws.on('error', console.error);

      const setupElevenLabs = async (apiKey, agentId, name, items) => {
        try {
          const signedUrl = await getSignedUrl(apiKey, agentId);
          elevenLabsWs = new WebSocket(signedUrl);

          const decodedNombre = decodeURIComponent(name);
          const decodedItems = decodeURIComponent(items);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");
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
                  console.log("[ElevenLabs] Received initiation metadata");
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
                    console.log("[ElevenLabs] Received audio but no StreamSid yet");
                  }
                  break;

                case "agent_tool_response":
                  // Detect and close on end_call tool execution
                  if (message.agent_tool_response?.tool_name === "end_call") {
                    console.log("[ElevenLabs] Received end_call tool response — closing connections.");
                    try {
                      if (ws?.readyState === WebSocket.OPEN) {
                        console.log("[Integrator] Closing Twilio WebSocket.");
                        ws.close();
                      }
                      if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                        console.log("[Integrator] Closing ElevenLabs WebSocket.");
                        elevenLabsWs.close();
                      }
                    } catch (err) {
                      console.error("[Integrator] Error while closing sockets:", err);
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
                  console.log(`[ElevenLabs] Unhandled message type: ${message.type}`);
              }
            } catch (error) {
              console.error("[ElevenLabs] Error processing message:", error);
            }
          });

          elevenLabsWs.on("error", (error) => {
            console.error("[ElevenLabs] WebSocket error:", error);
          });

          elevenLabsWs.on("close", () => {
            console.log("[ElevenLabs] Disconnected");
            if (ws?.readyState === WebSocket.OPEN) {
                ws.close();
              }
          });

        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
        }
      };

      ws.on("message", (message) => {
        try {
          const msg = JSON.parse(message);

          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              const { apiKey, agentId , name, items} = msg.start.customParameters;
              console.log('msg.start object', msg.start);
              console.log(`[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
              setupElevenLabs(apiKey, agentId, name, items);
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
              console.log(`[Twilio] Stream ${streamSid} ended`);
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                elevenLabsWs.close();
              }
              break;

            default:
              console.log(`[Twilio] Unhandled event: ${msg.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      ws.on("close", () => {
        console.log("[Twilio] Client disconnected");
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      });
    });
  });
}