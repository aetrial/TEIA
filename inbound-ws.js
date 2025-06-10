import Twilio from "twilio";
import { chat } from './services/Ia.js';
import pool from './services/db.js'; // Import the shared pool
import dotenv from 'dotenv';
dotenv.config();

// Map to store messages and their timers
const messageQueue = new Map();

export function registerInboundWSRoutes(fastify) {
    fastify.post("/inbound-ws", async (request, reply) => {
        const { From: from, Body: body, To: to } = request.body;

        if (!from || !body || !to) {
            return reply.code(400).send({ error: "Missing required fields" });
        }

        if (!messageQueue.has(from)) {
            // Initialize a new entry for this sender
            messageQueue.set(from, { messages: body, timer: null });

            // Set a timer to process the messages after 10 seconds
            messageQueue.get(from).timer = setTimeout(async () => {
                const { messages } = messageQueue.get(from);
                messageQueue.delete(from); // Clean up the queue
                await processMessages(from, messages, to, reply);
            }, 10000);
        } else {
            // Concatenate the new message with the existing ones
            const entry = messageQueue.get(from);
            entry.messages += ` ${body}`;
        }

        reply.send({ success: true, message: "Message queued for processing" });
    });
}

async function processMessages(from, messages, to, reply) {
    let client;
    try {
        client = await pool.connect(); // Acquire the connection

        const toPhoneNumber = to.replace("whatsapp:", "");

        const twilioInfoRes = await client.query(`
            SELECT * FROM twilio_info ti WHERE ti.twilio_phone_number_whatsapp = $1
        `, [toPhoneNumber]);

        if (twilioInfoRes.rows.length === 0) {
            throw new Error("Twilio information not found for the given phone number");
        }

        const twilioInfo = twilioInfoRes.rows[0];
        const { id: TWILIO_ID, twilio_acc_sid: TWILIO_ACCOUNT_SID, twilio_auth_token: TWILIO_AUTH_TOKEN, twilio_phone_number_whatsapp: TWILIO_WS_PHONE_NUMBER } = twilioInfo;

        const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

        const res = await client.query('SELECT * FROM threads WHERE to_phone_number = $1 AND from_phone_number = $2', [to, from]);

        let thread = null;
        if (res.rows.length > 0) {
            thread = res.rows[0].thread_id;
        }
        const response = await chat(messages, thread, TWILIO_ID);
        const replyMessage = response.response || "Sorry, no response from Agent";

        if (res.rows.length === 0) {
            const insertQuery = 'INSERT INTO threads (to_phone_number, from_phone_number, thread_id) VALUES ($1, $2, $3)';
            await client.query(insertQuery, [to, from, response.thread]);
            thread = response.thread;
        }

        await twilioClient.messages.create({
            body: replyMessage,
            from: "whatsapp:" + TWILIO_WS_PHONE_NUMBER,
            to: from
        });

        console.log("Messages processed and response sent");
    } catch (error) {
        console.error("Error processing messages:", error);
        reply.code(500).send({
            success: false,
            error: "Failed to process messages"
        });
    } finally {
        if (client) {
            client.release(); // Ensure the connection is released
        }
    }
}