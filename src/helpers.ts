import { config } from './config';

export const nowIso = (): string => new Date().toISOString();

export async function sha256(s: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(s);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function tolerantJsonParse(text: string | null): any | null {
  if (!text) return null;
  const s = String(text);
  try {
    return JSON.parse(s);
  } catch {}
  const re = /```json\s*([\s\S]*?)\s*```|```\s*([\s\S]*?)\s*```/gm;
  let m;
  let last = null;
  while ((m = re.exec(s))) last = m[1] ?? m[2] ?? null;
  if (last) {
    try {
      return JSON.parse(last);
    } catch {}
  }
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) {
    const mid = s.slice(i, j + 1);
    try {
      return JSON.parse(mid);
    } catch {}
  }
  return null;
}

export function toEnvKey(taskKind: string | undefined): string | undefined {
  if (!taskKind) return undefined;
  return String(taskKind)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
}

export function resolveTaskConfig(
  taskKind: string | undefined
): { baseURL: string; apiKey: string; model: string; temperature: number } {
  if (!config.isReady()) throw new Error('Configuration not loaded');
  const key = toEnvKey(taskKind);
  // User overrides (optional)
  const ov = (k: string): string | null => {
    try {
      const v = localStorage.getItem(k);
      return v != null && String(v).trim() !== '' ? String(v) : null;
    } catch {
      return null;
    }
  };
  const baseURL = ov('OVERRIDE_BASE_URL') || config.baseURL();
  const model = ov('OVERRIDE_MODEL') || config.model();
  const temperature = ((): number => {
    const t = ov('OVERRIDE_TEMPERATURE');
    if (t == null) return config.temperature();
    const n = Number(t);
    return Number.isFinite(n) ? n : config.temperature();
  })();
  // API key continues to be stored locally in the browser
  const apiKeyDefault = ((): string => {
    try {
      return localStorage.getItem('TASK_DEFAULT_API_KEY') || '';
    } catch {
      return '';
    }
  })();
  const apiKey = ((): string => {
    try {
      return (key && localStorage.getItem(`TASK_${key}_API_KEY`)) || apiKeyDefault;
    } catch {
      return apiKeyDefault;
    }
  })();
  return { baseURL, apiKey, model, temperature };
}

// Resolve the Terminology Server base URL consistently across environments

export function getTerminologyServerURL(): string {
  // Prefer explicit user override if present
  try {
    const o = localStorage.getItem('OVERRIDE_VALIDATION_SERVICES_URL');
    if (o && o.trim()) return o.trim();
  } catch {}
  // Fall back to server-provided value; empty => same-origin
  try {
    if (config.isReady()) return config.validationServicesURL() || '';
  } catch {}
  return '';
}

// Base URL for FHIR validation (type-level endpoints are appended)
export function getFhirValidatorBaseURL(): string {
  // Reuse the same Validation Services base for both /validate and /tx
  return getTerminologyServerURL();
}
