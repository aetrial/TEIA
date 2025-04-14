import OpenAI from "openai";
import pkg from 'pg';
import { checkAvailability } from './cal.js';
import { createBooking } from './cal.js';
const { Client } = pkg;

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
      const booking = await createBooking({
        twilioId,
        dateFrom: toolArguments.dateFrom,
        dateTo: toolArguments.dateTo,
        responses: toolArguments.responses,
      });
      console.log("createBooking response:", booking);
      return {
        tool_call_id: tool.id,
        output: JSON.stringify(booking),
      };
     }
     })
    );

    // Submit all tool outputs at once after collecting them in a list
    if (toolOutputs.length > 0) {
      run = await openai.beta.threads.runs.submitToolOutputsAndPoll(
        thread,
        run.id,
        { tool_outputs: toolOutputs },
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

        openai = new OpenAI({ apiKey: OPENAI_API_KEY }); // Initialize openai
        const assistant = OPENAI_ASSISTANT_KEY;

        console.log("Assistant ID of current agent:", assistant);

        // Check for active runs and cancel if necessary
        if (thread) {
            const activeRuns = await openai.beta.threads.runs.list(thread);
            const activeOrActionRun = activeRuns.data.find(
              run => run.status === "active" || run.status === "requires_action"
            );
            if (activeOrActionRun) {
                console.log(`Active run detected: ${activeRun.id}. Canceling it.`);
                await openai.beta.threads.runs.cancel(thread, activeRun.id);
                console.log(`Run ${activeRun.id} canceled successfully.`);
            }
        }

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

        if (run.status === 'completed') {
            console.log("run status: " + run.status);
            const messages = await openai.beta.threads.messages.list(run.thread_id);
            const assistantResponse = messages.data
                .filter(message => message.role === 'assistant')
                .pop();

            const answer = assistantResponse ? assistantResponse.content[0].text.value : null;
            return { thread, response: answer };
        } else if (run.status === "requires_action") {
            console.log("run status: " + run.status);
            await handleRequiresAction(run, openai, twilioId, thread);

            const messages = await openai.beta.threads.messages.list(run.thread_id);
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
        return { thread, response: "ERROR" };
    }
};