import OpenAI from "openai";
import pkg from 'pg';
const { Client } = pkg;

export const chat = async (question, thread = null, twilioId) => {
    try {

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
                    WHERE ti.id = $1
                `;
        const res = await client.query(query, [twilioId]);

        if (res.rows.length === 0) {
            throw new Error("OpenAI information not found for the given Twilio ID");
        }

        const openAiInfo = res.rows[0];
        console.log("OpenAI Info:", openAiInfo);
        const { open_ai_api_key: OPENAI_API_KEY, open_ai_assistant_key: OPENAI_ASSISTANT_KEY } = openAiInfo;

        const openaiApiKey = OPENAI_API_KEY;
        const assistant = OPENAI_ASSISTANT_KEY;

        const openai = new OpenAI({ apiKey: openaiApiKey });
        thread = thread || (await openai.beta.threads.create()).id;

        // Crear el mensaje del usuario en el hilo
        await openai.beta.threads.messages.create(thread, {
            role: "user",
            content: question
        });

        // Crear y ejecutar la corrida del asistente
        const run = await openai.beta.threads.runs.createAndPoll(thread, {
            assistant_id: assistant,
            instructions: "El nombre de este usuario es desconocido"
        });

        // Si la corrida se completa, obtén la lista de mensajes y la última respuesta del asistente
        if (run.status === 'completed') {
            const messages = await openai.beta.threads.messages.list(run.thread_id);
            for (const message of messages.data.reverse()) {
                console.log(`Mensaje GS: ${message.role} > ${message.content[0].text.value}`);
            }
            const assistantResponse = messages.data
                .filter(message => message.role === 'assistant')
                .pop(); // Obtiene el último mensaje del asistente

            // Devuelve el thread y la última respuesta del asistente (si existe)
            const answer = assistantResponse ? assistantResponse.content[0].text.value : null
            //const cleanAnswer = answer.replace(/【\d+:\d+†source】/g, '');
            return {
                thread,
                response: answer
            };
        }

        // Si el run no se completó, devolver solo el thread
        return { thread, response: null };

    } catch (err) {
        console.error("Error al conectar con OpenAI:", err);
        return { thread, response: "ERROR" };
    }
};
