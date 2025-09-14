import { IPS_NOTES } from '../ips-notes';
import { searchTerminology, type TerminologySearchResult } from '../tools';
import { analyzeCodings, batchExists } from '../codingAnalysis';
import { validateResource } from '../validator';
import type { Context } from '../types';
import { FHIR_PROMPTS } from '../workflows/fhir/prompts';
import { runLLMTask } from '../llmTask';
import { emitJsonArtifact } from './artifacts';
import { sha256 } from '../helpers';
import type { Context } from '../types';
import { config } from '../config';

export async function generateAndRefineResources(
  ctx: Context,
  note_text: string,
  references: Array<{ reference: string; display: string }>,
  subjectRef?: string,
  encounterRef?: string,
  authorRef?: string
): Promise<any[]> {
  const GEN_CONC = ((): number => {
    try {
      const ov = (typeof localStorage !== 'undefined' && localStorage.getItem('OVERRIDE_FHIR_GEN_CONCURRENCY')) || '';
      if (ov && String(ov).trim()) {
        const n = Number(ov);
        if (Number.isFinite(n) && n >= 1) return n;
      }
    } catch {}
    try {
      return config.isReady() ? Math.max(1, Number(config.fhirGenConcurrency())) : 1;
    } catch {
      return 1;
    }
  })();
  const generatedResources: any[] = new Array(references.length);

  const processOne = async (ref: { reference: string; display: string }, idx: number) => {
    const genParams = (function buildGenParams() {
      const rtype = String(ref.reference || '').split('/')[0];
      const ips = (IPS_NOTES as any)[rtype];
      const ipsBits =
        ips ?
          {
            ips_notes: Array.isArray(ips.requirements) ? ips.requirements : undefined,
            ips_example: typeof ips.example === 'string' ? ips.example : undefined,
          }
        : {};
      return {
        note_text,
        resource_reference: ref.reference,
        resource_description: ref.display,
        subject_ref: subjectRef,
        encounter_ref: encounterRef,
        author_ref: authorRef,
        ...ipsBits,
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
        tags: {
          phase: 'fhir',
          stage: 'generated',
          resourceType: resource?.resourceType,
          from: ref?.display,
          prompt: genMeta?.prompt,
          raw: genMeta?.raw,
        },
        links:
          genMeta?.stepKey ?
            [{ dir: 'from', role: 'produced', ref: { type: 'step', id: genMeta.stepKey } }]
          : undefined,
      });
    } catch {}

    // Validate-refine loop per resource
    // Initial dynamic budget: max(default, validator_error_count + 2 * unresolved_codings + 5)
    const DEFAULT_ITERS = Number(localStorage.getItem('FHIR_VALIDATION_MAX_ITERS') || 12);
    try {
      const initReportRes = await analyzeCodings(ctx, [resource]);
      const initUnresolved = (initReportRes?.report || []).filter((it: any) => it.status !== 'ok').length;
      const initValRes = await validateResource(resource, ctx);
      const initErrors = (initValRes?.issues || []).filter(
        (x: any) => String(x?.severity || '').toLowerCase() === 'error'
      ).length;
      const MAX_ITERS = Math.max(DEFAULT_ITERS, initErrors + 2 * initUnresolved + 5);
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
        const segs = path
          .split('/')
          .filter(Boolean)
          .map((s) => decodeURIComponent(s));
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
      errorCount: (validation?.issues || []).filter((x: any) => x.severity === 'error').length,
    });

    // Accumulate feedback to surface in the next prompt (per unresolved pointer)
    const refineWarnings: Array<{
      pointer: string;
      invalid?: Array<{ system?: string; code?: string }>;
      partials?: Array<{ path: string }>;
      message?: string;
    }> = [];

    const buildRefinePrompt = (resObj: any, preReport: any[], valRes: any, budgetRemaining: number) => {
      const unresolved = preReport.filter((it: any) => it.status !== 'ok');
      const validatorErrors = (valRes?.issues || []).map((iss: any) => ({
        path: iss?.location || undefined,
        severity: iss?.severity,
        message: iss?.details,
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
      const warnings = (() => {
        try {
          const byPtr = new Map<string, any>();
          for (const w of refineWarnings || []) {
            if (w && typeof (w as any).pointer === 'string') byPtr.set((w as any).pointer, w);
          }
          return Array.from(byPtr.values());
        } catch {
          return refineWarnings || [];
        }
      })();
      const fmtScalar = (v: any) => {
        try {
          if (v == null) return '';
          return typeof v === 'object' ? JSON.stringify(v) : String(v);
        } catch {
          return String(v ?? '');
        }
      };
      const warningsNormalized = (warnings as any[]).map((w: any) => {
        const ptr = String(w?.pointer || '(unspecified)');
        const patchPayload =
          Array.isArray(w?.patchOps) && w.patchOps.length ? w.patchOps : w?.partials || w?.invalid || [];
        const patchJson = (() => {
          try {
            return JSON.stringify(patchPayload, null, 2);
          } catch {
            return String(patchPayload ?? '');
          }
        })();
        const reason = w?.message || 'invalid patch';
        const mustSearch = `YOU MUST PERFORM \"search_for_coding\" at { \"pointer\": \"${ptr}\" } before you can proceed.`;
        return {
          pointer: ptr,
          message: `YOU PREVIOUSLY SUBMITTED AN INVALID PATCH: ${patchJson} at ${ptr}; reason: ${reason}. ${mustSearch}`,
        } as any;
      });

      // Nudge: For unresolved Codings, replace code with a clear placeholder instead of removing it
      const CODE_PLACEHOLDER = '<requires search_for_coding to resolve>';
      // Replace .code in Coding objects that are unresolved to guide the model
      const resourceForPrompt = JSON.parse(JSON.stringify(resObj));
      const getObjByPointer = (root: any, pointer: string): any => {
        try {
          const segs = pointer
            .split('/')
            .filter(Boolean)
            .map((s) => decodeURIComponent(s));
          let cur = root;
          for (const s of segs) {
            const idx = String(Number(s)) === s ? Number(s) : s;
            cur = Array.isArray(cur) ? cur[idx as number] : cur?.[idx as any];
          }
          return cur;
        } catch {
          return undefined;
        }
      };
      for (const it of Array.isArray(unresolved) ? unresolved : []) {
        const ptr = String(it?.pointer || '');
        const obj = getObjByPointer(resourceForPrompt, ptr);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          try {
            if ('code' in obj) (obj as any).code = CODE_PLACEHOLDER;
          } catch {}
        }
      }

      // Also replace original.code in the Unresolved Codings summary to nudge search_for_coding
      const unresolvedForPrompt = (Array.isArray(unresolved) ? unresolved : []).map((u: any) => {
        try {
          const copy = JSON.parse(JSON.stringify(u));
          if (copy && copy.original && typeof copy.original === 'object') {
            copy.original.code = CODE_PLACEHOLDER;
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
        warnings: warningsNormalized,
        budgetRemaining,
      });
    };

    const acceptedSteps: Array<{ stepKey: string; prompt?: string; raw?: string }> = [];
    let extraTurns = 5;
    let iterCount = 0;
    while (budget > 0 || extraTurns > 0) {
      iterCount += 1;
      const resHash = await sha256(JSON.stringify(resource));
      const iterIndex = iterCount;
      const preflight = await ctx.step(
        `refine:validate:${resHash}`,
        async () => {
          const result = await validateResource(resource);
          const { report } = await analyzeCodings(ctx, [resource]);
          return { input: resource, result, terminology: report };
        },
        {
          title: 'Validate Candidate',
          tags: { phase: 'fhir', stage: 'validate-refine', refineIter: iterIndex },
        }
      );
      // Ensure validate step appears as a contributor in artifact step list
      try {
        contributedStepKeys.add(`refine:validate:${resHash}`);
      } catch {}
      const preReport = (preflight as any)?.terminology || [];
      const valRes = (preflight as any)?.result || preflight;
      const unresolved = preReport.filter((it: any) => it.status !== 'ok');
      if (
        unresolved.length === 0 &&
        (valRes.valid || (valRes.issues || []).filter((x: any) => x.severity === 'error').length === 0)
      ) {
        break;
      }
      const displayBudget = budget > 1 ? budget : 1;
      const prompt = buildRefinePrompt(resource, preReport, valRes, displayBudget);
      const { result: decision, meta } = await (ctx as any).callLLMEx('fhir_resource_validate_refine', prompt, {
        expect: 'json',
        tags: { phase: 'fhir', stage: 'validate-refine' },
      });
      llmCalls += 1;
      lastLLMMeta = { prompt: meta?.prompt, raw: meta?.raw, stepKey: meta?.stepKey };
      const llmStepKey = meta?.stepKey;
      if (llmStepKey) contributedStepKeys.add(llmStepKey);
      const action = String(decision?.action || '').toLowerCase();

      if (action === 'search_for_coding') {
        const ptr = decision?.pointer as string | undefined;
        const terms = decision?.terms;
        const systems = Array.isArray(decision?.systems) ? decision.systems : undefined;
        const provided: string[] =
          Array.isArray(terms) ? terms.map((t: any) => String(t || '').trim()).filter(Boolean)
          : typeof terms === 'string' && String(terms).trim() ? [String(terms).trim()]
          : [];
        if (!ptr || provided.length === 0) {
          trace.push({
            iter: INITIAL_BUDGET - budget + 1,
            action: 'search_for_coding',
            error: 'missing pointer/terms',
            llmStepKey,
            decision,
          });
          if (budget > 1) budget -= 1;
          else if (extraTurns > 0) extraTurns -= 1;
          else budget = 0;
          continue;
        }
        const tried = attemptedQueriesByPtr.get(ptr) || new Set<string>();
        const lowerProvided = provided.map((q) => q.toLowerCase());
        const newQueries = provided.filter((q, idx) => !tried.has(lowerProvided[idx]));
        if (newQueries.length === 0) {
          trace.push({
            iter: INITIAL_BUDGET - budget + 1,
            action: 'search_for_coding',
            pointer: ptr,
            queriesProvided: provided,
            queriesExecuted: [],
            systems,
            rejected: 'repeat_query',
            llmStepKey,
            decision,
          });
          if (budget > 1) budget -= 1;
          else if (extraTurns > 0) extraTurns -= 1;
          else budget = 0;
          continue;
        }
        // We are about to execute new searches for this pointer; clear prior warnings for it
        try {
          if (ptr) {
            for (let i = refineWarnings.length - 1; i >= 0; i--) {
              if (refineWarnings[i]?.pointer === ptr) refineWarnings.splice(i, 1);
            }
          }
        } catch {}
        for (const q of newQueries) tried.add(q.toLowerCase());
        attemptedQueriesByPtr.set(ptr, tried);
        const qHash = await sha256(JSON.stringify({ q: newQueries, systems: systems || [] }));
        const res: TerminologySearchResult =
          (await (ctx as any).step?.(
            `tx:search:${qHash}`,
            async () => {
              return await searchTerminology(newQueries, systems, 200);
            },
            { title: 'Terminology Search', tags: { phase: 'terminology', pointer: ptr } }
          )) ?? (await searchTerminology(newQueries, systems, 200));
        // Preserve actual results per query without flattening/truncation
        const resultsByQuery =
          Array.isArray(res.perQueryHits) ?
            res.perQueryHits.map((q) => ({
              query: q.query,
              hits: (q.hits || []).map((h) => ({
                system: h.system,
                code: h.code,
                display: h.display,
              })),
            }))
          : newQueries.map((q) => ({
              query: q,
              hits: [] as Array<{ system: string; code: string; display: string }>,
            }));
        const entry = {
          queries: newQueries,
          systems: systems || [],
          meta: {
            count: res.count,
            fullSystem: !!res.fullSystem,
            guidance: res.guidance,
            perQuery: res.perQuery,
          },
          resultsByQuery,
        };
        const arr = searchNotebook.get(ptr) || [];
        arr.push(entry);
        searchNotebook.set(ptr, arr);
        trace.push({
          iter: INITIAL_BUDGET - budget + 1,
          action: 'search_for_coding',
          pointer: ptr,
          queriesProvided: provided,
          queriesExecuted: newQueries,
          systems,
          meta: entry.meta,
          resultsByQuery,
          llmStepKey,
          decision,
        });
        if (budget > 1) budget -= 1;
        else if (extraTurns > 0) extraTurns -= 1;
        else budget = 0;
        continue;
      }

      if (action === 'update') {
        // Helper: map a patch path to the base Coding pointer (e.g., '/code/coding/0')
        const baseCodingPtr = (p: string): string | null => {
          const segs = String(p || '')
            .split('/')
            .filter(Boolean)
            .map((s) => decodeURIComponent(s));
          if (segs.length === 0) return null;
          const i = segs.findIndex((s) => s === 'coding');
          if (i >= 0) {
            const next = segs[i + 1];
            if (next != null && String(Number(next)) === next) {
              return (
                '/' +
                segs
                  .slice(0, i + 2)
                  .map((s) => encodeURIComponent(s))
                  .join('/')
              );
            }
            return (
              '/' +
              segs
                .slice(0, i + 1)
                .map((s) => encodeURIComponent(s))
                .join('/')
            );
          }
          // Fallback: if path ends with '/system' or '/code', use its parent as the base
          const last = segs[segs.length - 1];
          if (last === 'system' || last === 'code') {
            return (
              '/' +
              segs
                .slice(0, -1)
                .map((s) => encodeURIComponent(s))
                .join('/')
            );
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
        const detectPartialCodeUpdates = (
          ops: Array<any>
        ): Array<{ pointer: string; missing: Array<'system' | 'display'> }> => {
          const touched = new Map<
            string,
            {
              code?: boolean;
              system?: boolean;
              display?: boolean;
              whole?: { system?: boolean; display?: boolean; code?: boolean };
            }
          >();
          for (const op of ops) {
            const path = String(op?.path || '');
            const ptr = baseCodingPtr(path);
            if (!ptr) continue;
            const rec = touched.get(ptr) || {};
            if (
              (op?.op === 'replace' || op?.op === 'add') &&
              path === ptr &&
              op &&
              typeof op.value === 'object' &&
              op.value &&
              !Array.isArray(op.value)
            ) {
              const v = op.value as any;
              rec.whole = { system: 'system' in v, display: 'display' in v, code: 'code' in v };
            }
            if (path.endsWith('/code')) rec.code = true;
            if (path.endsWith('/system')) rec.system = true;
            if (path.endsWith('/display')) rec.display = true;
            touched.set(ptr, rec);
          }
          const partials: Array<{ pointer: string; missing: Array<'system' | 'display'> }> = [];
          for (const [ptr, rec] of touched.entries()) {
            const codeChanged = !!rec.code || !!rec.whole?.code;
            if (!codeChanged) continue;
            const hasSystem = !!rec.system || !!rec.whole?.system;
            const hasDisplay = !!rec.display || !!rec.whole?.display;
            const missing: Array<'system' | 'display'> = [];
            if (!hasSystem) missing.push('system');
            if (!hasDisplay) missing.push('display');
            if (missing.length > 0) partials.push({ pointer: ptr, missing });
          }
          return partials;
        };

        const introducedByPtr = collectIntroduced(Array.isArray(decision?.patch) ? decision.patch : []);

        // Validate that all introduced codes appear in ANY searchNotebook entry for that pointer (latest or earlier in this round)
        const introducedInvalid = (): Array<{
          pointer: string;
          system?: string;
          code?: string;
        }> => {
          const invalid: Array<{ pointer: string; system?: string; code?: string }> = [];
          // Relaxed policy: allowed if code appears anywhere in the Search Notebook
          const allowedAll = new Set<string>();
          for (const entries of searchNotebook.values()) {
            for (const entry of entries || []) {
              if (!Array.isArray(entry?.resultsByQuery)) continue;
              for (const q of entry.resultsByQuery) {
                for (const h of q.hits || []) {
                  const key = `${String(h.system || '').trim()}|${String(h.code || '').trim()}`;
                  allowedAll.add(key);
                }
              }
            }
          }
          for (const [ptr, arr] of introducedByPtr.entries()) {
            for (const x of arr) {
              const key = `${String(x.system || '').trim()}|${String(x.code || '').trim()}`;
              if (!x.system && !x.code) continue; // ignore non-coding structural edits
              if (!allowedAll.has(key)) invalid.push({ pointer: ptr, system: x.system, code: x.code });
            }
          }
          return invalid;
        };

        // Skip retry path; rely on the first decision as-is
        let localDecision = decision;
        let localMeta = meta;

        // We no longer reject or redact codes prior to application. Any guidance will be surfaced via warnings.
        // Prepare patch array before analyzing partial-code updates
        const patch = Array.isArray(localDecision?.patch) ? localDecision.patch : [];
        // Detect partial-code updates (changed 'code' without also setting 'system' and 'display')
        const partialIssues = detectPartialCodeUpdates(patch);
        if (partialIssues.length > 0) {
          // Tag current step for UI visibility
          try {
            if (localMeta?.stepKey) {
              const rec = await ctx.stores.steps.get((ctx as any).jobId, localMeta.stepKey);
              if (rec) {
                const t = rec.tagsJson ? JSON.parse(rec.tagsJson) : {};
                const existing = Array.isArray(t.refineDetails?.partials) ? t.refineDetails.partials : [];
                const partialPayload = partialIssues.map((p) => ({ pointer: p.pointer, missing: p.missing }));
                t.refineDecision = t.refineDecision || 'filtered';
                t.refineDetails = { ...(t.refineDetails || {}), partials: [...existing, ...partialPayload] };
                await ctx.stores.steps.put({ ...rec, tagsJson: JSON.stringify(t) });
              }
            }
          } catch {}
          // Prepare concise warnings for next prompt
          try {
            // Group by pointer
            const byPtr = new Map<string, Array<{ missing: Array<'system' | 'display'> }>>();
            for (const it of partialIssues) {
              const arr = byPtr.get(it.pointer) || [];
              arr.push({ missing: it.missing });
              byPtr.set(it.pointer, arr);
            }
            for (const [ptr, arr] of byPtr.entries()) {
              const patchOps =
                Array.isArray(patch) ?
                  (patch as any[]).filter((op: any) => {
                    const p = String(op?.path || '');
                    return p === ptr || p.startsWith(ptr + '/');
                  })
                : [];
              refineWarnings.push({
                pointer: ptr,
                partials: arr.map((a) => ({ path: ptr, ...(a as any) })),
                patchOps,
                message:
                  "Partial Coding update is invalid: when changing 'code', also set 'system' and 'display' in the same replacement.",
              });
            }
          } catch {}
        }
        // Partial-code update redaction not applied (policy opts for rejection rather than partial redaction)

        if (!patch.length) {
          trace.push({
            iter: INITIAL_BUDGET - budget + 1,
            action: 'update',
            error: 'missing patch',
            llmStepKey: localMeta?.stepKey,
            decision: localDecision,
          });
          if (budget > 1) budget -= 1;
          else if (extraTurns > 0) extraTurns -= 1;
          else budget = 0;
          continue;
        }
        // Apply patch as-is, but normalize display fields when the chosen system|code exists in the Search Notebook
        const normalizedPatch = (() => {
          try {
            const hits = new Map<string, string>();
            for (const arr of searchNotebook.values()) {
              for (const entry of arr || []) {
                for (const q of entry?.resultsByQuery || []) {
                  for (const h of q?.hits || []) {
                    const key = `${String(h.system || '').trim()}|${String(h.code || '').trim()}`;
                    if (key && typeof h.display === 'string' && h.display) hits.set(key, String(h.display));
                  }
                }
              }
            }
            const cloneOps = (patch as any[]).map((op) => {
              try {
                if (!op || (op.op !== 'replace' && op.op !== 'add')) return op;
                const v = op.value;
                const keyOf = (sys?: any, code?: any) => `${String(sys || '').trim()}|${String(code || '').trim()}`;
                if (v && typeof v === 'object' && !Array.isArray(v) && ('system' in v || 'code' in v)) {
                  const key = keyOf((v as any).system, (v as any).code);
                  const disp = hits.get(key);
                  if (disp && String((v as any).display || '') !== disp) {
                    return { ...op, value: { ...(v as any), display: disp } };
                  }
                } else if (v && typeof v === 'object' && Array.isArray((v as any).coding)) {
                  const cc = v as any;
                  let changed = false;
                  const newCoding = cc.coding.map((c: any) => {
                    if (!c) return c;
                    const key = keyOf(c.system, c.code);
                    const disp = hits.get(key);
                    if (disp && String(c.display || '') !== disp) {
                      changed = true;
                      return { ...c, display: disp };
                    }
                    return c;
                  });
                  if (changed) return { ...op, value: { ...cc, coding: newCoding } };
                }
                return op;
              } catch {
                return op;
              }
            });
            return cloneOps;
          } catch {
            return patch as any[];
          }
        })();
        const candidate = applyJsonPatch(resource, normalizedPatch);
        const candHash = await sha256(JSON.stringify(candidate));
        // Single combined step: validate candidate and include terminology (coding) analysis
        const combinedBundle = await ctx.step(
          `refine:validate:${candHash}`,
          async () => {
            const result = await validateResource(candidate);
            const { report } = await analyzeCodings(ctx, [candidate]);
            return { input: candidate, result, terminology: report };
          },
          {
            title: 'Validate Candidate',
            tags: {
              phase: 'fhir',
              stage: 'validate-refine',
              refineIter: INITIAL_BUDGET - budget + 1,
            },
          }
        );
        const valOk = combinedBundle?.result || combinedBundle;
        // Ensure this step appears in artifact step list
        try {
          contributedStepKeys.add(`refine:validate:${candHash}`);
        } catch {}
        // Accept unconditionally. Validator/analyzer output is for feedback only.
        resource = candidate;
        // Compute coding pointers actually changed by the patch (for trace only)
        const changedPtrs = Array.from(
          new Set(
            normalizedPatch
              .map((op: any) => baseCodingPtr(String(op?.path || '')))
              .filter((p: any) => typeof p === 'string' && p)
          )
        );
        trace.push({
          iter: INITIAL_BUDGET - budget + 1,
          action: 'update',
          result: 'accepted',
          patch: normalizedPatch,
          changedPointers: changedPtrs,
          rationale: localDecision?.rationale,
          llmStepKey: localMeta?.stepKey,
          decision: localDecision,
          validationIssuesAfter: valOk.issues,
        });
        if (localMeta?.stepKey) {
          acceptedSteps.push({
            stepKey: localMeta.stepKey,
            prompt: localMeta?.prompt,
            raw: localMeta?.raw,
          });
          try {
            const rec = await ctx.stores.steps.get((ctx as any).jobId, localMeta.stepKey);
            if (rec) {
              const t = rec.tagsJson ? JSON.parse(rec.tagsJson) : {};
              t.refineDecision = 'accepted';
              t.refineDetails = { changedPointers: changedPtrs };
              await ctx.stores.steps.put({ ...rec, tagsJson: JSON.stringify(t) });
            }
          } catch {}
        }
        // Also tag the corresponding validate step as accepted so the badge appears there too
        try {
          const validateStepKey = `refine:validate:${candHash}`;
          const rec2 = await ctx.stores.steps.get((ctx as any).jobId, validateStepKey);
          if (rec2) {
            const t2 = rec2.tagsJson ? JSON.parse(rec2.tagsJson) : {};
            t2.refineDecision = 'accepted';
            t2.refineDetails = { changedPointers: changedPtrs };
            await ctx.stores.steps.put({ ...rec2, tagsJson: JSON.stringify(t2) });
          }
        } catch {}
        if (budget > 1) budget -= 1;
        else if (extraTurns > 0) extraTurns -= 1;
        else budget = 0;
        continue;
        // (duplicate legacy block removed)
      }

      if (action === 'stop') {
        trace.push({
          iter: INITIAL_BUDGET - budget + 1,
          action: 'stop',
          rationale: decision?.rationale,
          llmStepKey,
          decision,
        });
        budget = 0;
        extraTurns = 0;
        break;
      }

      trace.push({ iter: INITIAL_BUDGET - budget + 1, action: 'unknown', llmStepKey, decision });
      if (budget > 1) budget -= 1;
      else if (extraTurns > 0) extraTurns -= 1;
      else budget = 0;
    }

    const traceArtifact = await emitJsonArtifact(ctx, {
      kind: 'FhirResourceValidationTrace',
      title: `Validation Trace for ${ref.reference}`,
      content: { reference: ref.reference, trace },
      tags: { phase: 'fhir', stage: 'validate-refine', reference: ref.reference },
    });

    let postUnresolved = 0;
    let postIssues = 0;
    let isValid = false;
    try {
      const { report: afterReport } = await analyzeCodings(ctx, [resource]);
      const valAfter = await validateResource(resource, ctx);
      const unresolvedItems = (afterReport || []).filter((it: any) => it.status !== 'ok');
      const issues = valAfter?.issues || [];
      postUnresolved = unresolvedItems.length;
      postIssues = issues.length;
      isValid = postUnresolved === 0 && postIssues === 0;
      const initialCopy = JSON.parse(JSON.stringify(resource));
      if (!isValid) {
        // Attach issue extensions at the CodeableConcept level (where available), not at the top-level resource.
        const EXT_URL = 'http://kraken.fhir.me/StructureDefinition/coding-issue';
        const getByPtr = (root: any, pointer: string): any => {
          try {
            const segs = pointer
              .split('/')
              .filter(Boolean)
              .map((s) => decodeURIComponent(s));
            let cur = root;
            for (const s of segs) {
              const idx = String(Number(s)) === s ? Number(s) : s;
              cur = Array.isArray(cur) ? cur[idx as number] : cur?.[idx as any];
            }
            return cur;
          } catch {
            return undefined;
          }
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
            setExt(tgt, {
              pointer: u.pointer,
              original: u.original,
              reason: u.reason,
              note: 'unresolved_coding',
            });
          }
        }
        // Also, annotate the resource with a single summary of validation errors (non-blocking)
        if ((issues || []).length) {
          const cur = Array.isArray(initialCopy.extension) ? initialCopy.extension : [];
          const filtered = cur.filter((e: any) => e?.url !== 'urn:validation-status');
          filtered.push({
            url: 'urn:validation-status',
            valueString: JSON.stringify({ validationErrors: issues }),
          });
          initialCopy.extension = filtered;
        }
      }
      // Emit the refined resource snapshot
      const lastAccepted = acceptedSteps[acceptedSteps.length - 1];
      // Prefer accepted step prompt/raw; otherwise fall back to the last refine LLM meta
      const promptForTags = lastAccepted?.prompt || lastLLMMeta?.prompt;
      const rawForTags = lastAccepted?.raw || lastLLMMeta?.raw;

      // Build links: produced = accepted steps (or fallback to last step); contributed = all refine steps
      const producedLinks =
        acceptedSteps.length ?
          acceptedSteps.map((s) => ({
            dir: 'from' as const,
            role: 'produced',
            ref: { type: 'step' as const, id: s.stepKey },
          }))
        : lastLLMMeta?.stepKey ?
          [
            {
              dir: 'from' as const,
              role: 'produced',
              ref: { type: 'step' as const, id: lastLLMMeta.stepKey },
            },
          ]
        : [];
      const producedIds = new Set(producedLinks.map((l) => l.ref.id));
      const contributedLinks = Array.from(contributedStepKeys)
        .filter((id) => !producedIds.has(id))
        .map((id) => ({
          dir: 'from' as const,
          role: 'contributed',
          ref: { type: 'step' as const, id },
        }));

      await emitJsonArtifact(ctx, {
        kind: 'FhirResource',
        title: `${ref.reference} (refined)`,
        content: initialCopy,
        tags: {
          phase: 'fhir',
          stage: 'refined',
          resourceType: initialCopy.resourceType,
          valid: isValid,
          from: ref?.display,
          ...(promptForTags ? { prompt: promptForTags } : {}),
          ...(rawForTags ? { raw: rawForTags } : {}),
        },
        links: [
          ...producedLinks,
          ...contributedLinks,
          ...(traceArtifact ?
            [
              {
                dir: 'from' as const,
                role: 'uses',
                ref: { type: 'artifact' as const, id: traceArtifact.id },
              },
            ]
          : []),
        ],
      });
      // Emit a per-resource validation report
      await emitJsonArtifact(ctx, {
        kind: 'ValidationReport',
        title: `Validation Report for ${ref.reference}`,
        content: valAfter,
        tags: { phase: 'fhir', stage: 'refined', reference: ref.reference, valid: isValid },
      });
      resource = initialCopy;
    } catch {}

    // Fail loudly if we expected refine calls but captured no LLM trace
    if ((postUnresolved > 0 || postIssues > 0) && llmCalls === 0) {
      throw new Error(
        `No LLM refine trace captured for ${ref.reference} despite unresolved/validation errors. Halting pipeline.`
      );
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
