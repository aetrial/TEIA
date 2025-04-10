import WebSocket from "ws";
import pkg from 'pg';
const { Client } = pkg;

export function registerInboundRoutes(fastify) {
  // Check for the required ElevenLabs Agent ID
  // Check for the required environment variables
    let ELEVENLABS_API_KEY;
    let ELEVENLABS_AGENT_ID;

    async function initializeGlobalVariables(from) {
      const { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME } = process.env;

      if (!DB_HOST || !DB_USER || !DB_PASSWORD || !DB_NAME) {
        throw new Error("Missing required database environment variables");
      }

      const client = new Client({
        host: DB_HOST,
        user: DB_USER,
        password: DB_PASSWORD,
        database: DB_NAME,
      });

      try {
        await client.connect();

        const result = await client.query(`
                SELECT * FROM twilio_info ti
                JOIN teia_user tu ON ti.id = tu.twilio_info_id
                JOIN eleven_labs_info eli ON tu.eleven_labs_info_id = eli.id
                WHERE ti.twilio_phone_number_calls= $1
              `, [from]);

        if (result.rows.length === 0) {
          throw new Error("No configuration found in the database");
        } else {
          console.log("Configuration found:", result.rows[0]);
        }

        ELEVENLABS_API_KEY = result.rows[0].eleven_labs_api_key;
        ELEVENLABS_AGENT_ID = result.rows[0].eleven_labs_agent_id;

        console.log("Global variables initialized:", {
          ELEVENLABS_API_KEY,
          ELEVENLABS_AGENT_ID,
        });
      } catch (error) {
        console.error("Error initializing global variables:", error);
        throw error;
      } finally {
        await client.end();
      }
    }

  // Route to handle incoming calls from Twilio
  fastify.all("/incoming-call-eleven", async (request, reply) => {
    // Generate TwiML response to connect the call to a WebSocket stream
    const toField = request.body.To;
    console.log("To field:", toField);
    initializeGlobalVariables(toField);
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/media-stream" />
        </Connect>
      </Response>`;

    reply.type("text/xml").send(twimlResponse);
  });

  // WebSocket route for handling media streams from Twilio
  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get("/media-stream", { websocket: true }, (connection, req) => {
      console.info("[Server] Twilio connected to media stream.");

      let streamSid = null;

      // Connect to ElevenLabs Conversational AI WebSocket
      const elevenLabsWs = new WebSocket(
        `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}`
      );

      // Handle open event for ElevenLabs WebSocket
      elevenLabsWs.on("open", () => {
        console.log("[II] Connected to Conversational AI.");
      });

      // Handle messages from ElevenLabs
      elevenLabsWs.on("message", (data) => {
        try {
          const message = JSON.parse(data);
          handleElevenLabsMessage(message, connection);
        } catch (error) {
          console.error("[II] Error parsing message:", error);
        }
      });

      // Handle errors from ElevenLabs WebSocket
      elevenLabsWs.on("error", (error) => {
        console.error("[II] WebSocket error:", error);
      });

      // Handle close event for ElevenLabs WebSocket
      elevenLabsWs.on("close", () => {
        console.log("[II] Disconnected.");
      });

      // Function to handle messages from ElevenLabs
      const handleElevenLabsMessage = (message, connection) => {
        switch (message.type) {
          case "conversation_initiation_metadata":
            console.info("[II] Received conversation initiation metadata.");
            break;
          case "audio":
            if (message.audio_event?.audio_base_64) {
              // Send audio data to Twilio
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
            // Clear Twilio's audio queue
            connection.send(JSON.stringify({ event: "clear", streamSid }));
            break;
          case "ping":
            // Respond to ping events from ElevenLabs
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

      // Handle messages from Twilio
      connection.on("message", async (message) => {
        try {
          const data = JSON.parse(message);
          switch (data.event) {
            case "start":
              // Store Stream SID when stream starts
              streamSid = data.start.streamSid;
              console.log(`[Twilio] Stream started with ID: ${streamSid}`);
              break;
            case "media":
              // Route audio from Twilio to ElevenLabs
              if (elevenLabsWs.readyState === WebSocket.OPEN) {
                // data.media.payload is base64 encoded
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
              // Close ElevenLabs WebSocket when Twilio stream stops
              elevenLabsWs.close();
              break;
            default:
              console.log(`[Twilio] Received unhandled event: ${data.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      // Handle close event from Twilio
      connection.on("close", () => {
        elevenLabsWs.close();
        console.log("[Twilio] Client disconnected");
      });

      // Handle errors from Twilio WebSocket
      connection.on("error", (error) => {
        console.error("[Twilio] WebSocket error:", error);
        elevenLabsWs.close();
      });
    });
  });
}