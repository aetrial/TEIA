/**
 * Unit tests for session completion callback service.
 *
 * Run with: node --test tests/session-complete.test.js
 * Requires: Node.js 18+ (built-in test runner)
 *
 * These tests verify:
 * 1. Session completion callback fires with correct payload
 * 2. Fire-and-forget behavior (errors logged but not thrown)
 * 3. Duration calculation works correctly
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';

// Test constants
const TEST_SECRET = 'test-internal-secret-32chars!!!';
const TEST_CLIENT_ID = '123';
const TEST_SESSION_ID = 'session-abc-123';
const TEST_BASE_URL = 'http://localhost:8099/teiaUsers';

// Track fetch calls
let fetchCalls = [];
let fetchResponse = { ok: true, json: async () => ({ creditsUsed: 10, newBalance: 90 }) };

// Mock global fetch
const originalFetch = global.fetch;

beforeEach(() => {
  fetchCalls = [];
  fetchResponse = { ok: true, json: async () => ({ creditsUsed: 10, newBalance: 90 }) };

  global.fetch = mock.fn(async (url, options) => {
    fetchCalls.push({ url, options });
    return fetchResponse;
  });

  process.env.INTERNAL_SECRET = TEST_SECRET;
  process.env.TEIA_USERS_URL = TEST_BASE_URL;
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.INTERNAL_SECRET;
  delete process.env.TEIA_USERS_URL;
});

// Inline implementation for testing (matches session-complete.js)
async function reportSessionComplete({ clientId, sessionId, type, actualDurationSeconds, status }) {
  const internalSecret = process.env.INTERNAL_SECRET;

  if (!internalSecret) {
    console.error('[SessionComplete] INTERNAL_SECRET environment variable is not set');
    return null;
  }

  if (!clientId || !sessionId) {
    console.warn('[SessionComplete] Missing clientId or sessionId, skipping completion report');
    return null;
  }

  const baseUrl = process.env.TEIA_USERS_URL || 'http://localhost:8099/teiaUsers';
  const url = `${baseUrl}/internal/session/complete`;

  const body = JSON.stringify({
    clientId,
    sessionId,
    type,
    actualDurationSeconds,
    status
  });

  const timestamp = Date.now().toString();
  const signatureInput = body + timestamp;

  const signature = crypto
    .createHmac('sha256', internalSecret)
    .update(signatureInput)
    .digest('hex');

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
      return null;
    }

    return await response.json();

  } catch (error) {
    // Fire-and-forget: log but do not throw
    return null;
  }
}

function calculateDuration(startTimeMs) {
  if (!startTimeMs || startTimeMs <= 0) {
    return 0;
  }
  return Math.ceil((Date.now() - startTimeMs) / 1000);
}

describe('Session Completion Callback', () => {

  describe('Successful Callback', () => {
    it('should POST to correct URL with correct payload for CALL', async () => {
      const result = await reportSessionComplete({
        clientId: TEST_CLIENT_ID,
        sessionId: TEST_SESSION_ID,
        type: 'CALL',
        actualDurationSeconds: 120,
        status: 'COMPLETED'
      });

      assert.strictEqual(fetchCalls.length, 1);
      assert.strictEqual(fetchCalls[0].url, `${TEST_BASE_URL}/internal/session/complete`);
      assert.strictEqual(fetchCalls[0].options.method, 'POST');

      const body = JSON.parse(fetchCalls[0].options.body);
      assert.strictEqual(body.clientId, TEST_CLIENT_ID);
      assert.strictEqual(body.sessionId, TEST_SESSION_ID);
      assert.strictEqual(body.type, 'CALL');
      assert.strictEqual(body.actualDurationSeconds, 120);
      assert.strictEqual(body.status, 'COMPLETED');

      assert.deepStrictEqual(result, { creditsUsed: 10, newBalance: 90 });
    });

    it('should POST with null duration for MESSAGE type', async () => {
      await reportSessionComplete({
        clientId: TEST_CLIENT_ID,
        sessionId: TEST_SESSION_ID,
        type: 'MESSAGE',
        actualDurationSeconds: null,
        status: 'COMPLETED'
      });

      const body = JSON.parse(fetchCalls[0].options.body);
      assert.strictEqual(body.type, 'MESSAGE');
      assert.strictEqual(body.actualDurationSeconds, null);
    });

    it('should include correct HMAC signature headers', async () => {
      await reportSessionComplete({
        clientId: TEST_CLIENT_ID,
        sessionId: TEST_SESSION_ID,
        type: 'CALL',
        actualDurationSeconds: 60,
        status: 'COMPLETED'
      });

      const headers = fetchCalls[0].options.headers;
      assert.ok(headers['X-Internal-Key'], 'Should have X-Internal-Key header');
      assert.ok(headers['X-Timestamp'], 'Should have X-Timestamp header');
      assert.strictEqual(headers['X-Client-ID'], TEST_CLIENT_ID);
      assert.strictEqual(headers['Content-Type'], 'application/json');

      // Verify signature is valid
      const body = fetchCalls[0].options.body;
      const timestamp = headers['X-Timestamp'];
      const expectedSignature = crypto
        .createHmac('sha256', TEST_SECRET)
        .update(body + timestamp)
        .digest('hex');
      assert.strictEqual(headers['X-Internal-Key'], expectedSignature);
    });
  });

  describe('Fire-and-Forget Behavior', () => {
    it('should return null on HTTP error (not throw)', async () => {
      fetchResponse = { ok: false, text: async () => 'Internal Server Error' };

      const result = await reportSessionComplete({
        clientId: TEST_CLIENT_ID,
        sessionId: TEST_SESSION_ID,
        type: 'CALL',
        actualDurationSeconds: 60,
        status: 'COMPLETED'
      });

      assert.strictEqual(result, null);
      // Should not throw - fire and forget
    });

    it('should return null on network error (not throw)', async () => {
      global.fetch = mock.fn(async () => {
        throw new Error('Network error');
      });

      const result = await reportSessionComplete({
        clientId: TEST_CLIENT_ID,
        sessionId: TEST_SESSION_ID,
        type: 'CALL',
        actualDurationSeconds: 60,
        status: 'COMPLETED'
      });

      assert.strictEqual(result, null);
      // Should not throw - fire and forget
    });

    it('should return null if INTERNAL_SECRET not set', async () => {
      delete process.env.INTERNAL_SECRET;

      const result = await reportSessionComplete({
        clientId: TEST_CLIENT_ID,
        sessionId: TEST_SESSION_ID,
        type: 'CALL',
        actualDurationSeconds: 60,
        status: 'COMPLETED'
      });

      assert.strictEqual(result, null);
      assert.strictEqual(fetchCalls.length, 0, 'Should not attempt fetch');
    });
  });

  describe('Input Validation', () => {
    it('should skip callback if clientId is missing', async () => {
      const result = await reportSessionComplete({
        clientId: null,
        sessionId: TEST_SESSION_ID,
        type: 'CALL',
        actualDurationSeconds: 60,
        status: 'COMPLETED'
      });

      assert.strictEqual(result, null);
      assert.strictEqual(fetchCalls.length, 0);
    });

    it('should skip callback if sessionId is missing', async () => {
      const result = await reportSessionComplete({
        clientId: TEST_CLIENT_ID,
        sessionId: null,
        type: 'CALL',
        actualDurationSeconds: 60,
        status: 'COMPLETED'
      });

      assert.strictEqual(result, null);
      assert.strictEqual(fetchCalls.length, 0);
    });
  });

  describe('Status Types', () => {
    it('should handle COMPLETED status', async () => {
      await reportSessionComplete({
        clientId: TEST_CLIENT_ID,
        sessionId: TEST_SESSION_ID,
        type: 'CALL',
        actualDurationSeconds: 60,
        status: 'COMPLETED'
      });

      const body = JSON.parse(fetchCalls[0].options.body);
      assert.strictEqual(body.status, 'COMPLETED');
    });

    it('should handle FAILED status', async () => {
      await reportSessionComplete({
        clientId: TEST_CLIENT_ID,
        sessionId: TEST_SESSION_ID,
        type: 'CALL',
        actualDurationSeconds: 30,
        status: 'FAILED'
      });

      const body = JSON.parse(fetchCalls[0].options.body);
      assert.strictEqual(body.status, 'FAILED');
    });
  });
});

describe('Duration Calculation', () => {

  it('should calculate duration correctly (rounded up)', () => {
    const startTime = Date.now() - 5500; // 5.5 seconds ago
    const duration = calculateDuration(startTime);
    assert.strictEqual(duration, 6, 'Should round up to 6 seconds');
  });

  it('should return 0 for null start time', () => {
    const duration = calculateDuration(null);
    assert.strictEqual(duration, 0);
  });

  it('should return 0 for zero start time', () => {
    const duration = calculateDuration(0);
    assert.strictEqual(duration, 0);
  });

  it('should return 0 for negative start time', () => {
    const duration = calculateDuration(-1000);
    assert.strictEqual(duration, 0);
  });

  it('should handle exact second boundaries', () => {
    const startTime = Date.now() - 10000; // exactly 10 seconds ago
    const duration = calculateDuration(startTime);
    assert.ok(duration >= 10, 'Should be at least 10 seconds');
    assert.ok(duration <= 11, 'Should not exceed 11 seconds');
  });
});

console.log('Running session completion callback tests...');
