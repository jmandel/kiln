import { getFhirValidatorBaseURL } from './helpers';

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'information';
  code?: string;
  details: string;
  location?: string; // single path string
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

// Strict client: expect normalized shape from unified server
export async function validateResource(resource: any): Promise<ValidationResult> {
  const base = getFhirValidatorBaseURL().replace(/\/$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(`${base}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ resource }),
      signal: ctrl.signal as AbortSignal
    } as RequestInit);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { valid: false, issues: [{ severity: 'error', code: 'http_error', details: `HTTP ${resp.status} ${resp.statusText}${text ? ` — ${text.slice(0,200)}` : ''}`, location: '' }] };
    }
    const data = await resp.json().catch(() => ({}));
    const rawIssues = Array.isArray(data?.issues) ? data.issues : [];
    const issues: ValidationIssue[] = rawIssues.map((iss: any) => ({
      severity: String(iss?.severity || 'error').toLowerCase() === 'fatal' ? 'error' : (String(iss?.severity || 'error').toLowerCase() as any),
      code: iss?.code ? String(iss.code) : 'invalid',
      details: String(iss?.details || 'Validation error'),
      location: iss?.location ? String(iss.location) : ''
    }));
    const valid = Boolean(data?.valid) && issues.length === 0;
    return { valid, issues };
  } catch (e: any) {
    const isAbort = e?.name === 'AbortError';
    return { valid: false, issues: [{ severity: 'error', code: 'network', details: isAbort ? 'timeout' : String(e?.message || e), location: '' }] };
  } finally {
    clearTimeout(timer);
  }
}
