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
  // Browser: prefer same-origin; allow override via localStorage
  try {
    if (typeof window !== 'undefined') {
      const v = localStorage.getItem('TERMINOLOGY_SERVER_URL');
      if (v && v.trim()) return v;
      // Same-origin relative base
      return '';
    }
  } catch {}
  // Global override (e.g., set on window/globalThis)
  try {
    const g: any = globalThis as any;
    if (g && g.TERMINOLOGY_SERVER_URL) return String(g.TERMINOLOGY_SERVER_URL);
  } catch {}
  // Node/Process env
  try {
    const p: any = (globalThis as any).process;
    const v = p?.env?.TERMINOLOGY_SERVER_URL;
    if (v && String(v).trim()) return String(v);
  } catch {}
  // Bun env (when available)
  try {
    const b: any = (globalThis as any).Bun;
    const v = b?.env?.TERMINOLOGY_SERVER_URL;
    if (v && String(v).trim()) return String(v);
  } catch {}
  // Default to unified server base for non-browser callers
  return 'http://localhost:3500';
}

// Base URL for FHIR validation (type-level endpoints are appended)
export function getFhirValidatorBaseURL(): string {
  // Browser: prefer same-origin; allow override via localStorage
  try {
    if (typeof window !== 'undefined') {
      const v = localStorage.getItem('FHIR_VALIDATOR_BASE_URL') || localStorage.getItem('VALIDATOR_URL');
      if (v && v.trim()) return v;
      return '';
    }
  } catch {}
  // Global override
  try {
    const g: any = globalThis as any;
    if (g && g.FHIR_VALIDATOR_BASE_URL) return String(g.FHIR_VALIDATOR_BASE_URL);
    if (g && g.VALIDATOR_URL) return String(g.VALIDATOR_URL);
  } catch {}
  // Node/Process env / Bun env
  try {
    const p: any = (globalThis as any).process;
    const pv = p?.env?.FHIR_VALIDATOR_BASE_URL || p?.env?.VALIDATOR_URL;
    if (pv && String(pv).trim()) return String(pv);
  } catch {}
  try {
    const b: any = (globalThis as any).Bun;
    const bv = b?.env?.FHIR_VALIDATOR_BASE_URL || b?.env?.VALIDATOR_URL;
    if (bv && String(bv).trim()) return String(bv);
  } catch {}
  // Default to unified server (non-browser)
  return 'http://localhost:3500';
}
