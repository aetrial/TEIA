import crypto from 'crypto';

/**
 * Session token validation module for TEIA Core.
 * Validates HMAC-signed session tokens issued by TEIA-users for WebSocket authentication.
 *
 * Token format: base64url(clientId.sessionId.timestamp).hmacSignature
 * Token validity: configurable, default 60 seconds
 */

const TOKEN_SEPARATOR = '.';
const TOKEN_VALIDITY_MS = parseInt(process.env.SESSION_TOKEN_VALIDITY_MS || '60000', 10);

/**
 * Validates a session token from TEIA-users.
 *
 * @param {string} token - The session token to validate
 * @param {string} expectedClientId - The expected client ID
 * @returns {{ valid: boolean, expired: boolean, sessionId: string|null, clientId: string|null, error: string|null }}
 */
export function validateSessionToken(token, expectedClientId) {
  const internalSecret = process.env.INTERNAL_SECRET;

  if (!internalSecret) {
    console.error('[SessionToken] INTERNAL_SECRET environment variable is not set');
    return { valid: false, expired: false, sessionId: null, clientId: null, error: 'Server configuration error' };
  }

  if (!token || typeof token !== 'string') {
    return { valid: false, expired: false, sessionId: null, clientId: null, error: 'Token is required' };
  }

  // Split token into payload and signature
  const parts = token.split(TOKEN_SEPARATOR);
  if (parts.length !== 2) {
    return { valid: false, expired: false, sessionId: null, clientId: null, error: 'Invalid token format' };
  }

  const [encodedPayload, providedSignature] = parts;

  // Decode payload
  let payload;
  try {
    // Convert base64url to base64
    const base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
    payload = Buffer.from(padded, 'base64').toString('utf8');
  } catch (err) {
    return { valid: false, expired: false, sessionId: null, clientId: null, error: 'Invalid token encoding' };
  }

  // Parse payload: clientId.sessionId.timestamp
  const payloadParts = payload.split(TOKEN_SEPARATOR);
  if (payloadParts.length !== 3) {
    return { valid: false, expired: false, sessionId: null, clientId: null, error: 'Invalid token structure' };
  }

  const [tokenClientId, sessionId, timestampStr] = payloadParts;
  const timestamp = parseInt(timestampStr, 10);

  if (isNaN(timestamp)) {
    return { valid: false, expired: false, sessionId: null, clientId: null, error: 'Invalid token timestamp' };
  }

  // Verify client ID matches
  if (tokenClientId !== expectedClientId) {
    console.warn(`[SessionToken] Client ID mismatch: expected=${expectedClientId}, got=${tokenClientId}`);
    return { valid: false, expired: false, sessionId, clientId: tokenClientId, error: 'Client ID mismatch' };
  }

  // Verify signature
  const expectedSignature = crypto
    .createHmac('sha256', internalSecret)
    .update(payload)
    .digest('hex');

  const providedBuffer = Buffer.from(providedSignature, 'hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');

  if (providedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    console.warn('[SessionToken] Invalid signature');
    return { valid: false, expired: false, sessionId: null, clientId: null, error: 'Invalid signature' };
  }

  // Check expiration
  const now = Date.now();
  const age = now - timestamp;

  if (age > TOKEN_VALIDITY_MS) {
    console.warn(`[SessionToken] Token expired: age=${age}ms, max=${TOKEN_VALIDITY_MS}ms`);
    return { valid: false, expired: true, sessionId, clientId: tokenClientId, error: 'Token expired' };
  }

  if (age < 0) {
    // Token from the future - likely clock skew
    console.warn(`[SessionToken] Token timestamp is in the future by ${Math.abs(age)}ms`);
    return { valid: false, expired: false, sessionId, clientId: tokenClientId, error: 'Invalid token timestamp' };
  }

  console.log(`[SessionToken] Token validated: clientId=${tokenClientId}, sessionId=${sessionId}`);
  return { valid: true, expired: false, sessionId, clientId: tokenClientId, error: null };
}

/**
 * Extracts session parameters from Twilio WebSocket start message.
 * Twilio delivers parameters set via <Parameter> elements in the start.customParameters object.
 *
 * @param {object} startMessage - The Twilio WebSocket start message
 * @returns {{ sessionToken: string|null, clientId: string|null, sessionId: string|null }}
 */
export function extractSessionParams(startMessage) {
  const customParams = startMessage?.start?.customParameters || {};

  return {
    sessionToken: customParams.session_token || null,
    clientId: customParams.client_id || null,
    sessionId: customParams.session_id || null
  };
}
