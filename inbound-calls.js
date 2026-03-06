import dotenv from "dotenv";
import WebSocket from "ws";
import pool from './services/db.js'; // Import the shared pool

// Load environment variables
dotenv.config();

function validatePassword(password) {
  if (typeof password !== "string" || password.trim() === "") {
    throw new Error("DB_PASSWORD must be a non-empty string");
  }
  return password;
}

export function registerInboundRoutes(fastify) {
  let ELEVENLABS_API_KEY;
  let ELEVENLABS_AGENT_ID;

  async function initializeGlobalVariables(from) {
    let client;
    try {
      client = await pool.connect();

      const result = await client.query(`
        SELECT * FROM twilio_info ti
        JOIN teia_user tu ON ti.id = tu.twilio_info_id
        JOIN eleven_labs_info eli ON tu.eleven_labs_info_id = eli.id
        WHERE ti.twilio_phone_number_calls = $1
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
      if (client) {
        client.release(); // Ensure the connection is released
      }
    }
  }

  fastify.all("/incoming-call-eleven", async (request, reply) => {
    const toField = request.body.To;
    console.log("To field:", toField);
    await initializeGlobalVariables(toField);

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/media-stream" />
        </Connect>
      </Response>`;

    reply.type("text/xml").send(twimlResponse);
  });

  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get("/media-stream", { websocket: true }, (connection, req) => {
      console.info("[Server] Twilio connected to media stream.");

      let streamSid = null;

      const elevenLabsWs = new WebSocket(
        `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}`
      );

      elevenLabsWs.on("open", () => {
        console.log("[II] Connected to Conversational AI.");
      });

      elevenLabsWs.on("message", (data) => {
        try {
          const message = JSON.parse(data);
          handleElevenLabsMessage(message, connection);
        } catch (error) {
          console.error("[II] Error parsing message:", error);
        }
      });

      elevenLabsWs.on("error", (error) => {
        console.error("[II] WebSocket error:", error);
      });

      elevenLabsWs.on("close", () => {
        console.log("[II] Disconnected.");
      });

      const handleElevenLabsMessage = (message, connection) => {
        switch (message.type) {
          case "conversation_initiation_metadata":
            console.info("[II] Received conversation initiation metadata.");
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

      connection.on("message", async (message) => {
        try {
          const data = JSON.parse(message);
          switch (data.event) {
            case "start":
              streamSid = data.start.streamSid;
              console.log(`[Twilio] Stream started with ID: ${streamSid}`);
              break;
            case "media":
              if (elevenLabsWs.readyState === WebSocket.OPEN) {
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
              elevenLabsWs.close();
              break;
            default:
              console.log(`[Twilio] Received unhandled event: ${data.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      connection.on("close", () => {
        elevenLabsWs.close();
        console.log("[Twilio] Client disconnected");
      });

      connection.on("error", (error) => {
        console.error("[Twilio] WebSocket error:", error);
        elevenLabsWs.close();
      });
    });
  });
}