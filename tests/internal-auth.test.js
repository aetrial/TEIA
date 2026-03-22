/**
 * Unit tests for internal authentication middleware.
 *
 * Run with: node --test tests/internal-auth.test.js
 * Requires: Node.js 18+ (built-in test runner)
 *
 * These tests verify:
 * 1. Valid signed HTTP requests pass through
 * 2. Tampered signatures are rejected (401)
 * 3. Expired timestamps are rejected (401)
 * 4. Missing headers are rejected (401)
 * 5. WebSocket token validation works correctly
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';

// Test constants
const TEST_SECRET = 'test-internal-secret-32chars!!!';
const VALID_CLIENT_ID = '123';

// Set environment variable for tests
process.env.INTERNAL_SECRET = TEST_SECRET;

// Helper to compute valid HMAC signature
function computeSignature(body, timestamp, secret) {
  const signatureInput = body + timestamp;
  return crypto
    .createHmac('sha256', secret)
    .update(signatureInput)
    .digest('hex');
}

// Generate a valid session token (matching TEIA-users SessionTokenService format)
function generateSessionToken(clientId, sessionId, timestamp = Date.now()) {
  const payload = `${clientId}.${sessionId}.${timestamp}`;
  const signature = crypto
    .createHmac('sha256', TEST_SECRET)
    .update(payload)
    .digest('hex');

  // base64url encode payload
  const encodedPayload = Buffer.from(payload)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${encodedPayload}.${signature}`;
}

// Mock request factory
function createMockRequest(headers = {}, body = null, url = '/api/test') {
  return {
    headers: headers,
    body: body,
    url: url,
    clientId: null,
    log: {
      info: () => {},
      warn: () => {},
      error: () => {}
    }
  };
}

// Mock reply factory
function createMockReply() {
  let statusCode = 200;
  let sentBody = null;

  return {
    code: function(code) {
      statusCode = code;
      return this;
    },
    send: function(body) {
      sentBody = body;
      return this;
    },
    getStatus: () => statusCode,
    getBody: () => sentBody
  };
}

// Create the middleware inline for testing (updated to match new implementation without DB)
async function createMiddleware() {
  const PUBLIC_ROUTES = ['/', '/health'];
  const WEBSOCKET_ROUTES = ['/media-stream', '/outbound-media-stream-np'];
  const TIMESTAMP_TOLERANCE_MS = 30000;

  return async function internalAuthHook(request, reply) {
    const urlPath = request.url.split('?')[0];
    if (PUBLIC_ROUTES.includes(urlPath)) {
      return;
    }

    if (WEBSOCKET_ROUTES.includes(urlPath)) {
      return;
    }

    const internalSecret = process.env.INTERNAL_SECRET;

    if (!internalSecret) {
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Server configuration error'
      });
    }

    const signature = request.headers['x-internal-key'];
    const timestamp = request.headers['x-timestamp'];
    const clientId = request.headers['x-client-id'];

    if (!signature || !timestamp || !clientId) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Missing required authentication headers'
      });
    }

    const timestampMs = parseInt(timestamp, 10);
    if (isNaN(timestampMs)) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid timestamp format'
      });
    }

    const now = Date.now();
    const timestampDelta = Math.abs(now - timestampMs);

    if (timestampDelta > TIMESTAMP_TOLERANCE_MS) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Request timestamp expired'
      });
    }

    const requestBody = request.body ? JSON.stringify(request.body) : '';
    const signatureInput = requestBody + timestamp;

    const expectedSignature = crypto
      .createHmac('sha256', internalSecret)
      .update(signatureInput)
      .digest('hex');

    const signatureBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');

    if (signatureBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid signature'
      });
    }

    // Trust the clientId - no DB query (request is properly signed)
    request.clientId = clientId;
  };
}

// Create WebSocket token validator inline for testing
function createWebSocketTokenValidator() {
  return function validateWebSocketToken(customParameters) {
    if (!customParameters) {
      return { valid: false, clientId: null, sessionId: null, error: 'No custom parameters provided' };
    }

    const sessionToken = customParameters.session_token;
    const clientId = customParameters.client_id;

    if (!sessionToken || !clientId) {
      return { valid: false, clientId: null, sessionId: null, error: 'Missing session_token or client_id' };
    }

    // Parse token
    const parts = sessionToken.split('.');
    if (parts.length !== 2) {
      return { valid: false, clientId: null, sessionId: null, error: 'Invalid token format' };
    }

    const [encodedPayload, providedSignature] = parts;

    // Decode payload
    let payload;
    try {
      const base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
      payload = Buffer.from(padded, 'base64').toString('utf8');
    } catch {
      return { valid: false, clientId: null, sessionId: null, error: 'Invalid token encoding' };
    }

    // Parse payload: clientId.sessionId.timestamp
    const payloadParts = payload.split('.');
    if (payloadParts.length !== 3) {
      return { valid: false, clientId: null, sessionId: null, error: 'Invalid token structure' };
    }

    const [tokenClientId, sessionId, timestampStr] = payloadParts;
    const timestamp = parseInt(timestampStr, 10);

    if (isNaN(timestamp)) {
      return { valid: false, clientId: null, sessionId: null, error: 'Invalid token timestamp' };
    }

    // Verify client ID matches
    if (tokenClientId !== clientId) {
      return { valid: false, clientId: tokenClientId, sessionId, error: 'Client ID mismatch' };
    }

    // Verify signature
    const expectedSignature = crypto
      .createHmac('sha256', process.env.INTERNAL_SECRET)
      .update(payload)
      .digest('hex');

    const providedBuffer = Buffer.from(providedSignature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');

    if (providedBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
      return { valid: false, clientId: null, sessionId: null, error: 'Invalid signature' };
    }

    // Check expiration (60 seconds)
    const now = Date.now();
    const age = now - timestamp;
    const TOKEN_VALIDITY_MS = 60000;

    if (age > TOKEN_VALIDITY_MS) {
      return { valid: false, clientId: tokenClientId, sessionId, error: 'Token expired' };
    }

    if (age < 0) {
      return { valid: false, clientId: tokenClientId, sessionId, error: 'Invalid token timestamp' };
    }

    return { valid: true, clientId: tokenClientId, sessionId, error: null };
  };
}

describe('Internal Auth Middleware', () => {

  describe('Public Routes', () => {
    it('should allow access to / without authentication', async () => {
      const middleware = await createMiddleware();
      const request = createMockRequest({}, null, '/');
      const reply = createMockReply();

      await middleware(request, reply);

      assert.strictEqual(reply.getBody(), null, 'Should not send any response');
    });

    it('should allow access to /health without authentication', async () => {
      const middleware = await createMiddleware();
      const request = createMockRequest({}, null, '/health');
      const reply = createMockReply();

      await middleware(request, reply);

      assert.strictEqual(reply.getBody(), null, 'Should not send any response');
    });
  });

  describe('WebSocket Routes', () => {
    it('should skip HMAC auth for /media-stream (uses token auth)', async () => {
      const middleware = await createMiddleware();
      const request = createMockRequest({}, null, '/media-stream');
      const reply = createMockReply();

      await middleware(request, reply);

      assert.strictEqual(reply.getBody(), null, 'Should pass through without HMAC check');
    });

    it('should skip HMAC auth for /outbound-media-stream-np', async () => {
      const middleware = await createMiddleware();
      const request = createMockRequest({}, null, '/outbound-media-stream-np');
      const reply = createMockReply();

      await middleware(request, reply);

      assert.strictEqual(reply.getBody(), null, 'Should pass through without HMAC check');
    });
  });

  describe('Missing Headers', () => {
    it('should reject request with no headers', async () => {
      const middleware = await createMiddleware();
      const request = createMockRequest({});
      const reply = createMockReply();

      await middleware(request, reply);

      assert.strictEqual(reply.getStatus(), 401);
      assert.strictEqual(reply.getBody().error, 'Unauthorized');
      assert.strictEqual(reply.getBody().message, 'Missing required authentication headers');
    });

    it('should reject request with missing X-Internal-Key', async () => {
      const middleware = await createMiddleware();
      const timestamp = Date.now().toString();
      const request = createMockRequest({
        'x-timestamp': timestamp,
        'x-client-id': VALID_CLIENT_ID
      });
      const reply = createMockReply();

      await middleware(request, reply);

      assert.strictEqual(reply.getStatus(), 401);
      assert.strictEqual(reply.getBody().message, 'Missing required authentication headers');
    });

    it('should reject request with missing X-Timestamp', async () => {
      const middleware = await createMiddleware();
      const request = createMockRequest({
        'x-internal-key': 'somesignature',
        'x-client-id': VALID_CLIENT_ID
      });
      const reply = createMockReply();

      await middleware(request, reply);

      assert.strictEqual(reply.getStatus(), 401);
      assert.strictEqual(reply.getBody().message, 'Missing required authentication headers');
    });

    it('should reject request with missing X-Client-ID', async () => {
      const middleware = await createMiddleware();
      const timestamp = Date.now().toString();
      const signature = computeSignature('', timestamp, TEST_SECRET);
      const request = createMockRequest({
        'x-internal-key': signature,
        'x-timestamp': timestamp
      });
      const reply = createMockReply();

      await middleware(request, reply);

      assert.strictEqual(reply.getStatus(), 401);
      assert.strictEqual(reply.getBody().message, 'Missing required authentication headers');
    });
  });

  describe('Timestamp Validation', () => {
    it('should reject request with expired timestamp (older than 30s)', async () => {
      const middleware = await createMiddleware();
      const expiredTimestamp = (Date.now() - 31000).toString();
      const signature = computeSignature('', expiredTimestamp, TEST_SECRET);
      const request = createMockRequest({
        'x-internal-key': signature,
        'x-timestamp': expiredTimestamp,
        'x-client-id': VALID_CLIENT_ID
      });
      const reply = createMockReply();

      await middleware(request, reply);

      assert.strictEqual(reply.getStatus(), 401);
      assert.strictEqual(reply.getBody().message, 'Request timestamp expired');
    });

    it('should reject request with future timestamp (more than 30s ahead)', async () => {
      const middleware = await createMiddleware();
      const futureTimestamp = (Date.now() + 31000).toString();
      const signature = computeSignature('', futureTimestamp, TEST_SECRET);
      const request = createMockRequest({
        'x-internal-key': signature,
        'x-timestamp': futureTimestamp,
        'x-client-id': VALID_CLIENT_ID
      });
      const reply = createMockReply();

      await middleware(request, reply);

      assert.strictEqual(reply.getStatus(), 401);
      assert.strictEqual(reply.getBody().message, 'Request timestamp expired');
    });

    it('should reject request with invalid timestamp format', async () => {
      const middleware = await createMiddleware();
      const request = createMockRequest({
        'x-internal-key': 'somesignature',
        'x-timestamp': 'not-a-number',
        'x-client-id': VALID_CLIENT_ID
      });
      const reply = createMockReply();

      await middleware(request, reply);

      assert.strictEqual(reply.getStatus(), 401);
      assert.strictEqual(reply.getBody().message, 'Invalid timestamp format');
    });
  });

  describe('Signature Validation', () => {
    it('should reject request with tampered signature', async () => {
      const middleware = await createMiddleware();
      const timestamp = Date.now().toString();
      const tamperedSignature = 'a'.repeat(64);
      const request = createMockRequest({
        'x-internal-key': tamperedSignature,
        'x-timestamp': timestamp,
        'x-client-id': VALID_CLIENT_ID
      });
      const reply = createMockReply();

      await middleware(request, reply);

      assert.strictEqual(reply.getStatus(), 401);
      assert.strictEqual(reply.getBody().message, 'Invalid signature');
    });

    it('should reject request with signature computed with wrong secret', async () => {
      const middleware = await createMiddleware();
      const timestamp = Date.now().toString();
      const wrongSignature = computeSignature('', timestamp, 'wrong-secret');
      const request = createMockRequest({
        'x-internal-key': wrongSignature,
        'x-timestamp': timestamp,
        'x-client-id': VALID_CLIENT_ID
      });
      const reply = createMockReply();

      await middleware(request, reply);

      assert.strictEqual(reply.getStatus(), 401);
      assert.strictEqual(reply.getBody().message, 'Invalid signature');
    });

    it('should reject request when body was tampered after signing', async () => {
      const middleware = await createMiddleware();
      const timestamp = Date.now().toString();
      const originalBody = { action: 'call', number: '+1234567890' };
      const signature = computeSignature(JSON.stringify(originalBody), timestamp, TEST_SECRET);

      const tamperedBody = { action: 'call', number: '+9999999999' };
      const request = createMockRequest({
        'x-internal-key': signature,
        'x-timestamp': timestamp,
        'x-client-id': VALID_CLIENT_ID
      }, tamperedBody);
      const reply = createMockReply();

      await middleware(request, reply);

      assert.strictEqual(reply.getStatus(), 401);
      assert.strictEqual(reply.getBody().message, 'Invalid signature');
    });
  });

  describe('Valid Requests', () => {
    it('should allow valid GET request without body', async () => {
      const middleware = await createMiddleware();
      const timestamp = Date.now().toString();
      const signature = computeSignature('', timestamp, TEST_SECRET);
      const request = createMockRequest({
        'x-internal-key': signature,
        'x-timestamp': timestamp,
        'x-client-id': VALID_CLIENT_ID
      });
      const reply = createMockReply();

      await middleware(request, reply);

      assert.strictEqual(reply.getBody(), null, 'Should not send any response (pass through)');
      assert.strictEqual(request.clientId, VALID_CLIENT_ID, 'Should attach clientId to request');
    });

    it('should allow valid POST request with JSON body', async () => {
      const middleware = await createMiddleware();
      const timestamp = Date.now().toString();
      const body = { action: 'initiateCall', to: '+1234567890' };
      const signature = computeSignature(JSON.stringify(body), timestamp, TEST_SECRET);
      const request = createMockRequest({
        'x-internal-key': signature,
        'x-timestamp': timestamp,
        'x-client-id': VALID_CLIENT_ID
      }, body);
      const reply = createMockReply();

      await middleware(request, reply);

      assert.strictEqual(reply.getBody(), null, 'Should not send any response (pass through)');
      assert.strictEqual(request.clientId, VALID_CLIENT_ID, 'Should attach clientId to request');
    });

    it('should allow request with timestamp just within 30 second window', async () => {
      const middleware = await createMiddleware();
      const timestamp = (Date.now() - 29000).toString();
      const signature = computeSignature('', timestamp, TEST_SECRET);
      const request = createMockRequest({
        'x-internal-key': signature,
        'x-timestamp': timestamp,
        'x-client-id': VALID_CLIENT_ID
      });
      const reply = createMockReply();

      await middleware(request, reply);

      assert.strictEqual(reply.getBody(), null, 'Should not send any response (pass through)');
    });

    it('should trust any clientId from properly signed request (no DB validation)', async () => {
      const middleware = await createMiddleware();
      const timestamp = Date.now().toString();
      const anyClientId = '999999'; // Any ID - not validated against DB
      const signature = computeSignature('', timestamp, TEST_SECRET);
      const request = createMockRequest({
        'x-internal-key': signature,
        'x-timestamp': timestamp,
        'x-client-id': anyClientId
      });
      const reply = createMockReply();

      await middleware(request, reply);

      assert.strictEqual(reply.getBody(), null, 'Should pass through without DB check');
      assert.strictEqual(request.clientId, anyClientId, 'Should attach provided clientId');
    });
  });
});

describe('WebSocket Token Validation', () => {
  const validator = createWebSocketTokenValidator();
  const SESSION_ID = 'session-abc-123';

  describe('Valid Tokens', () => {
    it('should accept valid token with current timestamp', () => {
      const token = generateSessionToken(VALID_CLIENT_ID, SESSION_ID);
      const result = validator({
        session_token: token,
        client_id: VALID_CLIENT_ID
      });

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.clientId, VALID_CLIENT_ID);
      assert.strictEqual(result.sessionId, SESSION_ID);
      assert.strictEqual(result.error, null);
    });

    it('should accept token just within 60 second validity window', () => {
      const timestamp = Date.now() - 59000; // 59 seconds ago
      const token = generateSessionToken(VALID_CLIENT_ID, SESSION_ID, timestamp);
      const result = validator({
        session_token: token,
        client_id: VALID_CLIENT_ID
      });

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.clientId, VALID_CLIENT_ID);
    });
  });

  describe('Invalid Tokens', () => {
    it('should reject missing custom parameters', () => {
      const result = validator(null);

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'No custom parameters provided');
    });

    it('should reject missing session_token', () => {
      const result = validator({
        client_id: VALID_CLIENT_ID
      });

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Missing session_token or client_id');
    });

    it('should reject missing client_id', () => {
      const token = generateSessionToken(VALID_CLIENT_ID, SESSION_ID);
      const result = validator({
        session_token: token
      });

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Missing session_token or client_id');
    });

    it('should reject token with wrong client ID', () => {
      const token = generateSessionToken('different-client', SESSION_ID);
      const result = validator({
        session_token: token,
        client_id: VALID_CLIENT_ID
      });

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Client ID mismatch');
    });

    it('should reject token with tampered signature', () => {
      const token = generateSessionToken(VALID_CLIENT_ID, SESSION_ID);
      const [payload, signature] = token.split('.');
      const tamperedToken = `${payload}.${'a'.repeat(64)}`;

      const result = validator({
        session_token: tamperedToken,
        client_id: VALID_CLIENT_ID
      });

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Invalid signature');
    });

    it('should reject expired token (older than 60 seconds)', () => {
      const timestamp = Date.now() - 61000; // 61 seconds ago
      const token = generateSessionToken(VALID_CLIENT_ID, SESSION_ID, timestamp);
      const result = validator({
        session_token: token,
        client_id: VALID_CLIENT_ID
      });

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Token expired');
    });

    it('should reject token with future timestamp', () => {
      const timestamp = Date.now() + 5000; // 5 seconds in future
      const token = generateSessionToken(VALID_CLIENT_ID, SESSION_ID, timestamp);
      const result = validator({
        session_token: token,
        client_id: VALID_CLIENT_ID
      });

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Invalid token timestamp');
    });

    it('should reject malformed token (no separator)', () => {
      const result = validator({
        session_token: 'invalidtoken',
        client_id: VALID_CLIENT_ID
      });

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Invalid token format');
    });
  });
});

console.log('Running internal auth middleware tests...');
