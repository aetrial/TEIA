import OpenAI from "openai";
import pool from './db.js'; // Import the shared pool
import { checkAvailability } from './cal.js';
import { createBooking } from './cal.js';

const handleRequiresAction = async (run, openai ,twilioId, thread) => {
  // Check if there are tools that require outputs
  if (
    run.required_action &&
    run.required_action.submit_tool_outputs &&
    run.required_action.submit_tool_outputs.tool_calls
  ) {

  console.log("required_action: ", run.required_action.submit_tool_outputs);

    // Loop through each tool in the required action section
const toolOutputs = await Promise.all(
  run.required_action.submit_tool_outputs.tool_calls.map(async (tool) => {
    if (tool.function.name === "checkAvailability") {
      const toolArguments = JSON.parse(tool.function.arguments);
      console.log("toolArguments:", tool);
      const availability = await checkAvailability({
        twilioId,
        dateFrom: toolArguments.dateFrom,
        dateTo: toolArguments.dateTo,
      });
      console.log("checkAvailability response:", availability);
      return {
        tool_call_id: tool.id,
        output: JSON.stringify(availability),
      };
    } else if (tool.function.name === "createBooking") {
      const toolArguments = JSON.parse(tool.function.arguments);
      console.log("toolArguments createBooking:", tool);
      const booking = await createBooking({
        twilioId,
        dateFrom: toolArguments.start,
        dateTo: toolArguments.end,
        responses: toolArguments.responses,
      });
      console.log("createBooking response:", booking);
      return {
        tool_call_id: tool.id,
        output: JSON.stringify(booking),
      };
     } else {
        return null;
     }
     })
    );

    // Submit all tool outputs at once after collecting them in a list
    console.log("thread before submittools: ", thread, "run id: ", run.id);
    console.log("toolOutputs: ", toolOutputs);
    if (toolOutputs.length > 0) {
      run = await openai.beta.threads.runs.submitToolOutputsAndPoll(
        thread,
        run.id,
        { tool_outputs: toolOutputs.filter(output => output !== null) },
      );
      console.log("Tool outputs submitted successfully.");
    } else {
      console.log("No tool outputs to submit.");
    }

    // Check status after submitting tool outputs
    return;
  }
};

export const chat = async (question, thread = null, twilioId) => {
    console.log("Entering chat function");
    let run; // Declare run in the outer scope
    let openai; // Declare openai in the outer scope
    let client; // Declare client in the outer scope for finally cleanup
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

        client = await pool.connect();

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

        openai = new OpenAI({ apiKey: OPENAI_API_KEY }); // Initialize openai
        const assistant = OPENAI_ASSISTANT_KEY;

        console.log("Assistant ID of current agent:", assistant);

        thread = thread || (await openai.beta.threads.create()).id;

        // Create the user message in the thread
        await openai.beta.threads.messages.create(thread, {
            role: "user",
            content: question
        });

        // Create and execute the assistant run
        run = await openai.beta.threads.runs.createAndPoll(thread, {
            assistant_id: assistant
        });

        console.log("Run ID:", run.id);

        if (run.status === 'completed') {
            console.log("run status: " + run.status);
            const messages = await openai.beta.threads.messages.list(run.thread_id);
            for (const message of messages.data.reverse()) {
                console.log(`${message.role} > ${message.content[0].text.value}`);
              }
            const assistantResponse = messages.data
                .filter(message => message.role === 'assistant')
                .pop();

            const answer = assistantResponse ? assistantResponse.content[0].text.value : null;
            return { thread, response: answer };
        } else if (run.status === "requires_action") {
            console.log("run status: " + run.status + " tooling Name: " + run.required_action.submit_tool_outputs.tool_calls[0].function.name);
            await handleRequiresAction(run, openai, twilioId, thread);
            console.log("run status after outputs: " + run.status);

            let attempts = 0; // Initialize a counter for the loop
            const maxAttempts = 5; // Set the maximum number of attempts

            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

            while (run.status !== 'completed' && attempts < maxAttempts) {
                console.log(`Run status: ${run.status}. Attempt ${attempts + 1} of ${maxAttempts}. Waiting for 5 seconds...`);
                await wait(5000); // Wait for 2 seconds
                run = await openai.beta.threads.runs.retrieve(run.thread_id, run.id); // Refresh the run status
                attempts++; // Increment the counter
            }

            if (run.status !== 'completed') {
                console.error(`Run did not complete after ${maxAttempts} attempts.`);
                return { thread, response: "Disculpa, ¿podrias ser un poco mas claro con tu pregunta?." };
            }

            console.log("Run status: completed. Fetching messages...");
            const messages = await openai.beta.threads.messages.list(run.thread_id);
            for (const message of messages.data.reverse()) {
                console.log(`${message.role} > ${message.content[0].text.value}`);
            }
            const assistantResponse = messages.data
                .filter(message => message.role === 'assistant')
                .pop();

            const answer = assistantResponse ? assistantResponse.content[0].text.value : null;
            return { thread, response: answer };
        } else {
            console.error("Run did not complete:", run);
        }

        return { thread, response: null };
    } catch (err) {
        console.error("Error al conectar con OpenAI:", err);
        // Attempt to cancel the run if it exists
        if (run && run.id) {
            try {
                await openai.beta.threads.runs.cancel(thread, run.id);
                console.log(`Run ${run.id} canceled successfully.`);
            } catch (cancelError) {
                console.error(`Failed to cancel run ${run.id}:`, cancelError);
            }
        }
        return { thread, response: "Estamos presentando fallas en nuestro sistema. Nuestro equipo esta trabajando para solventarlo. Disculpa las molestias" };
    } finally {
        if (client) {
            client.release();
        }
    }
};