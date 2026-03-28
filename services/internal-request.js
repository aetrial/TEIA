import crypto from 'crypto';
import axios from 'axios';

/**
 * Signed HTTP client for outbound requests from TEIA Core to TEIA-users.
 * Adds HMAC-SHA256 authentication headers matching the internal-auth middleware protocol.
 *
 * Headers added:
 * - X-Internal-Key: HMAC-SHA256(requestBody + timestamp, INTERNAL_SECRET)
 * - X-Timestamp: Unix timestamp in milliseconds
 * - X-Client-ID: Identifier for this TEIA Core instance
 */

const LOG_PREFIX = '[InternalRequest]';

/**
 * Sends a signed POST request to an internal service endpoint.
 *
 * @param {string} url - The full URL to POST to
 * @param {object} body - The request body (will be JSON-serialized)
 * @returns {Promise<import('axios').AxiosResponse>} The axios response
 */
export async function signedPost(url, body) {
  const internalSecret = process.env.INTERNAL_SECRET;
  const clientId = process.env.TEIA_CLIENT_ID;

  if (!internalSecret) {
    throw new Error(`${LOG_PREFIX} INTERNAL_SECRET environment variable is not set`);
  }

  if (!clientId) {
    throw new Error(`${LOG_PREFIX} TEIA_CLIENT_ID environment variable is not set`);
  }

  const bodyString = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const signatureInput = bodyString + timestamp;

  const signature = crypto
    .createHmac('sha256', internalSecret)
    .update(signatureInput)
    .digest('hex');

  console.log(`${LOG_PREFIX} Sending signed POST to ${url} (timestamp=${timestamp}, clientId=${clientId})`);

  try {
    const response = await axios.post(url, body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': signature,
        'X-Timestamp': timestamp,
        'X-Client-ID': clientId,
      },
    });

    console.log(`${LOG_PREFIX} Response ${response.status} from ${url}`);
    return response;
  } catch (err) {
    const status = err.response?.status;
    console.error(`${LOG_PREFIX} Request to ${url} failed: status=${status ?? 'no response'}, message=${err.message}`);
    throw err;
  }
}

/**
 * Sends a signed GET request to an internal service endpoint.
 *
 * @param {string} url - The full URL to GET
 * @returns {Promise<import('axios').AxiosResponse>} The axios response
 */
export async function signedGet(url) {
  const internalSecret = process.env.INTERNAL_SECRET;
  const clientId = process.env.TEIA_CLIENT_ID;

  if (!internalSecret) {
    throw new Error(`${LOG_PREFIX} INTERNAL_SECRET environment variable is not set`);
  }

  if (!clientId) {
    throw new Error(`${LOG_PREFIX} TEIA_CLIENT_ID environment variable is not set`);
  }

  // For GET requests, sign the URL path + timestamp
  const urlPath = new URL(url).pathname;
  const timestamp = Date.now().toString();
  const signatureInput = urlPath + timestamp;

  const signature = crypto
    .createHmac('sha256', internalSecret)
    .update(signatureInput)
    .digest('hex');

  console.log(`${LOG_PREFIX} Sending signed GET to ${url} (timestamp=${timestamp}, clientId=${clientId})`);

  try {
    const response = await axios.get(url, {
      headers: {
        'X-Internal-Key': signature,
        'X-Timestamp': timestamp,
        'X-Client-ID': clientId,
      },
    });

    console.log(`${LOG_PREFIX} Response ${response.status} from ${url}`);
    return response;
  } catch (err) {
    const status = err.response?.status;
    console.error(`${LOG_PREFIX} Request to ${url} failed: status=${status ?? 'no response'}, message=${err.message}`);
    throw err;
  }
}
