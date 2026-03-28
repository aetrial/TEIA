# TEIA Core

Voice AI execution engine for telephony. Handles real-time audio streaming, OpenAI Assistants for conversation logic, and ElevenLabs for voice synthesis.

## Architecture Overview

**TEIA Core is a pure execution engine.** It does not receive traffic directly from Twilio or external clients. All webhooks route through TEIA-users first:

```
External Traffic Flow:

  Twilio (calls/SMS)
         |
         v
  +--------------+     Internal API     +-------------+
  | TEIA-users   | ------------------->  | TEIA Core   |
  | (Java/Spring)|     (HMAC signed)    | (Node.js)   |
  +--------------+                       +-------------+
         |                                      |
         |  - Credit checks                     |  - Audio streaming
         |  - Session management                |  - ElevenLabs integration
         |  - Token generation                  |  - OpenAI processing
         v                                      v
     Twilio TwiML                          WebSocket to Twilio
```

**TEIA-users responsibilities:**
- Receives all Twilio webhooks (call/message)
- Validates client identity and checks credit balance
- Reserves credits and generates session tokens
- Returns TwiML that connects Twilio to TEIA Core WebSocket

**TEIA Core responsibilities:**
- Receives pre-authorized requests from TEIA-users
- Handles real-time audio via Twilio Media Streams
- Processes conversations through ElevenLabs Conversational AI
- Reports session completion back to TEIA-users for credit reconciliation

---

## Quick Start

```bash
# Copy environment template (pre-configured for local dev)
cp .env.example .env

# Install dependencies
npm install

# Run the server
node index.js
```

Default port: `8000`

---

## Internal API Endpoints

All endpoints (except health checks) require HMAC authentication from TEIA-users.

### HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/internal/call` | Inbound call forwarded from TEIA-users. Credentials in body. Returns TwiML. |
| `POST` | `/internal/message` | Inbound SMS/WhatsApp message. Credentials in body. Processes via OpenAI, replies via Twilio. |
| `POST` | `/internal/outbound-ws` | Outbound WhatsApp template message. Credentials in body. |
| `POST` | `/internal/outbound-call-np` | Initiate outbound call (no-prompt variant). Credentials in body. |
| `POST` | `/internal/outbound-call-twiml-np` | Generate TwiML for outbound call. Called by Twilio after call connects. |
| `POST` | `/internal/agent` | Create OpenAI Assistant. Returns assistant ID for TEIA-users to store. |

> **Note:** TEIA Core also calls back into TEIA-users at session start:
> `GET /internal/clients/{clientId}/prompt` — fetches the client's active system prompt. Falls back to a default prompt if 404.

### WebSocket Endpoints

| Path | Description |
|------|-------------|
| `/media-stream` | Twilio Media Stream for inbound calls. Session token + credentials via `customParameters`. |
| `/outbound-media-stream-np` | Twilio Media Stream for outbound calls. Session token + credentials via `customParameters`. |

### Public Endpoints (No Auth)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Server status |
| `GET` | `/health` | Health check |

---

## Authentication Model

### HTTP Requests (from TEIA-users)

All `/internal/**` endpoints are protected by HMAC-SHA256 authentication.

**Required Headers:**

| Header | Description |
|--------|-------------|
| `X-Internal-Key` | HMAC-SHA256 signature (hex-encoded) |
| `X-Timestamp` | Unix timestamp in milliseconds |
| `X-Client-ID` | TeiaUser ID (from TEIA-users database) |

**Signature Computation:**

```javascript
const signatureInput = JSON.stringify(requestBody) + timestamp;
const signature = crypto.createHmac('sha256', INTERNAL_SECRET)
                        .update(signatureInput)
                        .digest('hex');
```

**Validation Rules:**
- All three headers must be present
- Timestamp must be within 30 seconds of server time (prevents replay attacks)
- Signature must match expected HMAC computation

### WebSocket Connections (from Twilio)

WebSocket routes (`/media-stream`, `/outbound-media-stream-np`) use session token authentication instead of HMAC headers.

**Authentication Flow:**
1. TEIA-users generates a short-lived session token when creating a session
2. Token is embedded in TwiML `<Parameter>` elements
3. Twilio delivers token via `customParameters` on the WebSocket `start` event
4. TEIA Core validates token before processing any audio

**Token Format:**
```
base64url(clientId.sessionId.timestamp).hmacSignature
```

**Required customParameters:**
- `session_token` - The signed session token
- `client_id` - The TeiaUser ID
- `session_id` - The session ID (for credit reconciliation)
- `elevenlabs_api_key` - ElevenLabs API key (decrypted by TEIA-users)
- `elevenlabs_agent_id` - ElevenLabs agent ID

**Token Validation:**
- Token signature is verified using `INTERNAL_SECRET`
- Token must not be expired (default: 60 seconds, configurable via `SESSION_TOKEN_VALIDITY_MS`)
- `client_id` in token must match `client_id` in customParameters

