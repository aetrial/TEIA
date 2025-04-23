import Twilio from "twilio";
import OpenAI from "openai";
import { chat } from './services/Ia.js';
import pkg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
const { Pool } = pkg;

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

// Crear un pool de conexiones
const pool = new Pool({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    max: 20, // Número máximo de conexiones en el pool
    idleTimeoutMillis: 30000, // Tiempo de espera antes de cerrar conexiones inactivas
    connectionTimeoutMillis: 2000 // Tiempo de espera para obtener una conexión
});

export function registerInboundWSRoutes(fastify) {
    fastify.post("/inbound-ws", async (request, reply) => {
        console.info("[Server] Twilio connected to inbound Ws send method");

        console.info("[Server] Request body:", request.body);
        const { From: from, Body: body, To: to } = request.body;

        if (!from || !body || !to) {
            return reply.code(400).send({ error: "Missing required fields" });
        }

        console.log("From:", from);
        console.log("Body:", body);
        console.log("To:", to);

        const client = await pool.connect(); // Obtener una conexión del pool
        try {
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
                console.log("Thread ID found:", thread);
            }
            const response = await chat(body, thread, TWILIO_ID);
            const replyMessage = response.response || "Sorry, no response from Agent";

            if (res.rows.length === 0) {
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
            return reply.send({ success: true });
        } catch (error) {
            console.error("Error initiating inbound ws:", error);
            reply.code(500).send({
                success: false,
                error: "Failed to initiate WhatsApp message conversation"
            });
        } finally {
            client.release(); // Liberar la conexión al pool
        }
    });
}