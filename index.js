import Fastify from "fastify";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import { internalAuthHook } from './middleware/internal-auth.js';
import { registerInboundRoutes } from './inbound-calls.js';
import { registerOutboundWSRoutes } from './outbound-ws.js';
import { registerInboundWSRoutes } from './inbound-ws.js';
import { registerOutboundRoutesNp } from './outbound-calls-nopromp.js';
import { registerAgentWS } from './AgentCreator-ws.js';

// Load environment variables from .env file
dotenv.config();

// Initialize Fastify server
const fastify = Fastify({
  logger: true // Enable logging
});

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Register internal authentication hook for all routes except public endpoints
fastify.addHook('preHandler', internalAuthHook);

const PORT = process.env.PORT || 8000;

// Root route for basic check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

// Health check endpoint
fastify.get("/health", async (_, reply) => {
  reply.send({ message: "I'm alive" });
});

// Start the Fastify server
const start = async () => {
  try {
    // Register route handlers
    await registerInboundRoutes(fastify);
    await registerOutboundRoutesNp(fastify);
    await registerOutboundWSRoutes(fastify);
    await registerInboundWSRoutes(fastify);
    await registerAgentWS(fastify);

    // Start listening
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`[Server] Listening on port ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

start();