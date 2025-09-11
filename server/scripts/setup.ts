#!/usr/bin/env bun
/**
 * Setup script for FHIR server dependencies
 * Downloads validator JAR and sets up git submodule for large-vocabularies
 */

import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { $ } from "bun";

// If VALIDATOR_VERSION is set, fetch that exact release; otherwise fetch the latest release
const VALIDATOR_VERSION = Bun.env.VALIDATOR_VERSION; // e.g., "6.6.7"
const VALIDATOR_URL = VALIDATOR_VERSION
  ? `https://github.com/hapifhir/org.hl7.fhir.core/releases/download/${VALIDATOR_VERSION}/validator_cli.jar`
  : `https://github.com/hapifhir/org.hl7.fhir.core/releases/latest/download/validator_cli.jar`;
const VALIDATOR_PATH = "./validator.jar";
const LARGE_VOCAB_REPO = "https://github.com/jmandel/fhir-concept-publication-demo";
const LARGE_VOCAB_PATH = "./large-vocabularies";

async function downloadValidator() {
  if (existsSync(VALIDATOR_PATH)) {
    console.log("✅ Validator JAR already exists");
    return;
  }

  console.log(
    VALIDATOR_VERSION
      ? `📥 Downloading FHIR validator v${VALIDATOR_VERSION}...`
      : `📥 Downloading latest FHIR validator (no VALIDATOR_VERSION set)...`
  );
  try {
    const response = await fetch(VALIDATOR_URL);
    if (!response.ok) {
      throw new Error(`Failed to download: ${response.statusText}`);
    }
    
    const buffer = await response.arrayBuffer();
    await Bun.write(VALIDATOR_PATH, buffer);
    console.log(`✅ Downloaded validator JAR (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB)`);
  } catch (error) {
    console.error(`❌ Failed to download validator: ${error}`);
    process.exit(1);
  }
}

async function setupLargeVocabularies() {
  // Check if it's already a git submodule
  if (existsSync(`${LARGE_VOCAB_PATH}/.git`)) {
    console.log("✅ Large vocabularies submodule already exists");
    // Update submodule
    console.log("📥 Updating large vocabularies submodule...");
    await $`cd ${LARGE_VOCAB_PATH} && git pull origin main`;
    return;
  }

  // Check if directory exists but is not a submodule
  if (existsSync(LARGE_VOCAB_PATH)) {
    console.log("⚠️  Large vocabularies directory exists but is not a git submodule");
    console.log("   Remove it and re-run setup to configure as submodule");
    return;
  }

  // Add as git submodule
  console.log("📥 Adding large vocabularies as git submodule...");
  try {
    await $`git submodule add ${LARGE_VOCAB_REPO} ${LARGE_VOCAB_PATH}`;
    await $`git submodule update --init --recursive`;
    console.log("✅ Large vocabularies submodule configured");
  } catch (error) {
    // If not in a git repo, just clone it
    console.log("📥 Cloning large vocabularies repository...");
    await $`git clone ${LARGE_VOCAB_REPO} ${LARGE_VOCAB_PATH}`;
    console.log("✅ Large vocabularies repository cloned");
  }
}

async function createDirectories() {
  // Ensure db directory exists
  if (!existsSync("./db")) {
    await mkdir("./db", { recursive: true });
    console.log("✅ Created db directory");
  }

  // Ensure tests directory exists
  if (!existsSync("./tests")) {
    await mkdir("./tests", { recursive: true });
    console.log("✅ Created tests directory");
  }
}

async function checkDependencies() {
  // Check for Java
  try {
    const result = await $`java -version`.quiet();
    console.log("✅ Java is installed");
  } catch {
    console.error("❌ Java is not installed or not in PATH");
    console.error("   Please install Java 11 or later");
    process.exit(1);
  }

  // Check for git
  try {
    await $`git --version`.quiet();
    console.log("✅ Git is installed");
  } catch {
    console.error("❌ Git is not installed or not in PATH");
    console.error("   Please install git");
    process.exit(1);
  }
}

async function main() {
  console.log(`
🚀 FHIR Server Setup
====================
`);

  // Check dependencies
  await checkDependencies();

  // Create necessary directories
  await createDirectories();

  // Download validator JAR
  await downloadValidator();

  // Setup large vocabularies
  await setupLargeVocabularies();

  console.log(`
✅ Setup complete!

Next steps:
1. Load terminology database:
   bun run load-terminology.ts

2. Start the server:
   bun run server.ts

3. Run tests:
   bun test
`);
}

// Run if executed directly
if (import.meta.main) {
  main();
}
