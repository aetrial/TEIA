import Twilio from "twilio";
import pool from './services/db.js';
import { reportSessionComplete } from './services/session-complete.js';

const LOG_PREFIX = '[OutboundWS]';

export function registerOutboundWSRoutes(fastify) {

    /**
     * Internal endpoint - receives forwarded outbound WhatsApp requests from TEIA-users.
     * Authenticated via internal HMAC headers (handled by internalAuthHook).
     *
     * All credentials are passed in the request body from TEIA-users.
     */
    fastify.post("/internal/outbound-ws", async (request, reply) => {
        const {
            sessionId,
            clientId,
            to,
            variables,
            templateId,
            // Decrypted credentials from TEIA-users
            twilioAccountSid,
            twilioAuthToken,
            twilioWhatsappNumber
        } = request.body;

        console.log(`${LOG_PREFIX} Processing outbound template: sessionId=${sessionId}, clientId=${clientId}, to=${to}`);

        if (!sessionId || !clientId) {
            return reply.code(400).send({ error: "Missing required session fields" });
        }

        if (!to) {
            return reply.code(400).send({ error: "To phone number is required" });
        }

        if (!variables) {
            return reply.code(400).send({ error: "Variables are required" });
        }

        if (!templateId) {
            return reply.code(400).send({ error: "Template is required" });
        }

        if (!twilioAccountSid || !twilioAuthToken) {
            return reply.code(400).send({ error: "Missing Twilio credentials" });
        }

        if (!twilioWhatsappNumber) {
            return reply.code(400).send({ error: "Missing Twilio WhatsApp number" });
        }

        try {
            const twilioClient = new Twilio(twilioAccountSid, twilioAuthToken);

            console.log(`${LOG_PREFIX} Sending template message: templateId=${templateId}, to=${to}`);

            const message = await twilioClient.messages.create({
                from: "whatsapp:" + twilioWhatsappNumber,
                contentSid: templateId,
                contentVariables: typeof variables === 'string' ? variables : JSON.stringify(variables),
                to: "whatsapp:" + to.replace("whatsapp:", "")
            });

            console.log(`${LOG_PREFIX} Message sent: messageSid=${message.sid}`);

            // Report session completion (fire-and-forget)
            reportSessionComplete({
                clientId,
                sessionId,
                type: 'MESSAGE',
                actualDurationSeconds: null,
                status: 'COMPLETED'
            });

            return reply.send({ success: true, messageSid: message.sid });

        } catch (error) {
            console.error(`${LOG_PREFIX} Error sending template: ${error.message}`);

            // Report session failure (fire-and-forget)
            reportSessionComplete({
                clientId,
                sessionId,
                type: 'MESSAGE',
                actualDurationSeconds: null,
                status: 'FAILED'
            });

            return reply.code(500).send({
                success: false,
                error: "Failed to send WhatsApp template message"
            });
        }
    });

    /**
     * Legacy endpoint - direct API call.
     * DEPRECATED: Traffic should flow through TEIA-users first.
     */
    fastify.post("/outbound-ws", async (request, reply) => {
        console.warn("[DEPRECATED] /outbound-ws bypasses TEIA-users and will be removed. Migrate to the internal API flow.");

        const { from, to, variables, templateId } = request.body;

        console.info("[Server] Twilio connected to outbound Ws send method");

        if (!from) {
            return reply.code(400).send({ error: "From phone number is required" });
        }

        if (!to) {
            return reply.code(400).send({ error: "To phone number is required" });
        }

        if (!variables) {
            return reply.code(400).send({ error: "Variables are required" });
        }

        if (!templateId) {
            return reply.code(400).send({ error: "Template is required" });
        }

        let client;
        try {
            client = await pool.connect();

             const fromPhoneNumber = from.replace("whatsapp:", "");

             const twilioInfoRes = await client.query(`
                   SELECT * FROM twilio_info ti WHERE ti.twilio_phone_number_whatsapp = $1
                   `, [fromPhoneNumber]);

             if (twilioInfoRes.rows.length === 0) {
                   throw new Error("Twilio information not found for the given phone number");
             }

             const twilioInfo = twilioInfoRes.rows[0];
             console.log("Twilio info:", twilioInfo);

             const { twilio_acc_sid: TWILIO_ACCOUNT_SID, twilio_auth_token: TWILIO_AUTH_TOKEN, twilio_phone_number_whatsapp: TWILIO_WS_PHONE_NUMBER } = twilioInfo;

             const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

            console.info("[Server] Sending initial conversation WS message to whatsapp:", to);
            console.info("[Server] Template ID:", templateId);
            console.info("[Server] Variables:", variables);
            console.info("[Server] Twilio phone number whatsapp:", TWILIO_WS_PHONE_NUMBER);
            const message = await twilioClient.messages.create({
                from: "whatsapp:" + TWILIO_WS_PHONE_NUMBER,
                contentSid: templateId,
                contentVariables: variables,
                to: "whatsapp:" + to
            });

            console.log(message.sid);
            return reply.send({ success: true });
        } catch (error) {
            console.error("Error initiating outbound ws:", error);
            reply.code(500).send({
                success: false,
                error: "Failed to initiate WhatsApp message conversation"
            });
        } finally {
                if (client) {
                    client.release(); // Ensure the connection is released
                }
        }
    });
}