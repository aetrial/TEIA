import OpenAI from "openai";

export const chat = async (question, thread = null) => {
    try {

        const {
                OPENAI_ASSISTANT_KEY,
                OPENAI_API_KEY
            } = process.env;

        if (!OPENAI_ASSISTANT_KEY || !OPENAI_API_KEY) {
                console.error("Missing required environment variables");
                throw new Error("Missing required environment variables");
            }

        const openaiApiKey = OPENAI_API_KEY;
        const assistant = OPENAI_ASSISTANT_KEY;

        const openai = new OpenAI({ apiKey: openaiApiKey });
        thread = thread || await openai.beta.threads.create();

        // Crear el mensaje del usuario en el hilo
        await openai.beta.threads.messages.create(thread.id, {
            role: "user",
            content: question
        });

        // Crear y ejecutar la corrida del asistente
        const run = await openai.beta.threads.runs.createAndPoll(thread.id, {
            assistant_id: assistant,
            instructions: "El nombre de este usuario es desconocido"
        });

        // Si la corrida se completa, obtén la lista de mensajes y la última respuesta del asistente
        if (run.status === 'completed') {
            const messages = await openai.beta.threads.messages.list(run.thread_id);
            //for (const message of messages.data.reverse()) {
            //    console.log(`Mensaje GS: ${message.role} > ${message.content[0].text.value}`);
            //}
            const assistantResponse = messages.data
                .filter(message => message.role === 'assistant')
                .pop(); // Obtiene el último mensaje del asistente

            // Devuelve el thread y la última respuesta del asistente (si existe)
            const answer = assistantResponse ? assistantResponse.content[0].text.value : null
            const cleanAnswer = answer.replace(/【\d+:\d+†source】/g, '');
            return {
                thread,
                response: cleanAnswer
            };
        }

        // Si el run no se completó, devolver solo el thread
        return { thread, response: null };

    } catch (err) {
        console.error("Error al conectar con OpenAI:", err);
        return { thread, response: "ERROR" };
    }
};
