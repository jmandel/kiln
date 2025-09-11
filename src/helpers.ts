import type { Config } from './types';

export const nowIso = (): string => new Date().toISOString();

export async function sha256(s: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(s);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function tolerantJsonParse(text: string | null): any | null {
  if (!text) return null;
  const s = String(text);
  try { 
    return JSON.parse(s); 
  } catch {}
  const re = /```json\s*([\s\S]*?)\s*```|```\s*([\s\S]*?)\s*```/gm;
  let m; let last = null;
  while ((m = re.exec(s))) last = (m[1] ?? m[2]) ?? null;
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
  return String(taskKind).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export function resolveTaskConfig(taskKind: string | undefined): Config {
  const key = toEnvKey(taskKind);
  const baseDefault = localStorage.getItem('TASK_DEFAULT_BASE_URL') ?? "https://openrouter.ai/api/v1";
  const apiKeyDefault = localStorage.getItem('TASK_DEFAULT_API_KEY') ?? "";
  const modelDefault = localStorage.getItem('TASK_DEFAULT_MODEL') ?? "openai/gpt-oss-120b:nitro";
  const tempDefault = Number(localStorage.getItem('TASK_DEFAULT_TEMPERATURE') ?? 0.2);

  const baseURL = (key && localStorage.getItem(`TASK_${key}_BASE_URL`)) || baseDefault;
  const apiKey = (key && localStorage.getItem(`TASK_${key}_API_KEY`)) || apiKeyDefault;
  const model = (key && localStorage.getItem(`TASK_${key}_MODEL`)) || modelDefault;
  const temperature = Number((key && localStorage.getItem(`TASK_${key}_TEMPERATURE`)) || tempDefault);
  return { baseURL, apiKey, model, temperature };
}

export const STORAGE_KEYS = {
  documents: 'narrative_documents',
  workflows: 'narrative_workflows',
  artifacts: 'narrative_artifacts',
  steps: 'narrative_steps',
  links: 'narrative_links'
} as const;

// Resolve the Terminology Server base URL consistently across environments

export function getTerminologyServerURL(): string {
  // Single greenfield setting: VALIDATION_SERVICES_URL
  // Browser: use configured value or same-origin
  try {
    if (typeof window !== 'undefined') {
      const v = localStorage.getItem('VALIDATION_SERVICES_URL');
      if (v && v.trim()) return v;
      return '';
    }
  } catch {}
  // Non-browser default for local dev/tests
  return 'http://localhost:3500';
}


// Base URL for FHIR validation (type-level endpoints are appended)
export function getFhirValidatorBaseURL(): string {
  // Reuse the same Validation Services base for both /validate and /tx
  return getTerminologyServerURL();
}