Invalid tokens result in WebSocket close with code `4001`.

---

## Environment Variables

### Required for Production

| Variable | Default | Description |
|----------|---------|-------------|
| `INTERNAL_SECRET` | `teia-local-dev-secret-change-in-prod` | **REQUIRED in production.** Shared secret for HMAC authentication. Must match TEIA-users. |

### Service Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8000` | HTTP/WebSocket server port |
| `TEIA_USERS_URL` | `http://localhost:8099/teiaUsers` | TEIA-users base URL (for session completion callbacks) |
| `TEIA_CLIENT_ID` | `00000000-0000-0000-0000-000000000000` | UUID identifying this TEIA Core instance |
| `SESSION_TOKEN_VALIDITY_MS` | `60000` | Session token validity in milliseconds |

### Database (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_USER` | `postgres` | PostgreSQL user |
| `DB_PASSWORD` | `password` | PostgreSQL password |
| `DB_NAME` | `teiacore` | PostgreSQL database name |

Database is used for thread persistence (conversation history). Not required for basic webhook flow testing.

### Legacy/Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_ORG_API_KEY` | - | Org-level OpenAI key (not needed; client keys come from TEIA-users) |
| `SQL_SERVER`, `SQL_USER`, etc. | - | MySQL/SQL Server for legacy integrations |

---

## Local Development

### With TEIA-users (Recommended)

1. **Start TEIA-users first:**
   ```bash
   cd ../TEIA-users
   ./mvnw spring-boot:run -Dspring-boot.run.profiles=local
   ```
   Wait for "Started TeiaUsersApplication" in logs.

2. **Start TEIA Core:**
   ```bash
   cd ../TEIA
   cp .env.example .env
   node index.js
   ```

Both services use matching default secrets (`teia-local-dev-secret-change-in-prod`) so authentication works out of the box.

### Testing Internal Endpoints

You can test `/internal/**` endpoints directly by generating valid HMAC signatures:

```bash
# Generate timestamp and signature
TIMESTAMP=$(date +%s)000
BODY='{"sessionId":"test-123","clientId":1}'
SECRET="teia-local-dev-secret-change-in-prod"
SIGNATURE=$(echo -n "${BODY}${TIMESTAMP}" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)

# Call internal endpoint
curl -X POST http://localhost:8000/internal/call \
  -H "Content-Type: application/json" \
  -H "X-Internal-Key: $SIGNATURE" \
  -H "X-Timestamp: $TIMESTAMP" \
  -H "X-Client-ID: 1" \
  -d "$BODY"
```

### Testing Without Authentication

For rapid development, you can temporarily disable authentication by commenting out the hook in `index.js`:

```javascript
// fastify.addHook('preHandler', internalAuthHook);
```

**Warning:** Never deploy with authentication disabled.

---

## Session Lifecycle

```
1. TEIA-users receives Twilio webhook
2. TEIA-users validates client, reserves credits, generates session token
3. TEIA-users returns TwiML pointing to TEIA Core WebSocket
4. Twilio connects to TEIA Core WebSocket with session parameters
5. TEIA Core validates token and initializes ElevenLabs connection
6. Audio streams bidirectionally (Twilio <-> TEIA Core <-> ElevenLabs)
7. On disconnect, TEIA Core reports completion to TEIA-users (with provider telemetry: call duration, SMS count, token counts, ElevenLabs characters)
8. TEIA-users reconciles credits (refunds unused, charges overage) and stores provider metrics
```

---

## Files and Structure

```
index.js                      - Server entry, route registration, auth hook
middleware/
  internal-auth.js            - HMAC validation for HTTP, token validation for WS
  session-token.js            - Token generation/validation utilities
inbound-calls.js              - /internal/call and /media-stream handlers
inbound-ws.js                 - /internal/message handler
outbound-ws.js                - /internal/outbound-ws handler
outbound-calls-nopromp.js     - /internal/outbound-call-np and /outbound-media-stream-np
services/
  session-complete.js         - Reports completion back to TEIA-users (includes provider telemetry fields)
  prompt-service.js           - Fetches client's active system prompt from TEIA-users at session start
  Ia.js                       - OpenAI Assistants integration
  db.js                       - PostgreSQL connection pool
```

---

## Relationship to TEIA-users

TEIA-users is the **traffic controller and credit gatekeeper**. This service is the **execution engine**.

| Responsibility | TEIA-users | TEIA Core |
|----------------|------------|-----------|
| Twilio webhooks | Receives | Does not receive |
| Client lookup | Yes | No (trusts TEIA-users) |
| Credit checks | Yes | No |
| Session tokens | Generates | Validates |
| Audio streaming | No | Yes |
| AI processing | No | Yes |
| Session completion | Receives callback | Sends callback |

API contract changes must be coordinated between both projects.
