/**
 * Unit / integration tests for signedPost in services/internal-request.js
 *
 * Run with: node tests/internal-request.test.js
 * Requires: Node.js 18+ (built-in test runner)
 *
 * Tests:
 * 1. signedPost produces correct headers (X-Internal-Key, X-Timestamp, X-Client-ID)
 * 2. HMAC signature is computed correctly (known test vector)
 * 3. Throws error if INTERNAL_SECRET is not set
 * 4. Throws error if TEIA_CLIENT_ID is not set
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import http from 'http';
import { signedPost } from '../services/internal-request.js';

// ---------------------------------------------------------------------------
// Known HMAC test vector (precomputed via Node crypto):
//   HMAC-SHA256('{"test":"data"}' + '1700000000000', 'test-secret')
// ---------------------------------------------------------------------------
const KNOWN_BODY      = '{"test":"data"}';
const KNOWN_TIMESTAMP = '1700000000000';
const KNOWN_SECRET    = 'test-secret';
const KNOWN_SIGNATURE = '412ab66367c0cde82507b6026080b3076c59db36201feab6627765df140d5618';

// ---------------------------------------------------------------------------
// Helper – compute HMAC the same way signedPost does
// ---------------------------------------------------------------------------
function computeHmac(bodyString, timestamp, secret) {
  return crypto.createHmac('sha256', secret).update(bodyString + timestamp).digest('hex');
}

// ---------------------------------------------------------------------------
// Test 2 – standalone: verify the known test vector
// ---------------------------------------------------------------------------
describe('HMAC algorithm – known test vector', () => {
  it('produces the expected hex digest for a fixed body + timestamp + secret', () => {
    const actual = computeHmac(KNOWN_BODY, KNOWN_TIMESTAMP, KNOWN_SECRET);
    assert.equal(actual, KNOWN_SIGNATURE);
  });
});

// ---------------------------------------------------------------------------
// Local capture server – receives the request signedPost sends and records
// the headers and body so tests can assert on them.
// ---------------------------------------------------------------------------
let server;
let serverPort;
let lastRequest = null;   // { headers, bodyString }

before(async () => {
  await new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        lastRequest = { headers: req.headers, bodyString: raw };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function testUrl() {
  return `http://127.0.0.1:${serverPort}/internal/test`;
}

// ---------------------------------------------------------------------------
// Tests 3 & 4 – missing env vars throw before any HTTP call
// ---------------------------------------------------------------------------
describe('signedPost – environment variable validation', () => {
  it('throws if INTERNAL_SECRET is not set', async () => {
    const savedSecret = process.env.INTERNAL_SECRET;
    const savedClient = process.env.TEIA_CLIENT_ID;

    delete process.env.INTERNAL_SECRET;
    process.env.TEIA_CLIENT_ID = 'test-client-id';

    try {
      await assert.rejects(
        () => signedPost(testUrl(), { test: 'data' }),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes('INTERNAL_SECRET'),
            `Expected message to mention INTERNAL_SECRET, got: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      if (savedSecret !== undefined) process.env.INTERNAL_SECRET = savedSecret;
      if (savedClient !== undefined) process.env.TEIA_CLIENT_ID  = savedClient;
      else delete process.env.TEIA_CLIENT_ID;
    }
  });

  it('throws if TEIA_CLIENT_ID is not set', async () => {
    const savedSecret = process.env.INTERNAL_SECRET;
    const savedClient = process.env.TEIA_CLIENT_ID;

    process.env.INTERNAL_SECRET = 'test-secret';
    delete process.env.TEIA_CLIENT_ID;

    try {
      await assert.rejects(
        () => signedPost(testUrl(), { test: 'data' }),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes('TEIA_CLIENT_ID'),
            `Expected message to mention TEIA_CLIENT_ID, got: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      if (savedSecret !== undefined) process.env.INTERNAL_SECRET = savedSecret;
      else delete process.env.INTERNAL_SECRET;
      if (savedClient !== undefined) process.env.TEIA_CLIENT_ID  = savedClient;
    }
  });
});

// ---------------------------------------------------------------------------
// Tests 1 & 2 – header presence and signature correctness
// ---------------------------------------------------------------------------
describe('signedPost – with valid env vars', () => {
  before(() => {
    process.env.INTERNAL_SECRET = 'test-secret';
    process.env.TEIA_CLIENT_ID  = 'test-client-id';
  });

  it('sends X-Internal-Key, X-Timestamp, and X-Client-ID headers', async () => {
    lastRequest = null;
    await signedPost(testUrl(), { action: 'ping' });

    assert.ok(lastRequest, 'capture server should have received the request');
    const h = lastRequest.headers;

    assert.ok(h['x-internal-key'], 'X-Internal-Key header should be present');
    assert.ok(h['x-timestamp'],    'X-Timestamp header should be present');
    assert.ok(h['x-client-id'],    'X-Client-ID header should be present');
    assert.equal(h['x-client-id'], 'test-client-id');
  });

  it('X-Internal-Key is a 64-char lowercase hex HMAC-SHA256', async () => {
    lastRequest = null;
    await signedPost(testUrl(), { action: 'test' });

    const sig = lastRequest.headers['x-internal-key'];
    assert.ok(sig, 'signature should not be empty');
    assert.equal(sig.length, 64, 'HMAC-SHA256 hex should be 64 chars');
    assert.ok(/^[0-9a-f]+$/.test(sig), 'signature should be lowercase hex');
  });

  it('signature matches HMAC-SHA256(JSON.stringify(body) + timestamp, INTERNAL_SECRET)', async () => {
    lastRequest = null;
    const body = { action: 'test', value: 42 };
    await signedPost(testUrl(), body);

    const h         = lastRequest.headers;
    const timestamp = h['x-timestamp'];
    const signature = h['x-internal-key'];

    // JSON.stringify(body) is what signedPost serialises before hashing
    const expected = computeHmac(JSON.stringify(body), timestamp, 'test-secret');
    assert.equal(signature, expected, 'signature should match recomputed HMAC');
  });

  it('X-Timestamp is a numeric ms string close to now', async () => {
    lastRequest = null;
    const before = Date.now();
    await signedPost(testUrl(), {});
    const after = Date.now();

    const ts = Number(lastRequest.headers['x-timestamp']);
    assert.ok(!Number.isNaN(ts), 'X-Timestamp should be numeric');
    assert.ok(ts >= before && ts <= after, 'X-Timestamp should be within the call window');
  });
});
