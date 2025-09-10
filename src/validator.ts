import { getFhirValidatorBaseURL } from './helpers';

export interface ValidationIssue {
  severity: "error" | "warning" | "information";
  expression?: string[];
  details: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

/**
 * Validates a FHIR resource against a public validation endpoint.
 * @param resource The FHIR resource to validate.
 * @returns A promise that resolves to a ValidationResult object.
 */
export async function validateResource(resource: any): Promise<ValidationResult> {
  const base = getFhirValidatorBaseURL().replace(/\/$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);

  const parseOutcome = async (resp: Response): Promise<ValidationResult> => {
    const ctype = resp.headers.get('content-type') || '';
    if (ctype.includes('json')) {
      try {
        const outcome = await resp.json();
        if (outcome?.resourceType === 'OperationOutcome' && Array.isArray(outcome.issue)) {
          // Filter: keep only errors; drop specific processing errors for unresolved temporary references.
          const filtered = (outcome.issue as any[]).filter((iss: any) => {
            const sev = String(iss?.severity || '').toLowerCase();
            if (sev !== 'error') return false; // drop warnings/info
            const code = String(iss?.code || '').toLowerCase();
            const codings = Array.isArray(iss?.details?.coding) ? iss.details.coding : [];
            const isRefCantResolve = code === 'processing' && codings.some((c: any) => c?.system === 'http://hl7.org/fhir/java-core-messageId' && c?.code === 'Reference_REF_CantResolve');
            if (isRefCantResolve) return false; // ignore reference resolution noise during construction
            return true;
          });
          const issues: ValidationIssue[] = filtered.map((iss: any) => ({
            severity: (iss.severity || 'error'),
            expression: iss.expression,
            details: iss.details?.text || iss.diagnostics || 'No details provided.'
          }));
          const valid = issues.length === 0;
          return { valid, issues };
        }
      } catch {}
    }
    const text = await resp.text().catch(() => '');
    return { valid: false, issues: [{ severity: 'error', details: `Validation ${resp.ok ? 'response' : 'request failed'}: HTTP ${resp.status} ${resp.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}` }] };
  };

  // Decide mode: local validator server vs. FHIR server type-level $validate
  const inferMode = (): 'local' | 'fhir' => {
    try {
      const u = new URL(base);
      // Heuristic: our local validator (default port 3457) or paths suggesting a validator service
      if (u.port === '3457' || /validator/i.test(u.hostname + u.pathname)) return 'local';
      // Heuristic: typical FHIR bases contain '/base' or version suffixes
      if (/\/base[A-Za-z0-9]*$/.test(u.pathname) || /\/(R4|R5)$/.test(u.pathname) || /fhir/i.test(u.hostname + u.pathname)) return 'fhir';
    } catch {}
    // Default to FHIR mode
    return 'fhir';
  };

  const mode = inferMode();

  try {
    if (mode === 'local') {
      // Local validator server: POST /validate { resource }
      const resp = await fetch(`${base}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ resource }),
        signal: ctrl.signal as AbortSignal
      } as RequestInit);
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        return { valid: false, issues: [{ severity: 'error', details: `Validation request failed: HTTP ${resp.status} ${resp.statusText}${text ? ` — ${text.slice(0,200)}` : ''}` }] };
      }
      const data = await resp.json();
      const issues: ValidationIssue[] = (Array.isArray(data?.issues) ? data.issues : []).filter((iss: any) => {
        const sev = String(iss?.severity || '').toLowerCase();
        const isErr = sev === 'error' || sev === 'fatal';
        if (!isErr) return false;
        const details = String(iss?.details || '');
        const msg = details.toLowerCase();
        const refNoise = /reference[_\-]?ref[_\-]?cantresolve/i.test(details) || (msg.includes('reference') && msg.includes('resolve'));
        return !refNoise;
      }).map((iss: any) => ({
        severity: String(iss?.severity || 'error').toLowerCase() === 'fatal' ? 'error' : (String(iss?.severity || 'error').toLowerCase() as any),
        details: String(iss?.details || 'Validation error'),
        expression: Array.isArray(iss?.location) ? iss.location : (Array.isArray(iss?.expression) ? iss.expression : undefined)
      }));
      return { valid: issues.length === 0, issues };
    } else {
      // FHIR server: type-level $validate
      const typeUrl = `${base}/${encodeURIComponent(resource?.resourceType || 'Resource')}/$validate`;
      const response = await fetch(typeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/fhir+json; charset=utf-8', 'Accept': 'application/fhir+json' },
        body: JSON.stringify(resource),
        signal: ctrl.signal as AbortSignal
      } as RequestInit);
      return await parseOutcome(response);
    }
  } catch (e: any) {
    const isAbort = e?.name === 'AbortError';
    return { valid: false, issues: [{ severity: 'error', details: `Validation error: ${isAbort ? 'timeout' : e.message}` }] };
  } finally {
    clearTimeout(timer);
  }
}
