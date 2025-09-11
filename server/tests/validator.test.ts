import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { TestServer } from "./utils/test-server";

const testServer = new TestServer();
let BASE_URL: string;

// Sample FHIR resources for testing
const validPatient = {
  resourceType: "Patient",
  id: "example",
  name: [{
    use: "official",
    family: "Doe",
    given: ["John"]
  }],
  gender: "male",
  birthDate: "1990-01-01"
};

const invalidPatient = {
  resourceType: "Patient",
  id: "invalid",
  name: [{
    use: "official",
    family: 123, // Invalid - should be string
    given: ["John"]
  }],
  gender: "invalid-gender", // Invalid gender code
  birthDate: "not-a-date" // Invalid date format
};

const validObservation = {
  resourceType: "Observation",
  id: "example",
  status: "final",
  code: {
    coding: [{
      system: "http://loinc.org",
      code: "2345-7",
      display: "Glucose"
    }]
  },
  subject: {
    reference: "Patient/example"
  },
  valueQuantity: {
    value: 95,
    unit: "mg/dL",
    system: "http://unitsofmeasure.org",
    code: "mg/dL"
  }
};

// Test report builder
class ValidationTestReport {
  private results: any[] = [];
  
  add(name: string, resource: any, result: any) {
    this.results.push({
      test: name,
      resourceType: resource.resourceType,
      timestamp: new Date().toISOString(),
      valid: result.valid,
      issueCount: result.issues?.length ?? 0,
      issues: result.issues
    });
  }
  
  async writeReport(filename: string) {
    const report = {
      generated: new Date().toISOString(),
      tests: this.results
    };
    await Bun.write(filename, JSON.stringify(report, null, 2));
    console.log(`Validation report written to ${filename}`);
  }
}

const report = new ValidationTestReport();

