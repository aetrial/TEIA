import Twilio from "twilio";
import OpenAI from "openai";
import { chat } from './services/Ia.js';
import pkg from 'pg';
const { Client } = pkg;


export function registerInboundWSRoutes(fastify) {

    const {
        DB_HOST,
        DB_USER,
        DB_PASSWORD,
        DB_NAME
    } = process.env;

    if (!DB_HOST || !DB_USER || !DB_PASSWORD || !DB_NAME) {
        console.error("Missing required environment variables");
        throw new Error("Missing required environment variables");
    }

    fastify.post("/inbound-ws", async (request, reply) => {
        console.info("[Server] Twilio connected to inbound Ws send method");

        console.info("[Server] Request body:", request.body);
        const { From: from, Body: body, To: to } = request.body;

        if (!from) {
            return reply.code(400).send({ error: "Phone number is required" });
        }

        if (!body) {
            return reply.code(400).send({ error: "Body is required" });
        }

        if (!to) {
            return reply.code(400).send({ error: "To phone number is required" });
        }

        console.log("From:", from);
        console.log("Body:", body);
        console.log("To:", to);

        try {
            const client = new Client({
                host: DB_HOST,
                user: DB_USER,
                password: DB_PASSWORD,
                database: DB_NAME
            });
            await client.connect();

            const toPhoneNumber = to.replace("whatsapp:", "");

            const twilioInfoRes = await client.query(`
                SELECT * FROM twilio_info ti WHERE ti.twilio_phone_number_whatsapp = $1
                `, [toPhoneNumber]);

            if (twilioInfoRes.rows.length === 0) {
               throw new Error("Twilio information not found for the given phone number");
            }

            const twilioInfo = twilioInfoRes.rows[0];
            console.log("Twilio info:", twilioInfo);

            const { id: TWILIO_ID, twilio_acc_sid: TWILIO_ACCOUNT_SID, twilio_auth_token: TWILIO_AUTH_TOKEN, twilio_phone_number_whatsapp: TWILIO_WS_PHONE_NUMBER } = twilioInfo;

            const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

            console.info("[Server] Twilio client created");

            const res = await client.query('SELECT * FROM threads WHERE to_phone_number = $1 AND from_phone_number = $2', [to, from]);

            let thread = null;
            if (res.rows.length > 0) {
                thread = res.rows[0].thread_id;
            }
            const response = await chat(body, thread, TWILIO_ID); // Call the chat function with or without thread
            const replyMessage = response.response || "Sorry, no response from Agent";
            if (res.rows.length === 0) {
                // Create a new thread entry if not found
                const insertQuery = 'INSERT INTO threads (to_phone_number, from_phone_number, thread_id) VALUES ($1, $2, $3)';
                await client.query(insertQuery, [to, from, response.thread]);
                thread = response.thread;
            }

            const message = await twilioClient.messages.create({
                body: replyMessage,
                from: "whatsapp:" + TWILIO_WS_PHONE_NUMBER,
                to: from
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