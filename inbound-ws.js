import Twilio from "twilio";
const OpenAI = require('openai');

export function registerInboundWSRoutes(fastify) {
    const {
        TWILIO_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN,
        TWILIO_WS_PHONE_NUMBER
        OPENAI_API_KEY
    } = process.env;

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WS_PHONE_NUMBER || !OPENAI_API_KEY) {
        console.error("Missing required environment variables");
        throw new Error("Missing required environment variables");
    }

    const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    fastify.post("/inbound-ws", async (request, reply) => {
        console.info("[Server] Twilio connected to inbound Ws send method");
        console.info("[Server] Request body:", request.body);
    }
    /*
        const { number, body} = request.body;

        console.info("[Server] Twilio connected to inbound Ws send method");

        if (!number) {
            return reply.code(400).send({ error: "Phone number is required" });
        }

        if (!variables) {
            return reply.code(400).send({ error: "Variables are required" });
        }

        if (!templateId) {
            return reply.code(400).send({ error: "Template is required" });
        }

        try {
            console.info("[Server] Sending initial conversation WS message to whatsapp:", number);
            console.info("[Server] Template ID:", templateId);
            console.info("[Server] Variables:", variables);
            console.info("[Server] Twilio phone number whatsapp:", TWILIO_WS_PHONE_NUMBER);
            const message = await twilioClient.messages.create({
                from: "whatsapp:" + TWILIO_WS_PHONE_NUMBER,
                contentSid: templateId,
                contentVariables: variables,
                to: "whatsapp:" + number
            });

            console.log(message.sid);
            return reply.send({ success: true });
        } catch (error) {
            console.error("Error initiating outbound ws:", error);
            reply.code(500).send({
                success: false,
                error: "Failed to initiate WhatsApp message conversation"
            });
        }
    });
    */
}