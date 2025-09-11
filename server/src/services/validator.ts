import { spawn } from "child_process";
import type { ChildProcess } from "child_process";

export interface ValidationRequest {
  resource: any;
  profile?: string;
  igs?: string[];
}

export interface ValidationResult {
  valid: boolean;
  issues: Array<{
    severity: string;
    code: string;
    details?: string;
    location?: string[];
  }>;
  raw?: string;
}

// ValidatorService manages the lifecycle of the external Java validator server.
export class ValidatorService {
  private validatorProcess: ChildProcess | null = null;
  private isReady = false;
  private startupPromise: Promise<void> | null = null;
  private validatorJar: string;
  private javaHeap: string;
  private serverPort: number = 8080;

  constructor(validatorJar: string, javaHeap: string = "4g") {
    this.validatorJar = validatorJar;
    this.javaHeap = javaHeap;
    // Use a random port to avoid conflicts
    this.serverPort = 8080 + Math.floor(Math.random() * 1000);
  }

  async start() {
    if (this.startupPromise) return this.startupPromise;
    
    this.startupPromise = this._doStart();
    return this.startupPromise;
  }

  private async _doStart() {
    console.log(`Starting FHIR validator server on port ${this.serverPort}...`);
    
    // Start validator in server mode
    this.validatorProcess = spawn("java", [
      `-Xmx${this.javaHeap}`,
      "-jar",
      this.validatorJar,
      "-server",
      String(this.serverPort),
      "-version", "4.0",
      "-tx", "n/a" // No terminology server for now
    ], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    // Wait for validator to be ready
    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      const markReady = () => {
        if (!resolved) {
          resolved = true;
          this.isReady = true;
          clearTimeout(timeout);
          clearInterval(poller);
          resolve();
        }
      };

      const timeoutMs = 120_000; // allow up to 2 minutes
      const timeout = setTimeout(() => {
        if (!this.isReady) {
          reject(new Error("Validator failed to start within 120 seconds"));
        }
      }, timeoutMs);

      // Observe stdout/stderr for typical ready messages
      this.validatorProcess!.stdout?.on("data", (data: Buffer) => {
        const text = data.toString();
        console.log("[Validator]", text.trim());
        if (
          text.includes(`Listening on port ${this.serverPort}`) ||
          text.toLowerCase().includes("server started") ||
          text.toLowerCase().includes("validator server ready")
        ) {
          markReady();
        }
      });

      this.validatorProcess!.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();
        console.error("[Validator Error]", text.trim());
        if (text.includes(`Listening on port ${this.serverPort}`)) {
          markReady();
        }
      });

      // Fallback: actively poll the HTTP endpoint until any response is received
      const poller = setInterval(async () => {
        if (this.isReady) return;
        try {
          const res = await fetch(`http://localhost:${this.serverPort}/validateResource`, { method: "GET" });
          if (res.ok || res.status >= 400) {
            // Any HTTP response implies the server is listening
            markReady();
          }
        } catch {
          // ignore until the port opens
        }
      }, 500);

      this.validatorProcess!.on("error", (err: Error) => {
        clearTimeout(timeout);
        clearInterval(poller);
        console.error("Failed to start validator:", err);
        reject(err);
      });

      this.validatorProcess!.on("exit", (code: number) => {
        clearTimeout(timeout);
        clearInterval(poller);
        console.log(`Validator process exited with code ${code}`);
        this.isReady = false;
        this.validatorProcess = null;
        if (!resolved) {
          reject(new Error(`Validator exited with code ${code}`));
        }
      });
    });
  }

  async validate(resource: any, profile?: string): Promise<ValidationResult> {
    if (!this.isReady) {
      await this.start();
    }

    // Send validation request to the running server
    const url = new URL(`http://localhost:${this.serverPort}/validateResource`);
    if (profile) {
      url.searchParams.set("profiles", profile);
    }
    
    try {
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/fhir+json',
          'Accept': 'application/fhir+json'
        },
        body: JSON.stringify(resource)
      });

      if (!response.ok) {
        throw new Error(`Validator returned status ${response.status}`);
      }

      const outcome = await response.json();
      
      // Parse the OperationOutcome response
      const issues = outcome.issue || [];
      
      // Filter out reference resolution noise and normalize severity
      const filtered = issues
        .filter((issue: any) => {
          const sev = (issue.severity || '').toLowerCase();
          const isErr = sev === 'error' || sev === 'fatal';
          if (!isErr) return false;
          
          const msg = (issue.diagnostics || issue.details?.text || '').toLowerCase();
          const refNoise = msg.includes('reference') && msg.includes('resolve');
          return !refNoise;
        })
        .map((issue: any) => ({
          severity: issue.severity === 'fatal' ? 'error' : issue.severity,
          code: issue.code || 'unknown',
          details: issue.diagnostics || issue.details?.text || 'No details provided',
          location: issue.location?.[0] || issue.expression?.[0]
        }));

      return {
        valid: filtered.length === 0,
        issues: filtered,
        raw: JSON.stringify(outcome)
      };
    } catch (error) {
      console.error("Validation request failed:", error);
      return {
        valid: false,
        issues: [{
          severity: "error",
          code: "exception",
          details: String(error)
        }]
      };
    }
  }

  stop() {
    if (this.validatorProcess) {
      this.validatorProcess.kill();
      this.validatorProcess = null;
      this.isReady = false;
    }
  }

  getIsReady(): boolean {
    return this.isReady;
  }
}
