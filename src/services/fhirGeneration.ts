import { IPS_NOTES } from '../ips-notes';
import { searchTerminology, type TerminologySearchResult } from '../tools';
import { analyzeCodings } from '../codingAnalysis';
import { validateResource } from '../validator';
import { PROMPTS } from '../prompts';
import { emitJsonArtifact } from './artifacts';
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
      const genPrompt = (function buildGenPrompt() {
        const rtype = String(ref.reference || '').split('/')[0];
        const ips = (IPS_NOTES as any)[rtype];
        const ipsBits = ips ? {
          ips_notes: Array.isArray(ips.requirements) ? ips.requirements : undefined,
          ips_example: typeof ips.example === 'string' ? ips.example : undefined
        } : {};
        const tpl = PROMPTS['fhir_generate_resource'];
        return tpl({
          note_text,
          resource_reference: ref.reference,
          resource_description: ref.display,
          subject_ref: subjectRef,
          encounter_ref: encounterRef,
          ...ipsBits
        });
      })();

      const { result: genRes, meta: genMeta } = await (ctx as any).callLLMEx('fhir_generate_resource', genPrompt, {
        expect: 'json',
        tags: { phase: 'fhir', reference: ref.reference }
      });
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
      const MAX_ITERS = Number(localStorage.getItem('FHIR_VALIDATION_MAX_ITERS') || 12);
      let budget = MAX_ITERS;
      const trace: any[] = [];
      const attemptedQueriesByPtr = new Map<string, Set<string>>();
      const searchNotebook = new Map<string, Array<any>>();

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

      const buildRefinePrompt = (resObj: any, preReport: any[], valRes: any, budgetRemaining: number) => {
        const unresolved = preReport.filter((it: any) => it.status !== 'ok');
        const validatorErrors = (valRes?.issues || []);
        const attempts: Record<string, { queries: string[] }> = {};
        for (const [ptr, set] of attemptedQueriesByPtr.entries()) attempts[ptr] = { queries: Array.from(set) };
        const notebook: Record<string, any[]> = {};
        for (const [ptr, arr] of searchNotebook.entries()) notebook[ptr] = arr;

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

        const tpl = PROMPTS['fhir_resource_validate_refine'];
        return tpl({
          resource: resourceForPrompt,
          unresolvedCodings: unresolved,
          validatorErrors,
          attempts,
          searchNotebook: notebook,
          budgetRemaining
        });
      };

      const acceptedSteps: Array<{ stepKey: string; prompt?: string; raw?: string }> = [];
      while (budget > 0) {
        const { report } = await analyzeCodings([resource]);
        const preReport = report || [];
        const valRes = await validateResource(resource);
        const unresolved = preReport.filter((it: any) => it.status !== 'ok');
        if (unresolved.length === 0 && (valRes.valid || (valRes.issues || []).filter((x: any) => x.severity === 'error').length === 0)) {
          break;
        }
        const prompt = buildRefinePrompt(resource, preReport, valRes, budget);
        const { result: decision, meta } = await (ctx as any).callLLMEx('fhir_resource_validate_refine', prompt, { expect: 'json', tags: { phase: 'fhir', stage: 'validate-refine' } });
        const llmStepKey = meta?.stepKey;
        const action = String(decision?.action || '').toLowerCase();

        if (action === 'search_for_coding') {
          const ptr = decision?.pointer as string | undefined;
          const terms = decision?.terms;
          const systems = Array.isArray(decision?.systems) ? decision.systems : undefined;
          const provided: string[] = Array.isArray(terms)
            ? terms.map((t: any) => String(t || '').trim()).filter(Boolean)
            : (typeof terms === 'string' && String(terms).trim() ? [String(terms).trim()] : []);
          if (!ptr || provided.length === 0) {
            trace.push({ iter: MAX_ITERS - budget + 1, action: 'search_for_coding', error: 'missing pointer/terms', llmStepKey, decision });
            budget -= 1; continue;
          }
          const tried = attemptedQueriesByPtr.get(ptr) || new Set<string>();
          const lowerProvided = provided.map(q => q.toLowerCase());
          const newQueries = provided.filter((q, idx) => !tried.has(lowerProvided[idx]));
          if (newQueries.length === 0) {
            trace.push({ iter: MAX_ITERS - budget + 1, action: 'search_for_coding', pointer: ptr, queriesProvided: provided, queriesExecuted: [], systems, rejected: 'repeat_query', llmStepKey, decision });
            budget -= 1; continue;
          }
          for (const q of newQueries) tried.add(q.toLowerCase());
          attemptedQueriesByPtr.set(ptr, tried);
          const res: TerminologySearchResult = await searchTerminology(newQueries, systems, 200);
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
          trace.push({ iter: MAX_ITERS - budget + 1, action: 'search_for_coding', pointer: ptr, queriesProvided: provided, queriesExecuted: newQueries, systems, meta: entry.meta, resultsByQuery, llmStepKey, decision });
          budget -= 1; continue;
        }

        if (action === 'update') {
          const patch = Array.isArray(decision?.patch) ? decision.patch : [];
          if (!patch.length) {
            trace.push({ iter: MAX_ITERS - budget + 1, action: 'update', error: 'missing patch', llmStepKey, decision });
            budget -= 1; continue;
          }
          const candidate = applyJsonPatch(resource, patch);
          const valOk = await validateResource(candidate);
          if (!valOk.valid && (valOk.issues || []).filter((x: any) => x.severity === 'error').length > 0) {
            trace.push({ iter: MAX_ITERS - budget + 1, action: 'update', result: 'invalid_fhir', patch, llmStepKey, decision, validationIssues: valOk.issues });
            budget -= 1; continue;
          }
          const { report: candReport } = await analyzeCodings([candidate]);
          const before = summarizeIssues(preReport, valRes);
          const after = summarizeIssues(candReport, valOk);
          if (after.unresolvedCount < before.unresolvedCount || (after.unresolvedCount === before.unresolvedCount && after.errorCount < before.errorCount)) {
            resource = candidate;
            trace.push({ iter: MAX_ITERS - budget + 1, action: 'update', result: 'accepted', patch, before, after, rationale: decision?.rationale, llmStepKey, decision, validationIssuesAfter: valOk.issues });
            if (llmStepKey) acceptedSteps.push({ stepKey: llmStepKey, prompt: meta?.prompt, raw: meta?.raw });
            if (after.unresolvedCount === 0 && after.errorCount === 0) { budget -= 1; break; }
          } else {
            trace.push({ iter: MAX_ITERS - budget + 1, action: 'update', result: 'no_improvement', patch, before, after, rationale: decision?.rationale, llmStepKey, decision, validationIssuesAfter: valOk.issues });
          }
          budget -= 1; continue;
        }

        if (action === 'stop') {
          trace.push({ iter: MAX_ITERS - budget + 1, action: 'stop', rationale: decision?.rationale, llmStepKey, decision });
          budget = 0; break;
        }

        trace.push({ iter: MAX_ITERS - budget + 1, action: 'unknown', llmStepKey, decision });
        budget -= 1;
      }

      await emitJsonArtifact(ctx, {
        kind: 'FhirResourceValidationTrace',
        title: `Validation Trace for ${ref.reference}`,
        content: { reference: ref.reference, trace },
        tags: { phase: 'fhir', stage: 'validate-refine', reference: ref.reference }
      });

      try {
        const { report: afterReport } = await analyzeCodings([resource]);
        const valAfter = await validateResource(resource);
        const unresolvedItems = (afterReport || []).filter((it: any) => it.status !== 'ok');
        const issues = (valAfter?.issues || []);
        const isValid = unresolvedItems.length === 0 && issues.length === 0;
        const initialCopy = JSON.parse(JSON.stringify(resource));
        if (!isValid) {
          const extPayload = { unresolved: unresolvedItems, validationErrors: issues };
          const ext = { url: 'urn:validation-status', valueString: JSON.stringify(extPayload) } as any;
          if (Array.isArray(initialCopy.extension)) initialCopy.extension.push(ext);
          else initialCopy.extension = [ext];
        }
        // Emit the refined resource snapshot
        const lastAccepted = acceptedSteps[acceptedSteps.length - 1];
        await emitJsonArtifact(ctx, {
          kind: 'FhirResource',
          title: `${ref.reference} (refined)`,
          content: initialCopy,
          tags: { phase: 'fhir', stage: 'refined', resourceType: initialCopy.resourceType, valid: isValid, from: ref?.display, ...(lastAccepted ? { prompt: lastAccepted.prompt, raw: lastAccepted.raw } : {}) },
          links: acceptedSteps.length ? acceptedSteps.map(s => ({ dir: 'from' as const, role: 'produced', ref: { type: 'step' as const, id: s.stepKey } })) : undefined
        });
        // Emit a per-resource validation report
        await emitJsonArtifact(ctx, { kind: 'ValidationReport', title: `Validation Report for ${ref.reference}`, content: valAfter, tags: { phase: 'fhir', stage: 'refined', reference: ref.reference, valid: isValid } });
      } catch {}

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
