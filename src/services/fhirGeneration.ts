import { IPS_NOTES } from '../ips-notes';
import { searchTerminology, type TerminologySearchResult } from '../tools';
import { analyzeCodings } from '../codingAnalysis';
import { validateResource } from '../validator';
import { FHIR_PROMPTS } from '../workflows/fhir/prompts';
import { runLLMTask } from '../llmTask';
import { emitJsonArtifact } from './artifacts';
import { sha256, getTerminologyServerURL } from '../helpers';
import type { Context } from '../types';

export async function generateAndRefineResources(
  ctx: Context,
  note_text: string,
  references: Array<{ reference: string; display: string }>,
  subjectRef?: string,
  encounterRef?: string
): Promise<any[]> {
  const GEN_CONC = Math.max(1, Number(localStorage.getItem('FHIR_GEN_CONCURRENCY') || 1));
  const generatedResources: any[] = new Array(references.length);

  const processOne = async (ref: { reference: string; display: string }, idx: number) => {
      const genParams = (function buildGenParams() {
        const rtype = String(ref.reference || '').split('/')[0];
        const ips = (IPS_NOTES as any)[rtype];
        const ipsBits = ips ? {
          ips_notes: Array.isArray(ips.requirements) ? ips.requirements : undefined,
          ips_example: typeof ips.example === 'string' ? ips.example : undefined
        } : {};
        return {
          note_text,
          resource_reference: ref.reference,
          resource_description: ref.display,
          subject_ref: subjectRef,
          encounter_ref: encounterRef,
          ...ipsBits
        };
      })();

      const { result: genRes, meta: genMeta } = await runLLMTask<any>(
        ctx,
        'fhir_generate_resource',
        'fhir_generate_resource',
        genParams,
        { expect: 'json', tags: { phase: 'fhir', reference: ref.reference } }
      );
      let resource = genRes;

      // Emit the initially generated resource before refinement
      try {
        await emitJsonArtifact(ctx, {
          kind: 'FhirResource',
          title: `${ref.reference} (generated)`,
          content: resource,
          tags: { phase: 'fhir', stage: 'generated', resourceType: resource?.resourceType, from: ref?.display, prompt: genMeta?.prompt, raw: genMeta?.raw },
          links: genMeta?.stepKey ? [ { dir: 'from', role: 'produced', ref: { type: 'step', id: genMeta.stepKey } } ] : undefined
        });
      } catch {}

      // Validate-refine loop per resource
      // Initial dynamic budget: max(default, validator_error_count + 2 * unresolved_codings + 5)
      const DEFAULT_ITERS = Number(localStorage.getItem('FHIR_VALIDATION_MAX_ITERS') || 12);
      try {
        const initReportRes = await analyzeCodings([resource]);
        const initUnresolved = (initReportRes?.report || []).filter((it: any) => it.status !== 'ok').length;
        const initValRes = await validateResource(resource);
        const initErrors = (initValRes?.issues || []).filter((x: any) => String(x?.severity || '').toLowerCase() === 'error').length;
        const MAX_ITERS = Math.max(DEFAULT_ITERS, initErrors + (2 * initUnresolved) + 5);
        var budget = MAX_ITERS;
        var INITIAL_BUDGET = MAX_ITERS;
      } catch {
        var budget = DEFAULT_ITERS;
        var INITIAL_BUDGET = DEFAULT_ITERS;
      }
      const trace: any[] = [];
      const attemptedQueriesByPtr = new Map<string, Set<string>>();
      const searchNotebook = new Map<string, Array<any>>();
      // Track last LLM meta so we can always surface a prompt/raw for debugging
      let lastLLMMeta: { prompt?: string; raw?: string; stepKey?: string } | null = null;
      let llmCalls = 0;
      // Track all refine-step LLM stepKeys that contributed to this resource
      const contributedStepKeys = new Set<string>();

      const applyJsonPatch = (root: any, ops: Array<any>): any => {
        const clone = JSON.parse(JSON.stringify(root));
        const getParentAndKey = (obj: any, path: string): { parent: any; key: string | number } => {
          const segs = path.split('/').filter(Boolean).map(s => decodeURIComponent(s));
          const key = segs.pop();
          let cur: any = obj;
          for (const s of segs) {
            const idx = String(Number(s)) === s ? Number(s) : s;
            cur = Array.isArray(cur) ? cur[idx as number] : cur[idx];
          }
          const k = String(Number(key)) === key ? Number(key) : (key as any);
          return { parent: cur, key: k };
        };
        for (const op of ops) {
          const { op: kind, path, value } = op || {};
          if (typeof path !== 'string') continue;
          if (kind === 'remove') {
            const { parent, key } = getParentAndKey(clone, path);
            if (Array.isArray(parent)) parent.splice(key as number, 1);
            else if (parent && key in parent) delete parent[key as any];
          } else if (kind === 'replace') {
            const { parent, key } = getParentAndKey(clone, path);
            if (Array.isArray(parent)) parent[key as number] = value;
            else if (parent) parent[key as any] = value;
          } else if (kind === 'add') {
            const { parent, key } = getParentAndKey(clone, path);
            if (Array.isArray(parent)) {
              const idx = typeof key === 'number' ? key : 0;
              parent.splice(idx, 0, value);
            } else if (parent) {
              parent[key as any] = value;
            }
          }
        }
        return clone;
      };

      const summarizeIssues = (codingReport: any, validation: any) => ({
        unresolvedCount: (codingReport?.filter((it: any) => it.status !== 'ok') || []).length,
        errorCount: (validation?.issues || []).filter((x: any) => x.severity === 'error').length
      });

      // Accumulate feedback to surface in the next prompt (per unresolved pointer)
      const refineWarnings: Array<{ pointer: string; invalid?: Array<{ system?: string; code?: string }>; partials?: Array<{ path: string }>; message?: string }> = [];

      const buildRefinePrompt = (resObj: any, preReport: any[], valRes: any, budgetRemaining: number) => {
        const unresolved = preReport.filter((it: any) => it.status !== 'ok');
        const validatorErrors = (valRes?.issues || []).map((iss: any) => ({
          path: iss?.location || undefined,
          severity: iss?.severity,
          message: iss?.details
        }));
        // Only include prior attempts and search notebook entries for pointers that are still unresolved
        const unresolvedPtrs = new Set<string>((unresolved || []).map((u: any) => String(u?.pointer || '')));
        const attempts: Record<string, { queries: string[] }> = {};
        for (const [ptr, set] of attemptedQueriesByPtr.entries()) {
          if (unresolvedPtrs.has(ptr)) attempts[ptr] = { queries: Array.from(set) };
        }
        const notebook: Record<string, any[]> = {};
        for (const [ptr, arr] of searchNotebook.entries()) {
          if (unresolvedPtrs.has(ptr)) notebook[ptr] = arr;
        }

        // Include all warnings (including for pointers newly introduced by a filtered patch)
        const warnings = (refineWarnings || []);

        // Redact .code from Coding objects that are unresolved to avoid confusing the LLM.
        const resourceForPrompt = JSON.parse(JSON.stringify(resObj));
        const getObjByPointer = (root: any, pointer: string): any => {
          try {
            const segs = pointer.split('/').filter(Boolean).map(s => decodeURIComponent(s));
            let cur = root;
            for (const s of segs) {
              const idx = String(Number(s)) === s ? Number(s) : s;
              cur = Array.isArray(cur) ? cur[idx as number] : cur?.[idx as any];
            }
            return cur;
          } catch { return undefined; }
        };
        for (const it of Array.isArray(unresolved) ? unresolved : []) {
          const ptr = String(it?.pointer || '');
          const obj = getObjByPointer(resourceForPrompt, ptr);
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            try { if ('code' in obj) delete (obj as any).code; } catch {}
          }
        }

        // Also redact the original.code in the Unresolved Codings summary to avoid confusing the LLM
        const unresolvedForPrompt = (Array.isArray(unresolved) ? unresolved : []).map((u: any) => {
          try {
            const copy = JSON.parse(JSON.stringify(u));
            if (copy && copy.original && typeof copy.original === 'object') {
              delete copy.original.code;
            }
            return copy;
          } catch {
            return u;
          }
        });

        const tpl = FHIR_PROMPTS['fhir_resource_validate_refine'];
        return tpl({
          resource: resourceForPrompt,
          unresolvedCodings: unresolvedForPrompt,
          validatorErrors,
          attempts,
          searchNotebook: notebook,
          warnings,
          budgetRemaining
        });
      };

      const acceptedSteps: Array<{ stepKey: string; prompt?: string; raw?: string }> = [];
      while (budget > 0) {
        const resHash = await sha256(JSON.stringify(resource));
        const iterIndex = INITIAL_BUDGET - budget + 1;
        const { report } = await ctx.step(`refine:analyze:${resHash}`, async () => {
          return await analyzeCodings([resource]);
        }, { title: 'Analyze Codings', tags: { phase: 'fhir', stage: 'validate-refine', refineIter: iterIndex } });
        const preReport = report || [];
        const initialValidation = await ctx.step(`refine:validate:${resHash}`, async () => {
          const result = await validateResource(resource);
          return { input: resource, result };
        }, { title: 'Validate Resource', tags: { phase: 'fhir', stage: 'validate-refine', refineIter: iterIndex } });
        const valRes = initialValidation?.result || initialValidation;
        const unresolved = preReport.filter((it: any) => it.status !== 'ok');
        if (unresolved.length === 0 && (valRes.valid || (valRes.issues || []).filter((x: any) => x.severity === 'error').length === 0)) {
          break;
        }
        const prompt = buildRefinePrompt(resource, preReport, valRes, budget);
        const { result: decision, meta } = await (ctx as any).callLLMEx('fhir_resource_validate_refine', prompt, { expect: 'json', tags: { phase: 'fhir', stage: 'validate-refine' } });
        llmCalls += 1;
        lastLLMMeta = { prompt: meta?.prompt, raw: meta?.raw, stepKey: meta?.stepKey };
        const llmStepKey = meta?.stepKey;
        if (llmStepKey) contributedStepKeys.add(llmStepKey);
        const action = String(decision?.action || '').toLowerCase();

        if (action === 'search_for_coding') {
          const ptr = decision?.pointer as string | undefined;
          const terms = decision?.terms;
          const systems = Array.isArray(decision?.systems) ? decision.systems : undefined;
          const provided: string[] = Array.isArray(terms)
            ? terms.map((t: any) => String(t || '').trim()).filter(Boolean)
            : (typeof terms === 'string' && String(terms).trim() ? [String(terms).trim()] : []);
          if (!ptr || provided.length === 0) {
            trace.push({ iter: INITIAL_BUDGET - budget + 1, action: 'search_for_coding', error: 'missing pointer/terms', llmStepKey, decision });
            budget -= 1; continue;
          }
          const tried = attemptedQueriesByPtr.get(ptr) || new Set<string>();
          const lowerProvided = provided.map(q => q.toLowerCase());
          const newQueries = provided.filter((q, idx) => !tried.has(lowerProvided[idx]));
          if (newQueries.length === 0) {
            trace.push({ iter: INITIAL_BUDGET - budget + 1, action: 'search_for_coding', pointer: ptr, queriesProvided: provided, queriesExecuted: [], systems, rejected: 'repeat_query', llmStepKey, decision });
            budget -= 1; continue;
          }
          for (const q of newQueries) tried.add(q.toLowerCase());
          attemptedQueriesByPtr.set(ptr, tried);
          const qHash = await sha256(JSON.stringify({ q: newQueries, systems: systems || [] }));
          const res: TerminologySearchResult = await (ctx as any).step?.(`tx:search:${qHash}`, async () => {
            return await searchTerminology(newQueries, systems, 200);
          }, { title: 'Terminology Search', tags: { phase: 'terminology', pointer: ptr } }) ?? await searchTerminology(newQueries, systems, 200);
          // Preserve actual results per query without flattening/truncation
          const resultsByQuery = Array.isArray(res.perQueryHits)
            ? res.perQueryHits.map(q => ({ query: q.query, hits: (q.hits || []).map(h => ({ system: h.system, code: h.code, display: h.display })) }))
            : newQueries.map(q => ({ query: q, hits: [] as Array<{ system: string; code: string; display: string }> }));
          const entry = {
            queries: newQueries,
            systems: systems || [],
            meta: { count: res.count, fullSystem: !!res.fullSystem, guidance: res.guidance, perQuery: res.perQuery },
            resultsByQuery
          };
          const arr = searchNotebook.get(ptr) || [];
          arr.push(entry); searchNotebook.set(ptr, arr);
          trace.push({ iter: INITIAL_BUDGET - budget + 1, action: 'search_for_coding', pointer: ptr, queriesProvided: provided, queriesExecuted: newQueries, systems, meta: entry.meta, resultsByQuery, llmStepKey, decision });
          budget -= 1; continue;
        }

        if (action === 'update') {
          // Helper: map a patch path to the base Coding pointer (e.g., '/code/coding/0')
          const baseCodingPtr = (p: string): string | null => {
            const segs = String(p || '').split('/').filter(Boolean).map(s => decodeURIComponent(s));
            if (segs.length === 0) return null;
            const i = segs.findIndex(s => s === 'coding');
            if (i >= 0) {
              const next = segs[i + 1];
              if (next != null && String(Number(next)) === next) {
                return '/' + segs.slice(0, i + 2).map(s => encodeURIComponent(s)).join('/');
              }
              return '/' + segs.slice(0, i + 1).map(s => encodeURIComponent(s)).join('/');
            }
            // Fallback: if path ends with '/system' or '/code', use its parent as the base
            const last = segs[segs.length - 1];
            if (last === 'system' || last === 'code') {
              return '/' + segs.slice(0, -1).map(s => encodeURIComponent(s)).join('/');
            }
            return null;
          };

          // Extract system/code pairs introduced by this patch, grouped by coding pointer
          const collectIntroduced = (ops: Array<any>): Map<string, Array<{ system?: string; code?: string }>> => {
            const byPtr = new Map<string, Array<{ system?: string; code?: string }>>();
            const partial = new Map<string, { system?: string; code?: string }>();
            for (const op of ops) {
              const path = String(op?.path || '');
              const ptr = baseCodingPtr(path);
              if (!ptr) continue;
              if (op?.op === 'replace' || op?.op === 'add') {
                if (op && typeof op.value === 'object' && op.value && !Array.isArray(op.value)) {
                  const v = op.value as any;
                  if ('system' in v || 'code' in v) {
                    const arr = byPtr.get(ptr) || [];
                    arr.push({ system: v.system, code: v.code });
                    byPtr.set(ptr, arr);
                    continue;
                  }
                }
                if (path.endsWith('/system')) {
                  const cur = partial.get(ptr) || {};
                  cur.system = String(op.value || '');
                  partial.set(ptr, cur);
                } else if (path.endsWith('/code')) {
                  const cur = partial.get(ptr) || {};
                  cur.code = String(op.value || '');
                  partial.set(ptr, cur);
                }
              }
            }
            for (const [ptr, v] of partial.entries()) {
              const arr = byPtr.get(ptr) || [];
              arr.push({ system: v.system, code: v.code });
              byPtr.set(ptr, arr);
            }
            return byPtr;
          };

          // Detect partial coding updates where 'code' is changed without touching 'system' and 'display'
          const detectPartialCodeUpdates = (ops: Array<any>): Array<{ pointer: string; missing: Array<'system'|'display'> }> => {
            const touched = new Map<string, { code?: boolean; system?: boolean; display?: boolean; whole?: { system?: boolean; display?: boolean; code?: boolean } }>();
            for (const op of ops) {
              const path = String(op?.path || '');
              const ptr = baseCodingPtr(path);
              if (!ptr) continue;
              const rec = touched.get(ptr) || {};
              if ((op?.op === 'replace' || op?.op === 'add') && path === ptr && op && typeof op.value === 'object' && op.value && !Array.isArray(op.value)) {
                const v = op.value as any;
                rec.whole = { system: 'system' in v, display: 'display' in v, code: 'code' in v };
              }
              if (path.endsWith('/code')) rec.code = true;
              if (path.endsWith('/system')) rec.system = true;
              if (path.endsWith('/display')) rec.display = true;
              touched.set(ptr, rec);
            }
            const partials: Array<{ pointer: string; missing: Array<'system'|'display'> }> = [];
            for (const [ptr, rec] of touched.entries()) {
              const codeChanged = !!rec.code || !!rec.whole?.code;
              if (!codeChanged) continue;
              const hasSystem = !!rec.system || !!rec.whole?.system;
              const hasDisplay = !!rec.display || !!rec.whole?.display;
              const missing: Array<'system'|'display'> = [];
              if (!hasSystem) missing.push('system');
              if (!hasDisplay) missing.push('display');
              if (missing.length > 0) partials.push({ pointer: ptr, missing });
            }
            return partials;
          };

          const introducedByPtr = collectIntroduced(Array.isArray(decision?.patch) ? decision.patch : []);

          // Validate that all introduced codes appear in ANY searchNotebook entry for that pointer (latest or earlier in this round)
          const introducedInvalid = (): Array<{ pointer: string; system?: string; code?: string }> => {
            const invalid: Array<{ pointer: string; system?: string; code?: string }> = [];
            for (const [ptr, arr] of introducedByPtr.entries()) {
              const allowed = new Set<string>();
              const notebook = searchNotebook.get(ptr) || [];
              for (const entry of notebook) {
                if (!Array.isArray(entry?.resultsByQuery)) continue;
                for (const q of entry.resultsByQuery) {
                  for (const h of (q.hits || [])) {
                    const key = `${String(h.system || '').trim()}|${String(h.code || '').trim()}`;
                    allowed.add(key);
                  }
                }
              }
              for (const x of arr) {
                const key = `${String(x.system || '').trim()}|${String(x.code || '').trim()}`;
                if (!x.system && !x.code) continue; // ignore non-coding structural edits
                if (!allowed.has(key)) invalid.push({ pointer: ptr, system: x.system, code: x.code });
              }
            }
            return invalid;
          };

          // Skip retry path; rely on the first decision as-is
          let localDecision = decision;
          let localMeta = meta;

// After retries, if still invalid codes proposed, redact those and continue
          const stillBad = introducedInvalid();
          const stillPartial: any[] = [];
          if (stillBad.length > 0) {
            const redactAtPointer = (root: any, pointer: string) => {
              try {
                const segs = pointer.split('/').filter(Boolean).map(s => decodeURIComponent(s));
                let cur = root;
                for (const s of segs) {
                  const idx = String(Number(s)) === s ? Number(s) : s;
                  cur = Array.isArray(cur) ? cur[idx as number] : cur?.[idx as any];
                  if (!cur) return;
                }
                if (cur && typeof cur === 'object') { delete (cur as any).system; delete (cur as any).code; }
              } catch {}
            };
            for (const bad of stillBad) redactAtPointer(resource, bad.pointer);
            trace.push({ iter: INITIAL_BUDGET - budget + 1, action: 'update', result: 'redacted_invalid_codes', targets: stillBad, llmStepKey: localMeta?.stepKey, decision: localDecision });
            budget -= 1; continue;
          }
          // Partial-code update redaction not applied (policy opts for rejection rather than partial redaction)

          const patch = Array.isArray(localDecision?.patch) ? localDecision.patch : [];
          if (!patch.length) {
            trace.push({ iter: INITIAL_BUDGET - budget + 1, action: 'update', error: 'missing patch', llmStepKey: localMeta?.stepKey, decision: localDecision });
            budget -= 1; continue;
          }
          // Functional filtering: map each op to a list of implicated codings, decide, and collect
          const isCodingObject = (v: any): boolean => v && typeof v === 'object' && !Array.isArray(v) && ('system' in v) && ('code' in v) && ('display' in v);
          const ucum = 'http://unitsofmeasure.org';
          const normalizeKey = (sys?: string, code?: string) => `${String(sys||'').trim()}|${String(code||'').trim()}`;
          const allowedForPtr = (ptr: string): Set<string> => {
            const hits = new Set<string>();
            for (const entry of (searchNotebook.get(ptr) || [])) {
              for (const q of (entry?.resultsByQuery || [])) {
                for (const h of (q?.hits || [])) hits.add(normalizeKey(h.system, h.code));
              }
            }
            return hits;
          };
          const canonicalDisplayFor = (ptr: string, sys: string, code: string): string | undefined => {
            for (const entry of (searchNotebook.get(ptr) || [])) {
              for (const q of (entry?.resultsByQuery || [])) {
                for (const h of (q?.hits || [])) {
                  if (normalizeKey(h.system, h.code) === normalizeKey(sys, code)) return String(h.display ?? '');
                }
              }
            }
            return undefined;
          };
          type Implicated = { ptr: string; system?: string; code?: string; display?: string; source: 'whole'|'cc'|'prop' };
          const extractCodingsFromOp = (op: any): Implicated[] => {
            const path = String(op?.path || '');
            if (!(op?.op === 'replace' || op?.op === 'add')) return [];
            const val = op?.value;
            const out: Implicated[] = [];
            if (isCodingObject(val)) {
              const ptr = baseCodingPtr(path) || path;
              out.push({ ptr, system: val.system, code: val.code, display: val.display, source: 'whole' });
              return out;
            }
            if (val && typeof val === 'object' && Array.isArray((val as any).coding)) {
              const cc = val as any;
              for (let i = 0; i < cc.coding.length; i++) {
                const c = cc.coding[i] || {};
                if (!c) continue;
                const ptr = `${path}/coding/${i}`;
                out.push({ ptr, system: c.system, code: c.code, display: c.display, source: 'cc' });
              }
              return out;
            }
            // Property-level coding edits: capture ptr but no filtering here (allowed)
            const lastSeg = path.split('/').filter(Boolean).pop();
            if (lastSeg === 'system' || lastSeg === 'code' || lastSeg === 'display') {
              const ptr = baseCodingPtr(path);
              if (ptr) out.push({ ptr, source: 'prop' });
            }
            return out;
          };
          const invalidCodings: Array<{ pointer: string; system?: string; code?: string }> = [];
          const filteredOps: any[] = [];
          patch.forEach((op: any) => {
            // Decide at op level based on implicated codings with both system+code
            const implicated = extractCodingsFromOp(op);
            const candidates = implicated.filter(c => c.source !== 'prop' && c.system && c.code);
            if (candidates.length === 0) {
              filteredOps.push(op);
              return;
            }
            // All candidates must be allowed
            const allAllowed = candidates.every(c => (String(c.system) === ucum) || allowedForPtr(c.ptr).has(normalizeKey(c.system, c.code)));
            if (!allAllowed) {
              candidates
                .filter(c => !(String(c.system) === ucum) && !allowedForPtr(c.ptr).has(normalizeKey(c.system, c.code)))
                .forEach(c => invalidCodings.push({ pointer: c.ptr, system: c.system, code: c.code }));
              return; // drop this op
            }
            // Auto-normalize display for whole/cc when notebook provides it (UCUM excluded)
            try {
              if (isCodingObject(op?.value)) {
                const sys = String(op.value.system || ''); const code = String(op.value.code || '');
                if (sys !== ucum) {
                  const canon = canonicalDisplayFor(baseCodingPtr(op.path) || op.path, sys, code);
                  if (canon && String(op.value.display || '') !== canon) op.value.display = canon;
                }
              } else if (op?.value && typeof op.value === 'object' && Array.isArray((op.value as any).coding)) {
                const cc = op.value as any;
                for (let i = 0; i < cc.coding.length; i++) {
                  const c = cc.coding[i] || {}; const sys = String(c.system || ''); const code = String(c.code || '');
                  if (!sys || !code || sys === ucum) continue;
                  const canon = canonicalDisplayFor(`${op.path}/coding/${i}`, sys, code);
                  if (canon && String(c.display || '') !== canon) cc.coding[i].display = canon;
                }
              }
            } catch {}
            filteredOps.push(op);
          });
          if (invalidCodings.length) {
            trace.push({ iter: INITIAL_BUDGET - budget + 1, action: 'update', result: 'filtered_patch', removedInvalidCodings: invalidCodings });
            try {
              if (localMeta?.stepKey) {
        const rec = await ctx.stores.steps.get((ctx as any).jobId, localMeta.stepKey);
                if (rec) {
                  const t = rec.tagsJson ? JSON.parse(rec.tagsJson) : {};
                  t.refineDecision = t.refineDecision || 'filtered';
                  t.refineDetails = { ...(t.refineDetails || {}), invalid: invalidCodings };
                  await ctx.stores.steps.put({ ...rec, tagsJson: JSON.stringify(t) });
                }
              }
            } catch {}
            // Record warning for next prompt
            try {
              // Group invalids by pointer for clarity
              const byPtr = new Map<string, Array<{ system?: string; code?: string }>>();
              for (const it of invalidCodings) {
                const arr = byPtr.get(it.pointer) || [];
                arr.push({ system: it.system, code: it.code });
                byPtr.set(it.pointer, arr);
              }
              // Enrich with canonical display if code exists in terminology DB
              const allPairs = invalidCodings.map(ic => ({ system: ic.system, code: ic.code }));
              let existsResults: Array<{ system?: string; code?: string; exists?: boolean; display?: string }> = [];
              try {
                const base = getTerminologyServerURL();
                const resp = await fetch(`${base}/tx/codes/exists`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: allPairs }) });
                if (resp.ok) {
                  const body = await resp.json();
                  existsResults = Array.isArray(body?.results) ? body.results : [];
                }
              } catch {}
              const lookupCanonical = (sys?: string, code?: string): string | undefined => {
                const hit = existsResults.find(r => String(r.system||'') === String(sys||'') && String(r.code||'') === String(code||''));
                return (hit && hit.exists && hit.display) ? String(hit.display) : undefined;
              };
              for (const [ptr, arr] of byPtr.entries()) {
                const enriched = arr.map(i => ({ ...i, canonicalDisplay: lookupCanonical(i.system, i.code) }));
                refineWarnings.push({ pointer: ptr, invalid: enriched, message: 'Filtered off-notebook coding; perform search_for_coding for this pointer.' });
              }
            } catch {}
          }
          if (filteredOps.length === 0) { trace.push({ iter: INITIAL_BUDGET - budget + 1, action: 'update', result: 'no_effect_after_filter', llmStepKey: localMeta?.stepKey, decision: localDecision }); budget -= 1; continue; }
          const candidate = applyJsonPatch(resource, filteredOps);
          const candHash = await sha256(JSON.stringify(candidate));
          // Record the candidate we are about to validate
          // Validate the candidate and capture issues (and include the candidate as input)
          const validationBundle = await ctx.step(`refine:validate:${candHash}`, async () => {
            const result = await validateResource(candidate);
            return { input: candidate, result };
          }, { title: 'Validate Candidate', tags: { phase: 'fhir', stage: 'validate-refine', refineIter: INITIAL_BUDGET - budget + 1 } });
          const valOk = validationBundle?.result || validationBundle;
          // Ensure this step appears in artifact step list
          try { contributedStepKeys.add(`refine:validate:${candHash}`); } catch {}
          const { report: candReport } = await ctx.step(`refine:analyze:${candHash}`, async () => {
            return await analyzeCodings([candidate]);
          }, { title: 'Analyze Candidate Codings', tags: { phase: 'fhir', stage: 'validate-refine' } });

          // Accept unconditionally after filtering. Validator/analyzer output is for feedback only.
          resource = candidate;
          // Compute coding pointers actually changed by filteredOps (for trace only)
          const changedPtrs = Array.from(new Set(
            filteredOps
              .map((op: any) => baseCodingPtr(String(op?.path || '')))
              .filter((p: any) => typeof p === 'string' && p)
          ));
          trace.push({ iter: INITIAL_BUDGET - budget + 1, action: 'update', result: 'accepted', patch: filteredOps, changedPointers: changedPtrs, rationale: localDecision?.rationale, llmStepKey: localMeta?.stepKey, decision: localDecision, validationIssuesAfter: valOk.issues });
          if (localMeta?.stepKey) {
            acceptedSteps.push({ stepKey: localMeta.stepKey, prompt: localMeta?.prompt, raw: localMeta?.raw });
            try {
              const rec = await ctx.stores.steps.get((ctx as any).jobId, localMeta.stepKey);
              if (rec) {
                const t = rec.tagsJson ? JSON.parse(rec.tagsJson) : {};
                t.refineDecision = 'accepted'; t.refineDetails = { changedPointers: changedPtrs };
                await ctx.stores.steps.put({ ...rec, tagsJson: JSON.stringify(t) });
              }
            } catch {}
          }
          budget -= 1; continue;
        }

        if (action === 'stop') {
          trace.push({ iter: INITIAL_BUDGET - budget + 1, action: 'stop', rationale: decision?.rationale, llmStepKey, decision });
          budget = 0; break;
        }

        trace.push({ iter: INITIAL_BUDGET - budget + 1, action: 'unknown', llmStepKey, decision });
        budget -= 1;
      }

      const traceArtifact = await emitJsonArtifact(ctx, {
        kind: 'FhirResourceValidationTrace',
        title: `Validation Trace for ${ref.reference}`,
        content: { reference: ref.reference, trace },
        tags: { phase: 'fhir', stage: 'validate-refine', reference: ref.reference }
      });

      let postUnresolved = 0;
      let postIssues = 0;
      let isValid = false;
      try {
        const { report: afterReport } = await analyzeCodings([resource]);
        const valAfter = await validateResource(resource);
        const unresolvedItems = (afterReport || []).filter((it: any) => it.status !== 'ok');
        const issues = (valAfter?.issues || []);
        postUnresolved = unresolvedItems.length;
        postIssues = issues.length;
        isValid = postUnresolved === 0 && postIssues === 0;
        const initialCopy = JSON.parse(JSON.stringify(resource));
        if (!isValid) {
          // Attach issue extensions at the CodeableConcept level (where available), not at the top-level resource.
          const EXT_URL = 'http://kraken.fhir.me/StructureDefinition/coding-issue';
          const getByPtr = (root: any, pointer: string): any => {
            try {
              const segs = pointer.split('/').filter(Boolean).map(s => decodeURIComponent(s));
              let cur = root;
              for (const s of segs) {
                const idx = String(Number(s)) === s ? Number(s) : s;
                cur = Array.isArray(cur) ? cur[idx as number] : cur?.[idx as any];
              }
              return cur;
            } catch { return undefined; }
          };
          const setExt = (node: any, payload: any) => {
            if (!node || typeof node !== 'object') return;
            const cur = Array.isArray(node.extension) ? node.extension : [];
            const filtered = cur.filter((e: any) => e?.url !== EXT_URL);
            filtered.push({ url: EXT_URL, valueString: JSON.stringify(payload) });
            node.extension = filtered;
          };
          const ccPointerOf = (codingPtr: string): string => {
            const segs = codingPtr.split('/').filter(Boolean);
            const i = segs.lastIndexOf('coding');
            if (i >= 0) return '/' + segs.slice(0, i).join('/');
            return codingPtr; // fallback
          };
          // Per-unresolved pointer, annotate the containing CodeableConcept
          for (const u of unresolvedItems) {
            const ccPtr = ccPointerOf(String(u.pointer || ''));
            const tgt = getByPtr(initialCopy, ccPtr);
            if (tgt && typeof tgt === 'object') {
              setExt(tgt, { pointer: u.pointer, original: u.original, reason: u.reason, note: 'unresolved_coding' });
            }
          }
          // Also, annotate the resource with a single summary of validation errors (non-blocking)
          if ((issues || []).length) {
            const cur = Array.isArray(initialCopy.extension) ? initialCopy.extension : [];
            const filtered = cur.filter((e: any) => e?.url !== 'urn:validation-status');
            filtered.push({ url: 'urn:validation-status', valueString: JSON.stringify({ validationErrors: issues }) });
            initialCopy.extension = filtered;
          }
        }
        // Emit the refined resource snapshot
        const lastAccepted = acceptedSteps[acceptedSteps.length - 1];
        // Prefer accepted step prompt/raw; otherwise fall back to the last refine LLM meta
        const promptForTags = lastAccepted?.prompt || lastLLMMeta?.prompt;
        const rawForTags = lastAccepted?.raw || lastLLMMeta?.raw;

        // Build links: produced = accepted steps (or fallback to last step); contributed = all refine steps
        const producedLinks = acceptedSteps.length
          ? acceptedSteps.map(s => ({ dir: 'from' as const, role: 'produced', ref: { type: 'step' as const, id: s.stepKey } }))
          : (lastLLMMeta?.stepKey ? [ { dir: 'from' as const, role: 'produced', ref: { type: 'step' as const, id: lastLLMMeta.stepKey } } ] : []);
        const producedIds = new Set(producedLinks.map(l => l.ref.id));
        const contributedLinks = Array.from(contributedStepKeys)
          .filter(id => !producedIds.has(id))
          .map(id => ({ dir: 'from' as const, role: 'contributed', ref: { type: 'step' as const, id } }));

        await emitJsonArtifact(ctx, {
          kind: 'FhirResource',
          title: `${ref.reference} (refined)`,
          content: initialCopy,
          tags: { phase: 'fhir', stage: 'refined', resourceType: initialCopy.resourceType, valid: isValid, from: ref?.display, ...(promptForTags ? { prompt: promptForTags } : {}), ...(rawForTags ? { raw: rawForTags } : {}) },
          links: [
            ...producedLinks,
            ...contributedLinks,
            ...(traceArtifact ? [{ dir: 'from' as const, role: 'uses', ref: { type: 'artifact' as const, id: traceArtifact.id } }] : [])
          ]
        });
        // Emit a per-resource validation report
        await emitJsonArtifact(ctx, { kind: 'ValidationReport', title: `Validation Report for ${ref.reference}`, content: valAfter, tags: { phase: 'fhir', stage: 'refined', reference: ref.reference, valid: isValid } });
      } catch {}

      // Fail loudly if we expected refine calls but captured no LLM trace
      if ((postUnresolved > 0 || postIssues > 0) && llmCalls === 0) {
        throw new Error(`No LLM refine trace captured for ${ref.reference} despite unresolved/validation errors. Halting pipeline.`);
      }

      generatedResources[idx] = resource;
  };

  if (GEN_CONC <= 1) {
    for (let i = 0; i < references.length; i++) {
      await processOne(references[i], i);
    }
  } else {
    for (let i = 0; i < references.length; i += GEN_CONC) {
      const batch = references.slice(i, i + GEN_CONC);
      await Promise.all(batch.map((ref, j) => processOne(ref, i + j)));
    }
  }

  return generatedResources;
}
