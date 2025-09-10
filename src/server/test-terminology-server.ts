#!/usr/bin/env bun
// Test script for the terminology server
const BASE_URL = (globalThis as any).TERMINOLOGY_SERVER_URL || (typeof process !== 'undefined' && (process as any).env?.TERMINOLOGY_SERVER_URL) || "http://localhost:3456";

async function testEndpoint(name: string, fn: () => Promise<void>) {
  try {
    console.log(`\n📝 Testing: ${name}`);
    await fn();
    console.log(`✅ ${name} passed`);
  } catch (error) {
    console.error(`❌ ${name} failed:`, error);
  }
}

async function main() {
  console.log("Starting terminology server tests...");
  
  // Wait a moment for server to be ready
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Test health endpoint
  await testEndpoint("Health check", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    const data = await res.json();
    console.log("  Health:", data);
  });

  // Test capabilities
  await testEndpoint("Capabilities", async () => {
    const res = await fetch(`${BASE_URL}/capabilities`);
    const data = await res.json();
    console.log("  Systems count:", data.supportedSystems?.length ?? 0);
    console.log("  Big systems:", data.bigSystems?.slice(0, 3));
  });

  // Test single search
  await testEndpoint("Single search", async () => {
    const res = await fetch(`${BASE_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "mri knee",
        limit: 5
      })
    });
    const data = await res.json();
    console.log("  Found:", data.count, "results");
    if (data.hits?.length > 0) {
      console.log("  First hit:", data.hits[0]);
    }
  });

  // Test search with system filter
  await testEndpoint("Search with system filter", async () => {
    const res = await fetch(`${BASE_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "hypertension",
        systems: ["http://snomed.info/sct"],
        limit: 3
      })
    });
    const data = await res.json();
    console.log("  Found:", data.count, "SNOMED results");
  });

  // Test batch search
  await testEndpoint("Batch search", async () => {
    const res = await fetch(`${BASE_URL}/search/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searches: [
          { id: "1", query: "diabetes", limit: 3 },
          { id: "2", query: "covid-19", systems: ["http://snomed.info/sct"], limit: 3 },
          { id: "3", query: "aspirin", systems: ["http://www.nlm.nih.gov/research/umls/rxnorm"], limit: 3 }
        ]
      })
    });
    const data = await res.json();
    console.log("  Batch results:", data.results?.length);
    data.results?.forEach((r: any) => {
      console.log(`    ${r.id}: ${r.query} -> ${r.count} hits`);
    });
  });

  console.log("\n✅ All tests completed!");
}

main().catch(console.error);