describe("FHIR Validator API", () => {
  beforeAll(async () => {
    // Start test server on random port
    console.log("Starting test server for validator tests...");
    const port = await testServer.start();
    BASE_URL = testServer.getBaseUrl();
    console.log(`Test server started on port ${port}`);
    
    // Wait for server to be fully ready
    let retries = 40; // ~20s
    while (retries > 0) {
      try {
        const res = await fetch(`${BASE_URL}/health`);
        if (res.ok) break;
      } catch {}
      await new Promise(r => setTimeout(r, 500));
      retries--;
    }
    if (retries === 0) {
      throw new Error("Server failed to become ready");
    }
  });

  // Ensure validator server is fully ready once before running validations
  test("validator is ready", async () => {
    let retries = 240; // up to 120s
    while (retries > 0) {
      try {
        const res = await fetch(`${BASE_URL}/health`);
        if (res.ok) {
          const data = await res.json();
          if (data?.services?.validator?.ready === true) {
            console.log("Validator is ready");
            return;
          }
        }
      } catch {}
      await new Promise(r => setTimeout(r, 500));
      retries--;
    }
    throw new Error("Validator failed to become ready in time");
  }, 180_000);

  describe("Basic validation", () => {
    test("should validate a correct Patient resource", async () => {
      const response = await fetch(`${BASE_URL}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: validPatient })
      });
      
      expect(response.ok).toBe(true);
      const result = await response.json();
      
      report.add("Valid Patient", validPatient, result);
      
      expect(result).toHaveProperty("valid");
      expect(result).toHaveProperty("issues");
      expect(result.issues).toBeArray();
      
      // Should have no errors (only warnings/info allowed)
      const errors = result.issues.filter((i: any) => i.severity === "error");
      expect(errors.length).toBe(0);
    }, 120_000);

    test("should detect errors in invalid Patient resource", async () => {
      const response = await fetch(`${BASE_URL}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: invalidPatient })
      });
      
      expect(response.ok).toBe(true);
      const result = await response.json();
      
      report.add("Invalid Patient", invalidPatient, result);
      
      expect(result.valid).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
      
      // Should have at least one error
      const errors = result.issues.filter((i: any) => i.severity === "error");
      expect(errors.length).toBeGreaterThan(0);
      
      console.log("\nValidation errors for invalid Patient:");
      errors.forEach((err: any) => {
        console.log(`  - ${err.details}`);
      });
    }, 120_000);

    test("should validate an Observation resource", async () => {
      const response = await fetch(`${BASE_URL}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: validObservation })
      });
      
      expect(response.ok).toBe(true);
      const result = await response.json();
      
      report.add("Valid Observation", validObservation, result);
      
      // Should have no errors (reference resolution warnings are filtered)
      const errors = result.issues.filter((i: any) => i.severity === "error");
      expect(errors.length).toBe(0);
    }, 120_000);
  });

  describe("Batch validation", () => {
    test("should validate multiple resources in batch", async () => {
      const response = await fetch(`${BASE_URL}/validate/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          resources: [
            { id: "1", resource: validPatient },
            { id: "2", resource: invalidPatient },
            { id: "3", resource: validObservation }
          ]
        })
      });
      
      expect(response.ok).toBe(true);
      const data = await response.json();
      
      expect(data.results).toBeArray();
      expect(data.results).toHaveLength(3);
      
      // Check each result
      const validPatientResult = data.results.find((r: any) => r.id === "1");
      expect(validPatientResult.issues.filter((i: any) => i.severity === "error").length).toBe(0);
      
      const invalidPatientResult = data.results.find((r: any) => r.id === "2");
      expect(invalidPatientResult.valid).toBe(false);
      
      const observationResult = data.results.find((r: any) => r.id === "3");
      expect(observationResult.issues.filter((i: any) => i.severity === "error").length).toBe(0);
      
      // Add to report
      data.results.forEach((r: any) => {
        const resource = r.id === "1" ? validPatient : 
                        r.id === "2" ? invalidPatient : validObservation;
        report.add(`Batch validation ${r.id}`, resource, r);
      });
    }, 120_000);
  });

  describe("Complex resources", () => {
    test("should validate a Bundle resource", async () => {
      const bundle = {
        resourceType: "Bundle",
        type: "collection",
        entry: [
          { resource: validPatient },
          { resource: validObservation }
        ]
      };
      
      const response = await fetch(`${BASE_URL}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: bundle })
      });
      
      expect(response.ok).toBe(true);
      const result = await response.json();
      
      report.add("Bundle", bundle, result);
      
      expect(result).toHaveProperty("valid");
      expect(result).toHaveProperty("issues");
    }, 120_000);

    test("should validate a MedicationRequest", async () => {
      const medicationRequest = {
        resourceType: "MedicationRequest",
        id: "example",
        status: "active",
        intent: "order",
        medicationCodeableConcept: {
          coding: [{
            system: "http://www.nlm.nih.gov/research/umls/rxnorm",
            code: "1049502",
            display: "Acetaminophen 325 MG Oral Tablet"
          }]
        },
        subject: {
          reference: "Patient/example"
        },
        dosageInstruction: [{
          text: "Take 1-2 tablets every 4-6 hours as needed",
          timing: {
            repeat: {
              frequency: 1,
              period: 4,
              periodUnit: "h"
            }
          },
          doseAndRate: [{
            doseQuantity: {
              value: 650,
              unit: "mg",
              system: "http://unitsofmeasure.org",
              code: "mg"
            }
          }]
        }]
      };
      
      const response = await fetch(`${BASE_URL}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: medicationRequest })
      });
      
      expect(response.ok).toBe(true);
      const result = await response.json();
      
      report.add("MedicationRequest", medicationRequest, result);
      
      // Check for critical errors only
      const errors = result.issues.filter((i: any) => i.severity === "error");
      console.log(`\nMedicationRequest validation: ${errors.length} errors`);
      if (errors.length > 0) {
        errors.forEach((err: any) => {
          console.log(`  - ${err.details}`);
        });
      }
    }, 120_000);
  });

  describe("Error handling", () => {
    test("should handle missing resource parameter", async () => {
      const response = await fetch(`${BASE_URL}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      
      expect(response.status).toBe(400);
      const result = await response.json();
      expect(result).toHaveProperty("error");
    }, 120_000);

    test("should handle malformed JSON resource", async () => {
      const malformed = {
        resourceType: "Patient",
        // Circular reference would cause JSON stringify issues
        name: "not-an-array" // Should be array
      };
      
      const response = await fetch(`${BASE_URL}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: malformed })
      });
      
      expect(response.ok).toBe(true);
      const result = await response.json();
      
      report.add("Malformed Patient", malformed, result);
      
      expect(result.valid).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    }, 120_000);

    test("should handle unknown resource type", async () => {
      const unknown = {
        resourceType: "UnknownResourceType",
        id: "test"
      };
      
      const response = await fetch(`${BASE_URL}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: unknown })
      });
      
      expect(response.ok).toBe(true);
      const result = await response.json();
      
      report.add("Unknown resource type", unknown, result);
      
      expect(result.valid).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    }, 120_000);
  });

  // Generate final report after all tests
  afterAll(async () => {
    await report.writeReport("./tests/validator-test-report.json");
    // Stop the test server
    await testServer.stop();
    console.log("Test server stopped");
  });
});
