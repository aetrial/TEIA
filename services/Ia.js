import OpenAI from "openai";
import { checkAvailability, createBooking } from './cal.js';

const LOG_PREFIX = '[IA]';

/**
 * Handles OpenAI function calling (tool_calls) for scheduling operations.
 */
const handleRequiresAction = async (run, openai, thread, calCredentials) => {
  if (
    run.required_action &&
    run.required_action.submit_tool_outputs &&
    run.required_action.submit_tool_outputs.tool_calls
  ) {
    console.log(`${LOG_PREFIX} Processing tool calls:`, run.required_action.submit_tool_outputs.tool_calls.map(t => t.function.name));

    const toolOutputs = await Promise.all(
      run.required_action.submit_tool_outputs.tool_calls.map(async (tool) => {
        if (tool.function.name === "checkAvailability") {
          const toolArguments = JSON.parse(tool.function.arguments);
          console.log(`${LOG_PREFIX} checkAvailability args:`, toolArguments);

          const availability = await checkAvailability({
            dateFrom: toolArguments.dateFrom,
            dateTo: toolArguments.dateTo,
            calApiKey: calCredentials.calApiKey,
            calUserId: calCredentials.calUserId,
            calEventId: calCredentials.calEventId
          });

          console.log(`${LOG_PREFIX} checkAvailability result:`, availability);
          return {
            tool_call_id: tool.id,
            output: JSON.stringify(availability),
          };
        } else if (tool.function.name === "createBooking") {
          const toolArguments = JSON.parse(tool.function.arguments);
          console.log(`${LOG_PREFIX} createBooking args:`, toolArguments);

          const booking = await createBooking({
            dateFrom: toolArguments.start,
            dateTo: toolArguments.end,
            responses: toolArguments.responses,
            calApiKey: calCredentials.calApiKey,
            calUserId: calCredentials.calUserId,
            calEventId: calCredentials.calEventId
          });

          console.log(`${LOG_PREFIX} createBooking result:`, booking);
          return {
            tool_call_id: tool.id,
            output: JSON.stringify(booking),
          };
        } else {
          console.warn(`${LOG_PREFIX} Unknown tool: ${tool.function.name}`);
          return null;
        }
      })
    );

    const validOutputs = toolOutputs.filter(output => output !== null);
    if (validOutputs.length > 0) {
      console.log(`${LOG_PREFIX} Submitting ${validOutputs.length} tool outputs`);
      run = await openai.beta.threads.runs.submitToolOutputsAndPoll(
        thread,
        run.id,
        { tool_outputs: validOutputs }
      );
      console.log(`${LOG_PREFIX} Tool outputs submitted successfully`);
    }

    return run;
  }
  return run;
};

/**
 * Sends a message to an OpenAI Assistant and returns the response.
 *
 * @param {string} question - The user's message
 * @param {string|null} thread - Existing thread ID, or null to create a new one
 * @param {object} credentials - API credentials
 * @param {string} credentials.openAiApiKey - OpenAI API key
 * @param {string} credentials.openAiAssistantId - OpenAI Assistant ID
 * @param {string} [credentials.calApiKey] - Cal.com API key (for scheduling tools)
 * @param {string} [credentials.calUserId] - Cal.com user ID
 * @param {string} [credentials.calEventId] - Cal.com event type ID
 * @returns {Promise<{thread: string, response: string|null}>}
 */
export const chat = async (question, thread = null, credentials = {}) => {
  console.log(`${LOG_PREFIX} Processing message`);

  const {
    openAiApiKey,
    openAiAssistantId,
    calApiKey,
    calUserId,
    calEventId
  } = credentials;

  if (!openAiApiKey || !openAiAssistantId) {
    console.error(`${LOG_PREFIX} Missing OpenAI credentials`);
    return {
      thread,
      response: "System configuration error. Please try again later."
    };
  }

  let run;
  let openai;

  try {
    openai = new OpenAI({ apiKey: openAiApiKey });

    // Create or use existing thread
    thread = thread || (await openai.beta.threads.create()).id;
    console.log(`${LOG_PREFIX} Using thread: ${thread}`);

    // Create the user message in the thread
    await openai.beta.threads.messages.create(thread, {
      role: "user",
      content: question
    });

    // Create and execute the assistant run
    run = await openai.beta.threads.runs.createAndPoll(thread, {
      assistant_id: openAiAssistantId
    });

    console.log(`${LOG_PREFIX} Run status: ${run.status}`);

    if (run.status === 'completed') {
      return await extractResponse(openai, run, thread);
    }

    if (run.status === "requires_action") {
      console.log(`${LOG_PREFIX} Run requires action: ${run.required_action.submit_tool_outputs.tool_calls[0].function.name}`);

      const calCredentials = { calApiKey, calUserId, calEventId };
      run = await handleRequiresAction(run, openai, thread, calCredentials);

      // Wait for completion after tool execution
      let attempts = 0;
      const maxAttempts = 5;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      while (run.status !== 'completed' && attempts < maxAttempts) {
        console.log(`${LOG_PREFIX} Waiting for completion... attempt ${attempts + 1}/${maxAttempts}`);
        await wait(5000);
        run = await openai.beta.threads.runs.retrieve(run.thread_id, run.id);
        attempts++;
      }

      if (run.status !== 'completed') {
        console.error(`${LOG_PREFIX} Run did not complete after ${maxAttempts} attempts`);
        return {
          thread,
          response: "Sorry, could you be a bit clearer with your question?"
        };
      }

      return await extractResponse(openai, run, thread);
    }

    console.error(`${LOG_PREFIX} Unexpected run status: ${run.status}`);
    return { thread, response: null };

  } catch (err) {
    console.error(`${LOG_PREFIX} Error:`, err.message);

    // Attempt to cancel the run if it exists
    if (run && run.id && openai) {
      try {
        await openai.beta.threads.runs.cancel(thread, run.id);
        console.log(`${LOG_PREFIX} Run ${run.id} canceled`);
      } catch (cancelError) {
        console.error(`${LOG_PREFIX} Failed to cancel run: ${cancelError.message}`);
      }
    }

    return {
      thread,
      response: "We're experiencing system issues. Our team is working on it. Sorry for the inconvenience."
    };
  }
};

/**
 * Extracts the assistant's response from a completed run.
 */
async function extractResponse(openai, run, thread) {
  const messages = await openai.beta.threads.messages.list(run.thread_id);

  const assistantResponse = messages.data
    .filter(message => message.role === 'assistant')
    .pop();

  const answer = assistantResponse?.content[0]?.text?.value || null;
  return { thread, response: answer };
}

/**
 * Legacy function signature for backward compatibility.
 * DEPRECATED: Use the new signature with credentials object.
 *
 * @deprecated
 */
export const chatLegacy = async (question, thread = null, twilioId) => {
  console.warn(`${LOG_PREFIX} [DEPRECATED] chatLegacy() called with twilioId. This will be removed.`);
  // This function is kept for reference but should not be used
  // New code should pass credentials directly
  throw new Error("chatLegacy is deprecated. Pass credentials directly to chat().");
};
