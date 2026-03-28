import { signedGet } from './internal-request.js';

const LOG_PREFIX = '[PromptService]';

/**
 * Fetches the active agent prompt for a client from TEIA-users.
 *
 * @param {number|string} clientId - The client ID
 * @returns {Promise<string|null>} The prompt content, or null if no prompt is configured
 * @throws {Error} On network or server errors (non-404)
 */
export async function fetchClientPrompt(clientId) {
  const teiaUsersUrl = process.env.TEIA_USERS_URL;

  if (!teiaUsersUrl) {
    console.warn(`${LOG_PREFIX} TEIA_USERS_URL not set, skipping prompt fetch`);
    return null;
  }

  const url = `${teiaUsersUrl}/internal/clients/${clientId}/prompt`;
  console.log(`${LOG_PREFIX} Fetching prompt for client ${clientId}`);

  try {
    const response = await signedGet(url);
    const content = response.data?.content;

    if (content) {
      console.log(`${LOG_PREFIX} Got prompt for client ${clientId} (${content.length} chars)`);
      return content;
    }

    console.log(`${LOG_PREFIX} Empty prompt response for client ${clientId}`);
    return null;
  } catch (err) {
    // 404 means no prompt configured - return null
    if (err.response?.status === 404) {
      console.log(`${LOG_PREFIX} No prompt configured for client ${clientId}`);
      return null;
    }

    // Other errors are real problems
    console.error(`${LOG_PREFIX} Error fetching prompt for client ${clientId}: ${err.message}`);
    throw err;
  }
}
