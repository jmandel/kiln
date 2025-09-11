import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { TestServer } from "./utils/test-server";

const testServer = new TestServer();
let BASE_URL: string;

// Test report builder
class TestReport {
  private results: any[] = [];
  
  add(name: string, request: any, response: any) {
    this.results.push({
      test: name,
      request: {
        queries: request.queries,
        systems: request.systems,
        limit: request.limit,
        ...(request.items ? { items: request.items } : {}),
        ...(request.display ? { display: request.display } : {}),
        ...(request.system ? { system: request.system } : {})
      },
      timestamp: new Date().toISOString(),
      results: response.results || response.hits || response,
      count: response.count || (response.results?.length ?? response.hits?.length ?? 0)
    });
  }
  
  async writeReport(filename: string) {
    const report = {
      generated: new Date().toISOString(),
      tests: this.results
    };
    await Bun.write(filename, JSON.stringify(report, null, 2));
    console.log(`Report written to ${filename}`);
  }
}

const report = new TestReport();

describe("Terminology Search API", () => {
  beforeAll(async () => {
    // Start test server on random port
    console.log("Starting test server...");
    const port = await testServer.start();
    BASE_URL = testServer.getBaseUrl();
    console.log(`Test server started on port ${port}`);
    
    // Wait for server to be fully ready
    let retries = 20;
    while (retries > 0) {
      try {
        const res = await fetch(`${BASE_URL}/health`);
        if (res.ok) {
          console.log("Server is ready");
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 500));
      retries--;
    }
    if (retries === 0) {
      throw new Error("Server failed to become ready");
    }
  });

  describe("Basic search functionality", () => {
    test("should search for diabetes concepts", async () => {
      const request = { queries: ["diabetes"] };
      const response = await fetch(`${BASE_URL}/tx/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request)
      });
      
      expect(response.ok).toBe(true);
      const data = await response.json();
      
      report.add("Basic diabetes search", request, data);
      
      expect(data.results).toBeArray();
      expect(data.results[0]).toHaveProperty("hits");
      expect(data.results[0].hits.length).toBeGreaterThan(0);
      
      // Check structure of hits
      const firstHit = data.results[0].hits[0];
      expect(firstHit).toHaveProperty("system");
      expect(firstHit).toHaveProperty("code");
      expect(firstHit).toHaveProperty("display");
    });

    test("should search for hypertension in SNOMED", async () => {
      const request = { 
        queries: ["hypertension"],
        systems: ["snomed"]
      };
      const response = await fetch(`${BASE_URL}/tx/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request)
      });
      
      expect(response.ok).toBe(true);
      const data = await response.json();
      
      report.add("SNOMED hypertension search", request, data);
      
      expect(data.results[0].hits.length).toBeGreaterThan(0);
      // All results should be from SNOMED
      data.results[0].hits.forEach((hit: any) => {
        expect(hit.system).toBe("http://snomed.info/sct");
      });
    });

    test("should search for glucose in LOINC", async () => {
      const request = { 
        queries: ["glucose"],
        systems: ["loinc"],
        limit: 10
      };
      const response = await fetch(`${BASE_URL}/tx/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request)
      });
      
      expect(response.ok).toBe(true);
      const data = await response.json();
      
      report.add("LOINC glucose search", request, data);
      
      expect(data.results[0].hits.length).toBeGreaterThanOrEqual(1);
      expect(data.results[0].hits.length).toBeLessThanOrEqual(10);
      // All results should be from LOINC
      data.results[0].hits.forEach((hit: any) => {
        expect(hit.system).toBe("http://loinc.org");
      });
    });

    test("should handle partial/fuzzy matches", async () => {
      const request = { queries: ["cardio"] };
      const response = await fetch(`${BASE_URL}/tx/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request)
      });
      
      expect(response.ok).toBe(true);
      const data = await response.json();
      
      report.add("Partial match 'cardio'", request, data);
      
      expect(data.results[0].hits.length).toBeGreaterThan(0);
      // Should find cardiovascular related terms
      const displays = data.results[0].hits.map((h: any) => h.display.toLowerCase());
      const hasCardioRelated = displays.some((d: string) => 
        d.includes("cardio") || d.includes("cardiac") || d.includes("heart")
      );
      expect(hasCardioRelated).toBe(true);
    });

    test("should handle multi-word searches", async () => {
      const request = { queries: ["blood pressure"] };
      const response = await fetch(`${BASE_URL}/tx/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request)
      });
      
      expect(response.ok).toBe(true);
      const data = await response.json();
      
      report.add("Multi-word 'blood pressure'", request, data);
      
      expect(data.results[0].hits.length).toBeGreaterThan(0);
      const displays = data.results[0].hits.map((h: any) => h.display.toLowerCase());
      const hasBloodPressure = displays.some((d: string) => 
        (d.includes("blood") && d.includes("pressure")) || d.includes("bp")
      );
      expect(hasBloodPressure).toBe(true);
    });
  });

  describe("Batch search", () => {
    test("should handle batch searches via queries array", async () => {
      const request = { 
        queries: ["fever", "cough", "headache"],
        limit: 5
      };
      const response = await fetch(`${BASE_URL}/tx/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request)
      });
      
      expect(response.ok).toBe(true);
      const data = await response.json();
      
      report.add("Batch search (fever, cough, headache)", request, data);
      
      expect(data.results).toBeArray();
      expect(data.results).toHaveLength(3);
      
      // Check each result
      data.results.forEach((result: any, idx: number) => {
        expect(result).toHaveProperty("query");
        expect(result.query).toBe(request.queries[idx]);
        expect(result).toHaveProperty("hits");
        expect(result.hits.length).toBeLessThanOrEqual(5);
      });
    });
  });

  describe("Code existence checks", () => {
    test("should check if codes exist", async () => {
      const request = { 
        items: [
          { system: "snomed", code: "38341003" }, // Hypertension
          { system: "loinc", code: "2345-7" }, // Glucose
          { system: "fake", code: "12345" } // Should not exist
        ]
      };
      const response = await fetch(`${BASE_URL}/tx/codes/exists`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request)
      });
      
      expect(response.ok).toBe(true);
      const data = await response.json();
      
      report.add("Code existence check", request, data);
      
      expect(data.results).toBeArray();
      expect(data.results).toHaveLength(3);
      
      // SNOMED hypertension should exist
      const snomedResult = data.results.find((r: any) => r.code === "38341003");
      expect(snomedResult?.exists).toBe(true);
      
      // LOINC glucose should exist
      const loincResult = data.results.find((r: any) => r.code === "2345-7");
      expect(loincResult?.exists).toBe(true);
      
      // Fake code should not exist
      const fakeResult = data.results.find((r: any) => r.code === "12345");
      expect(fakeResult?.exists).toBe(false);
    });
  });


  describe("Capabilities", () => {
    test("should return system capabilities", async () => {
      const response = await fetch(`${BASE_URL}/tx/capabilities`);
      
      expect(response.ok).toBe(true);
      const data = await response.json();
      
      report.add("Capabilities", {}, data);
      
      expect(data).toHaveProperty("supportedSystems");
      expect(data.supportedSystems).toBeArray();
      expect(data.supportedSystems.length).toBeGreaterThan(0);
      
      // Check for expected systems
      const systemUrls = data.supportedSystems;
      const hasLoinc = systemUrls.includes("http://loinc.org");
      const hasSnomed = systemUrls.includes("http://snomed.info/sct");
      
      expect(hasLoinc || hasSnomed).toBe(true);
      
      if (data.bigSystems) {
        expect(data.bigSystems).toBeArray();
      }
    });
  });

  describe("Edge cases and error handling", () => {
    test("should handle empty query", async () => {
      const request = { queries: [""] };
      const response = await fetch(`${BASE_URL}/tx/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request)
      });
      
      expect(response.ok).toBe(true);
      const data = await response.json();
      
      report.add("Empty query", request, data);
      
      expect(data.results).toBeArray();
      expect(data.results).toHaveLength(0);
    });

    test("should handle special characters in query", async () => {
      const request = { queries: ["COVID-19"] };
      const response = await fetch(`${BASE_URL}/tx/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request)
      });
      
      expect(response.ok).toBe(true);
      const data = await response.json();
      
      report.add("Special characters 'COVID-19'", request, data);
      
      // Should not crash and may return results
      expect(data.results).toBeArray();
    });

    test("should handle very long queries gracefully", async () => {
      const longQuery = "diabetes mellitus type 2 with chronic kidney disease stage 3";
      const request = { queries: [longQuery] };
      const response = await fetch(`${BASE_URL}/tx/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request)
      });
      
      expect(response.ok).toBe(true);
      const data = await response.json();
      
      report.add("Long query", request, data);
      
      expect(data.results).toBeArray();
    });

    test("should handle non-existent system gracefully", async () => {
      const request = { 
        queries: ["test"],
        systems: ["nonexistent-system"]
      };
      const response = await fetch(`${BASE_URL}/tx/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request)
      });
      
      expect(response.ok).toBe(true);
      const data = await response.json();
      
      report.add("Non-existent system", request, data);
      
      // Should return empty or handle gracefully
      expect(data.results).toBeArray();
    });
  });

  describe("Real-world medical term searches", () => {
    const medicalTerms = [
      "myocardial infarction",
      "pneumonia",
      "asthma",
      "chronic obstructive pulmonary disease",
      "renal failure",
      "hepatitis",
      "anemia",
      "sepsis",
      "stroke",
      "malignant neoplasm"
    ];

    for (const term of medicalTerms) {
      test(`should find relevant results for "${term}"`, async () => {
        const request = { queries: [term], limit: 10 };
        const response = await fetch(`${BASE_URL}/tx/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request)
        });
        
        expect(response.ok).toBe(true);
        const data = await response.json();
        
        report.add(`Medical term: ${term}`, request, data);
        
        expect(data.results[0].hits.length).toBeGreaterThan(0);
        
        // Log top 3 results for manual inspection
        console.log(`\nTop 3 results for "${term}":`);
        data.results[0].hits.slice(0, 3).forEach((hit: any, idx: number) => {
          console.log(`  ${idx + 1}. [${hit.system.split('/').pop()}] ${hit.code}: ${hit.display}`);
        });
      });
    }
  });

  // Generate final report after all tests
  afterAll(async () => {
    await report.writeReport("./tests/terminology-test-report.json");
    // Stop the test server
    await testServer.stop();
    console.log("Test server stopped");
  });
});
