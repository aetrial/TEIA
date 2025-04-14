import WebSocket from "ws";
import pkg from 'pg';
import OpenAI from "openai";
const { Client } = pkg;

export function registerAgentWS(fastify) {

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

    fastify.post("/agent-ws", async (request, reply) => {
        console.info("[Server] Request body:", request.body);
        const { name, instructions, tools, model, agentPhoneNumber} = request.body;

        if (!name) {
            return reply.code(400).send({ error: "name is required" });
        }

        if (!instructions) {
            return reply.code(400).send({ error: "instructions are required" });
        }

        if (!tools) {
            return reply.code(400).send({ error: "tools are required" });
        }

        if (!model) {
            return reply.code(400).send({ error: "model is required" });
        }

        if (!agentPhoneNumber) {
            return reply.code(400).send({ error: "agentPhoneNumber is required" });
        }

        console.log("name:", name);
        console.log("instructions:", instructions);
        console.log("tools:", tools);
        console.log("model:", model);
        console.log("agentPhoneNumber:", agentPhoneNumber);

        try {
            const client = new Client({
            host: DB_HOST,
            user: DB_USER,
            password: DB_PASSWORD,
            database: DB_NAME
            });

            await client.connect();

            const query = `
                                SELECT * FROM open_ai_info oai
                                JOIN teia_user tu ON tu.open_ai_info_id = oai.id
                                JOIN twilio_info ti ON tu.twilio_info_id = ti.id
                                WHERE ti.twilio_phone_number_whatsapp = $1
                            `;
            const res = await client.query(query, [agentPhoneNumber]);

            if (res.rows.length === 0) {
                throw new Error("OpenAI information not found for the given agentPhoneNumber");
            }

            const openAiInfo = res.rows[0];
            console.log("OpenAI Info:", openAiInfo);
            const { open_ai_api_key: OPENAI_API_KEY, open_ai_assistant_key: OPENAI_ASSISTANT_KEY } = openAiInfo;

            const openaiApiKey = OPENAI_API_KEY;

            const openai = new OpenAI({ apiKey: openaiApiKey });

            const assistant = await openai.beta.assistants.create({
                    name: name,
                    instructions: instructions,
                    tools: tools,
                    model: model
                  });


            console.log("Assistant created:", assistant);

            const updateQuery = `
                UPDATE open_ai_info
                SET open_ai_assistant_key = '${assistant.id}'
                WHERE id = (
                    SELECT oai.id
                    FROM open_ai_info oai
                    JOIN teia_user tu ON tu.open_ai_info_id = oai.id
                    JOIN twilio_info ti ON tu.twilio_info_id = ti.id
                    WHERE ti.twilio_phone_number_whatsapp = '${agentPhoneNumber}'
                )
            `;

            await client.query(updateQuery);

        } catch (error) {
                    console.error("Error initiating outbound ws:", error);
                    reply.code(500).send({
                        success: false,
                        error: "Failed to initiate WhatsApp message conversation"
                    });
        }
    });
}