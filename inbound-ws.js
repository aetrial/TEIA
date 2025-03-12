import Twilio from "twilio";
import OpenAI from "openai";
import { chat } from './services/Ia.js';
import pkg from 'pg';
const { Client } = pkg;


export function registerInboundWSRoutes(fastify) {

    const {
        TWILIO_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN,
        TWILIO_WS_PHONE_NUMBER,
        DB_HOST,
        DB_USER,
        DB_PASSWORD,
        DB_NAME
    } = process.env;

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WS_PHONE_NUMBER || !DB_HOST || !DB_USER || !DB_PASSWORD || !DB_NAME) {
        console.error("Missing required environment variables");
        throw new Error("Missing required environment variables");
    }

    const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    fastify.post("/inbound-ws", async (request, reply) => {
        console.info("[Server] Twilio connected to inbound Ws send method");

        const { from, body } = request.body;

        if (!from) {
            return reply.code(400).send({ error: "Phone number is required" });
        }

        if (!body) {
            return reply.code(400).send({ error: "Variables are required" });
        }

        try {
            const client = new Client({
                host: DB_HOST,
                user: DB_USER,
                password: DB_PASSWORD,
                database: DB_NAME
            });
            await client.connect();

            const res = await client.query('SELECT * FROM threads WHERE phone_number = $1', [from]);

            let thread = null;
            if (res.rows.length > 0) {
                thread = res.rows[0].thread_id; // Assuming thread_id is the column name
            }
            const response = await chat(body, thread); // Call the chat function with or without thread
            const replyMessage = response.response || "Sorry, no response from Agent";
            if (res.rows.length === 0) {
                // Create a new thread entry if not found
                const insertQuery = 'INSERT INTO threads (phone_number, thread_id) VALUES ($1, $2)';
                await client.query(insertQuery, [from, response.thread.id]);
                thread = response.thread.id;
            }

            const message = await twilioClient.messages.create({
                body: replyMessage,
                from: "whatsapp:" + TWILIO_WS_PHONE_NUMBER,
                to: "whatsapp:" + from
            });

            console.log(message.sid);
            await client.end();
            return reply.send({ success: true });
        } catch (error) {
            console.error("Error initiating outbound ws:", error);
            reply.code(500).send({
                success: false,
                error: "Failed to initiate WhatsApp message conversation"
            });
        }
    });
}