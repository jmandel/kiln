#!/usr/bin/env bun
import { join } from "path";
import { createApiFetch } from "./api";

// Configuration
const PORT = Number(Bun.env.PORT ?? 3500);
const DB_PATH = Bun.env.TERMINOLOGY_DB_PATH ?? "./db/terminology.sqlite";
// Validator JAR default: support both project root and assets location
const VALIDATOR_JAR = Bun.env.VALIDATOR_JAR
  ? Bun.env.VALIDATOR_JAR
  : [
      join(import.meta.dir, "..", "validator.jar"),
      join(import.meta.dir, "..", "assets", "validator.jar"),
    ][0];
const JAVA_HEAP = Bun.env.VALIDATOR_HEAP ?? "4g";

// Initialize services via API factory
console.log(`Initializing services...`);
const { fetch, shutdown } = createApiFetch({
  dbPath: DB_PATH,
  validatorJarPath: VALIDATOR_JAR,
  javaHeap: JAVA_HEAP,
});

// Main server
const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  fetch,
});

// Use actual port in case PORT was 0 (for random port assignment)
const actualPort = server.port;
console.log(`✅ Unified FHIR server running at http://localhost:${actualPort}`);
console.log(`
Available endpoints:

TERMINOLOGY (/tx/*):
  POST /tx/search              - Search for terminology (queries array required)
  POST /tx/codes/exists        - Check if codes exist
  GET  /tx/capabilities        - Get supported code systems

VALIDATOR (/validate/*):
  POST /validate               - Validate a single resource
  POST /validate/batch         - Validate multiple resources

GENERAL:
  GET  /health                 - Health check

Environment variables:
  PORT                         - Server port (default: 3500)
  VALIDATOR_HEAP               - Java heap size (default: 4g)
  VALIDATOR_JAR                - Path to validator.jar
  TERMINOLOGY_DB_PATH          - Path to terminology sqlite DB
`);

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down services...");
  shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

