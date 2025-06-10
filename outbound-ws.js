import Twilio from "twilio";
import pool from './services/db.js'; // Import the shared pool

export function registerOutboundWSRoutes(fastify) {


    //const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    fastify.post("/outbound-ws", async (request, reply) => {
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

        try {
            const client = await pool.connect();

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