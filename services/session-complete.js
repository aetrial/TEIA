import crypto from 'crypto';

/**
 * Service for calling back to TEIA-users when a session completes.
 * Reports actual duration and status so credits can be reconciled.
 *
 * This is a fire-and-forget operation: errors are logged but never thrown,
 * ensuring the user's session ends gracefully even if the callback fails.
 * Credit reconciliation can happen later via admin tools if needed.
 */

const LOG_PREFIX = '[SessionComplete]';

/**
 * Gets the TEIA-users base URL from environment.
 * @returns {string}
 */
function getTeiaUsersUrl() {
  return process.env.TEIA_USERS_URL || process.env.TEIA_USERS_BASE_URL || 'http://localhost:8099/teiaUsers';
}

/**
 * Reports session completion to TEIA-users.
 * Fire-and-forget: logs errors but does not throw.
 *
 * @param {object} params
 * @param {string} params.clientId - The client ID
 * @param {string} params.sessionId - The session ID
 * @param {string} params.type - 'CALL' or 'MESSAGE'
 * @param {number|null} params.actualDurationSeconds - Actual duration in seconds (null for messages)
 * @param {string} params.status - 'COMPLETED' or 'FAILED'
 * @param {number|null} [params.twilioCallDurationSeconds] - Actual billed call duration from Twilio (nullable)
 * @param {number|null} [params.twilioSmsCount] - Number of SMS segments sent; 0 for calls (nullable)
 * @param {number|null} [params.openAiInputTokens] - Prompt tokens consumed by OpenAI (nullable)
 * @param {number|null} [params.openAiOutputTokens] - Completion tokens consumed by OpenAI (nullable)
 * @param {number|null} [params.elevenLabsCharacters] - Characters synthesized via ElevenLabs TTS (nullable)
 * @returns {Promise<object|null>} The response from TEIA-users, or null on error
 */
export async function reportSessionComplete({
  clientId,
  sessionId,
  type,
  actualDurationSeconds,
  status,
  twilioCallDurationSeconds,
  twilioSmsCount,
  openAiInputTokens,
  openAiOutputTokens,
  elevenLabsCharacters
}) {
  const internalSecret = process.env.INTERNAL_SECRET;

  if (!internalSecret) {
    console.error(`${LOG_PREFIX} INTERNAL_SECRET environment variable is not set`);
    return null;
  }

  if (!clientId || !sessionId) {
    console.warn(`${LOG_PREFIX} Missing clientId or sessionId, skipping completion report`);
    return null;
  }

  const baseUrl = getTeiaUsersUrl();
  const url = `${baseUrl}/internal/session/complete`;

  const body = JSON.stringify({
    clientId,
    sessionId,
    type,
    actualDurationSeconds,
    status,
    twilioCallDurationSeconds,
    twilioSmsCount,
    openAiInputTokens,
    openAiOutputTokens,
    elevenLabsCharacters
  });

  const timestamp = Date.now().toString();
  const signatureInput = body + timestamp;

  const signature = crypto
    .createHmac('sha256', internalSecret)
    .update(signatureInput)
    .digest('hex');

  console.log(`${LOG_PREFIX} Reporting: sessionId=${sessionId}, clientId=${clientId}, type=${type}, duration=${actualDurationSeconds}s, status=${status}`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': signature,
        'X-Timestamp': timestamp,
        'X-Client-ID': clientId.toString()
      },
      body
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`${LOG_PREFIX} HTTP ${response.status}: ${errorText}`);
      return null;
    }

    const result = await response.json();
    console.log(`${LOG_PREFIX} Acknowledged: creditsUsed=${result.creditsUsed}, newBalance=${result.newBalance}`);
    return result;

  } catch (error) {
    // Fire-and-forget: log but do not throw
    console.error(`${LOG_PREFIX} Network error: ${error.message}`);
    return null;
  }
}

/**
 * Calculates call duration from start time.
 *
 * @param {number} startTimeMs - Start time in milliseconds
 * @returns {number} Duration in seconds (rounded up)
 */
export function calculateDuration(startTimeMs) {
  if (!startTimeMs || startTimeMs <= 0) {
    return 0;
  }
  return Math.ceil((Date.now() - startTimeMs) / 1000);
}
