import crypto from 'crypto';
import { validateSessionToken, extractSessionParams } from './session-token.js';

/**
 * Internal authentication middleware for TEIA Core.
 *
 * Handles two authentication paths:
 * 1. HTTP requests: validates HMAC-signed requests from TEIA-users service
 *    Required headers:
 *    - X-Internal-Key: HMAC-SHA256(requestBody + timestamp, INTERNAL_SECRET)
 *    - X-Timestamp: Unix timestamp in milliseconds
 *    - X-Client-ID: Client UUID (TeiaUser.id from TEIA-users)
 *
 * 2. WebSocket connections: validates session tokens from Twilio customParameters
 *    Token format: base64url(clientId.sessionId.timestamp).hmacSignature
 *    Valid for 60 seconds (configurable via SESSION_TOKEN_VALIDITY_MS)
 */

const PUBLIC_ROUTES = ['/', '/health'];
// WebSocket routes use session token authentication instead of HMAC headers
const WEBSOCKET_ROUTES = ['/media-stream', '/outbound-media-stream-np'];
const TIMESTAMP_TOLERANCE_MS = 30000; // 30 seconds

/**
 * Fastify preHandler hook for internal authentication.
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function internalAuthHook(request, reply) {
  // Skip authentication for public routes
  const urlPath = request.url.split('?')[0]; // Remove query string
  if (PUBLIC_ROUTES.includes(urlPath)) {
    return;
  }

  // Skip authentication for WebSocket routes (they use session token auth)
  if (WEBSOCKET_ROUTES.includes(urlPath)) {
    return;
  }

  const internalSecret = process.env.INTERNAL_SECRET;

  if (!internalSecret) {
    request.log.error('[Internal-Auth] INTERNAL_SECRET environment variable is not set');
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Server configuration error'
    });
  }

  const signature = request.headers['x-internal-key'];
  const timestamp = request.headers['x-timestamp'];
  const clientId = request.headers['x-client-id'];

  // Validate all required headers are present
  if (!signature || !timestamp || !clientId) {
    request.log.warn('[Internal-Auth] Missing required headers');
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Missing required authentication headers'
    });
  }

  // Validate timestamp format and freshness
  const timestampMs = parseInt(timestamp, 10);
  if (isNaN(timestampMs)) {
    request.log.warn('[Internal-Auth] Invalid timestamp format');
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Invalid timestamp format'
    });
  }

  const now = Date.now();
  const timestampDelta = Math.abs(now - timestampMs);

  if (timestampDelta > TIMESTAMP_TOLERANCE_MS) {
    request.log.warn(`[Internal-Auth] Timestamp expired: delta=${timestampDelta}ms, threshold=${TIMESTAMP_TOLERANCE_MS}ms`);
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Request timestamp expired'
    });
  }

  // Compute expected signature
  // For requests with body, use the raw body string; for GET requests, use empty string
  const requestBody = request.body ? JSON.stringify(request.body) : '';
  const signatureInput = requestBody + timestamp;

  const expectedSignature = crypto
    .createHmac('sha256', internalSecret)
    .update(signatureInput)
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  const signatureBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');

  if (signatureBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    request.log.warn('[Internal-Auth] Invalid signature');
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Invalid signature'
    });
  }

  // Attach client ID to request for downstream handlers
  // We trust the clientId since the request is properly signed by TEIA-users
  request.clientId = clientId;

  // Authentication successful - continue to route handler
  request.log.info(`[Internal-Auth] Request authenticated for client: ${clientId}`);
}

/**
 * Validates a WebSocket session token from Twilio customParameters.
 * Called by WebSocket handlers after receiving the 'start' message.
 *
 * @param {object} customParameters - The customParameters from Twilio start message
 * @returns {{ valid: boolean, clientId: string|null, sessionId: string|null, error: string|null }}
 */
export function validateWebSocketToken(customParameters) {
  if (!customParameters) {
    return { valid: false, clientId: null, sessionId: null, error: 'No custom parameters provided' };
  }

  const sessionToken = customParameters.session_token;
  const clientId = customParameters.client_id;

  if (!sessionToken || !clientId) {
    return { valid: false, clientId: null, sessionId: null, error: 'Missing session_token or client_id' };
  }

  const validation = validateSessionToken(sessionToken, clientId);

  return {
    valid: validation.valid,
    clientId: validation.clientId || clientId,
    sessionId: validation.sessionId,
    error: validation.error
  };
}
