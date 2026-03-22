import Twilio from "twilio";
import { chat } from './services/Ia.js';
import pool from './services/db.js';
import { reportSessionComplete } from './services/session-complete.js';
import dotenv from 'dotenv';
dotenv.config();

const LOG_PREFIX = '[InboundWS]';

// Map to store messages and their timers for batching
const messageQueue = new Map();

export function registerInboundWSRoutes(fastify) {

  /**
   * Internal endpoint - receives forwarded messages from TEIA-users.
   * Authenticated via internal HMAC headers (handled by internalAuthHook).
   *
   * All credentials are passed in the request body from TEIA-users.
   */
  fastify.post("/internal/message", async (request, reply) => {
    const {
      sessionId,
      clientId,
      from,
      to,
      body,
      // Decrypted credentials from TEIA-users
      twilioAccountSid,
      twilioAuthToken,
      twilioWhatsappNumber,
      openAiApiKey,
      openAiAssistantId,
      // Optional Cal.com credentials for scheduling
      calApiKey,
      calUserId,
      calEventId
    } = request.body;

    console.log(`${LOG_PREFIX} Processing message: sessionId=${sessionId}, clientId=${clientId}, from=${from}`);

    if (!sessionId || !clientId || !from || !body) {
      return reply.code(400).send({ error: "Missing required fields" });
    }

    if (!twilioAccountSid || !twilioAuthToken) {
      return reply.code(400).send({ error: "Missing Twilio credentials" });
    }

    if (!openAiApiKey || !openAiAssistantId) {
      return reply.code(400).send({ error: "Missing OpenAI credentials" });
    }

    try {
      // Create Twilio client with provided credentials
      const twilioClient = new Twilio(twilioAccountSid, twilioAuthToken);

      // Get or create thread for this conversation
      let dbClient;
      try {
        dbClient = await pool.connect();
        const res = await dbClient.query(
          'SELECT * FROM threads WHERE to_phone_number = $1 AND from_phone_number = $2',
          [to, from]
        );

        let thread = res.rows.length > 0 ? res.rows[0].thread_id : null;

        // Process message through AI with provided credentials
        const credentials = {
          openAiApiKey,
          openAiAssistantId,
          calApiKey,
          calUserId,
          calEventId
        };

        const response = await chat(body, thread, credentials);
        const replyMessage = response.response || "Sorry, no response from Agent";

        // Save new thread if created
        if (res.rows.length === 0 && response.thread) {
          await dbClient.query(
            'INSERT INTO threads (to_phone_number, from_phone_number, thread_id) VALUES ($1, $2, $3)',
            [to, from, response.thread]
          );
        }

        // Send reply via Twilio
        const fromNumber = to.startsWith('whatsapp:') ? to : `whatsapp:${twilioWhatsappNumber}`;
        await twilioClient.messages.create({
          body: replyMessage,
          from: fromNumber,
          to: from
        });

        console.log(`${LOG_PREFIX} Message processed and reply sent for session ${sessionId}`);

        // Report session completion (fire-and-forget)
        reportSessionComplete({
          clientId,
          sessionId,
          type: 'MESSAGE',
          actualDurationSeconds: null,
          status: 'COMPLETED'
        });

        // Return empty TwiML (Twilio expects XML for webhook responses)
        return reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

      } finally {
        if (dbClient) {
          dbClient.release();
        }
      }

    } catch (error) {
      console.error(`${LOG_PREFIX} Error processing message: ${error.message}`);

      // Report session failure (fire-and-forget)
      reportSessionComplete({
        clientId,
        sessionId,
        type: 'MESSAGE',
        actualDurationSeconds: null,
        status: 'FAILED'
      });

      return reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
  });

  /**
   * Legacy endpoint - direct Twilio webhook.
   * DEPRECATED: Traffic should flow through TEIA-users first.
   */
  fastify.post("/inbound-ws", async (request, reply) => {
    console.warn("[DEPRECATED] /inbound-ws bypasses TEIA-users and will be removed. Migrate to the internal API flow.");

    const { From: from, Body: body, To: to } = request.body;

    if (!from || !body || !to) {
      return reply.code(400).send({ error: "Missing required fields" });
    }

    // Legacy batching logic - kept for backward compatibility
    if (!messageQueue.has(from)) {
      messageQueue.set(from, { messages: body, timer: null });

      messageQueue.get(from).timer = setTimeout(async () => {
        const { messages } = messageQueue.get(from);
        messageQueue.delete(from);
        await processMessagesLegacy(from, messages, to, reply);
      }, 10000);
    } else {
      const entry = messageQueue.get(from);
      entry.messages += ` ${body}`;
    }

    reply.send({ success: true, message: "Message queued for processing" });
  });
}

/**
 * Legacy message processing - queries DB for credentials.
 * DEPRECATED: Use /internal/message which receives credentials from TEIA-users.
 */
async function processMessagesLegacy(from, messages, to, reply) {
  console.warn("[DEPRECATED] processMessagesLegacy() queries DB for credentials. This will be removed.");

  let client;
  try {
    client = await pool.connect();

    const toPhoneNumber = to.replace("whatsapp:", "");

    const twilioInfoRes = await client.query(`
      SELECT * FROM twilio_info ti WHERE ti.twilio_phone_number_whatsapp = $1
    `, [toPhoneNumber]);

    if (twilioInfoRes.rows.length === 0) {
      throw new Error("Twilio information not found for the given phone number");
    }

    const twilioInfo = twilioInfoRes.rows[0];
    const { id: TWILIO_ID, twilio_acc_sid, twilio_auth_token, twilio_phone_number_whatsapp } = twilioInfo;

    // Get OpenAI credentials
    const openAiRes = await client.query(`
      SELECT oai.open_ai_api_key, oai.open_ai_assistant_key
      FROM open_ai_info oai
      JOIN teia_user tu ON tu.open_ai_info_id = oai.id
      JOIN twilio_info ti ON tu.twilio_info_id = ti.id
      WHERE ti.id = $1
    `, [TWILIO_ID]);

    if (openAiRes.rows.length === 0) {
      throw new Error("OpenAI information not found");
    }

    const { open_ai_api_key, open_ai_assistant_key } = openAiRes.rows[0];

    const twilioClient = new Twilio(twilio_acc_sid, twilio_auth_token);

    const res = await client.query(
      'SELECT * FROM threads WHERE to_phone_number = $1 AND from_phone_number = $2',
      [to, from]
    );

    let thread = res.rows.length > 0 ? res.rows[0].thread_id : null;

    // Use new credential-based chat function
    const credentials = {
      openAiApiKey: open_ai_api_key,
      openAiAssistantId: open_ai_assistant_key
    };

    const response = await chat(messages, thread, credentials);
    const replyMessage = response.response || "Sorry, no response from Agent";

    if (res.rows.length === 0 && response.thread) {
      await client.query(
        'INSERT INTO threads (to_phone_number, from_phone_number, thread_id) VALUES ($1, $2, $3)',
        [to, from, response.thread]
      );
    }

    await twilioClient.messages.create({
      body: replyMessage,
      from: "whatsapp:" + twilio_phone_number_whatsapp,
      to: from
    });

    console.log("Legacy message processed and response sent");

  } catch (error) {
    console.error("Error processing messages:", error);
    if (reply && !reply.sent) {
      reply.code(500).send({
        success: false,
        error: "Failed to process messages"
      });
    }
  } finally {
    if (client) {
      client.release();
    }
  }
}
