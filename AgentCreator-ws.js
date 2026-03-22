import OpenAI from "openai";
import pool from './services/db.js';

const LOG_PREFIX = '[AgentCreator]';

export function registerAgentWS(fastify) {

    /**
     * Internal endpoint - receives agent creation requests from TEIA-users.
     * Authenticated via internal HMAC headers (handled by internalAuthHook).
     *
     * Creates an OpenAI Assistant and returns the ID.
     * TEIA-users handles storing the assistant ID in the database.
     */
    fastify.post("/internal/agent", async (request, reply) => {
        const {
            clientId,
            openAiApiKey,
            name,
            instructions,
            tools,
            model
        } = request.body;

        console.log(`${LOG_PREFIX} Creating agent: clientId=${clientId}, name=${name}`);

        if (!clientId) {
            return reply.code(400).send({ error: "clientId is required" });
        }

        if (!openAiApiKey) {
            return reply.code(400).send({ error: "openAiApiKey is required" });
        }

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

        try {
            const openai = new OpenAI({ apiKey: openAiApiKey });

            console.log(`${LOG_PREFIX} Creating OpenAI assistant: name=${name}, model=${model}`);

            const assistant = await openai.beta.assistants.create({
                name: name,
                instructions: instructions,
                tools: tools,
                model: model
            });

            console.log(`${LOG_PREFIX} Assistant created: assistantId=${assistant.id}`);

            // Return the assistant ID - TEIA-users will store it
            return reply.send({
                success: true,
                assistantId: assistant.id,
                clientId: clientId
            });

        } catch (error) {
            console.error(`${LOG_PREFIX} Error creating assistant: ${error.message}`);
            reply.code(500).send({
                success: false,
                error: "Failed to create OpenAI assistant",
                details: error.message
            });
        }
    });

    /**
     * Legacy endpoint - direct API call.
     * DEPRECATED: Agent creation should flow through TEIA-users first.
     */
    fastify.post("/agent-ws", async (request, reply) => {
        console.warn("[DEPRECATED] /agent-ws bypasses TEIA-users and will be removed. Migrate to the internal API flow.");
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

        let client;
        try {
            client = await pool.connect();

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
            const { open_ai_api_key: OPENAI_API_KEY } = openAiInfo;

            const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

            const assistant = await openai.beta.assistants.create({
                    name: name,
                    instructions: instructions,
                    tools: tools,
                    model: model
                  });

            console.log("Assistant created:", assistant);

            const updateQuery = `
                UPDATE open_ai_info
                SET open_ai_assistant_key = $1
                WHERE id = (
                    SELECT oai.id
                    FROM open_ai_info oai
                    JOIN teia_user tu ON tu.open_ai_info_id = oai.id
                    JOIN twilio_info ti ON tu.twilio_info_id = ti.id
                    WHERE ti.twilio_phone_number_whatsapp = $2
                )
            `;

            await client.query(updateQuery, [assistant.id, agentPhoneNumber]);

            return reply.send({ success: true, assistantId: assistant.id });
        } catch (error) {
                    console.error("Error initiating outbound ws:", error);
                    reply.code(500).send({
                        success: false,
                        error: "Failed to initiate WhatsApp message conversation"
                    });
        } finally {
            if (client) {
                client.release();
            }
        }
    });
}
