import type { ID, Artifact, Step, Link, Context, Stores } from './types';
import { sha256, nowIso, tolerantJsonParse, resolveTaskConfig, toEnvKey } from './helpers';
import { PROMPTS } from './prompts';

class ConcurrencyPool {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    // Wait for a slot to be released
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  release(): void {
    if (this.active > 0) this.active--;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        next();
      }
    }
  }
}

const llmMaxConcurrency = Number(localStorage.getItem('LLM_MAX_CONCURRENCY') ?? 4);
const llmPool = new ConcurrencyPool(llmMaxConcurrency);

let currentStepStack: string[] = [];

function isDebugEnabled(): boolean {
  try {
    // localStorage flag takes precedence (default OFF)
    const v = localStorage.getItem('WORKFLOW_DEBUG');
    if (v != null) return !/^0|false|off$/i.test(v);
  } catch {}
  try {
    // globalThis flag alternative
    const g: any = (globalThis as any);
    if (g && g.WORKFLOW_DEBUG != null) return !/^0|false|off$/i.test(String(g.WORKFLOW_DEBUG));
  } catch {}
  return false;
}

function dbg(type: string, details?: Record<string, any>) {
  if (!isDebugEnabled()) return;
  const ts = nowIso();
  const base = { ts, type, wf: currentStepStack[0] || undefined };
  try {
    console.log('[WF]', JSON.stringify({ ...base, ...(details || {}) }));
  } catch {
    console.log('[WF]', ts, type);
  }
}

export class PauseForApprovalError extends Error {
  stepKey: string;
  reason: string;
  constructor(stepKey: string, reason: string) {
    super(reason);
    this.stepKey = stepKey;
    this.reason = reason;
  }
}

class LLMCallError extends Error {
  rawContent?: string;
  status?: number;
  constructor(message: string, opts?: { rawContent?: string; status?: number }) {
    super(message);
    this.rawContent = opts?.rawContent;
    this.status = opts?.status;
  }
}

export function makeContext(stores: Stores, workflowId: ID, documentId: ID): Context {
  currentStepStack = [];

  async function step(key: string, fn: () => Promise<any>, opts: { title?: string; tags?: Record<string, any>; parentKey?: string; forceRecompute?: boolean; prompt?: string; } = {}): Promise<any> {
    const fullKey = opts.parentKey ? `${opts.parentKey}:${key}` : key;
    const reqT0 = Date.now();
    const existing = await stores.steps.get(workflowId, fullKey);
    // Initial request log
    dbg('step.request', { key: fullKey, title: opts.title, parent: opts.parentKey, cachedCandidate: !!(existing && existing.status === 'done' && !opts.forceRecompute) });
    if (existing && existing.status === "done" && !opts.forceRecompute) {
      stores.events.emit({ type: "step_replayed", workflowId, key: fullKey, title: opts.title, tags: opts.tags || {} });
      const r0 = Date.now();
      const val = JSON.parse(existing.resultJson);
      const replayMs = Date.now() - r0;
      dbg('step.replay', { key: fullKey, title: opts.title, parent: opts.parentKey, cached: true, origDurationMs: existing.durationMs, replayMs });
      dbg('step.response', { key: fullKey, title: opts.title, fromCache: true, responseMs: Date.now() - reqT0 });
      return val;
    }
    const rec: Partial<Step> = {
      workflowId, key: fullKey, title: opts.title, status: "running", resultJson: "", tagsJson: opts.tags ? JSON.stringify(opts.tags) : null,
      parentKey: opts.parentKey ?? currentStepStack.at(-1) ?? null, error: null, progress: 0, durationMs: null, llmTokens: null, prompt: opts.prompt ?? null, ts: nowIso()
    };
    await stores.steps.put(rec);
    currentStepStack.push(fullKey);

    const t0 = Date.now();
    dbg('step.begin', { key: fullKey, title: opts.title, parent: rec.parentKey, tags: opts.tags });
    try {
      const out = await fn();
      // Refetch the record to ensure we have the latest tags from sub-steps (e.g. llmRaw from callLLM)
      const finalRec = await stores.steps.get(workflowId, fullKey);
      const updatedRec = { ...(finalRec || rec) };

      updatedRec.status = "done";
      updatedRec.progress = 1;
      updatedRec.durationMs = Date.now() - t0;
      updatedRec.resultJson = JSON.stringify(out);
      await stores.steps.put(updatedRec);
      stores.events.emit({ type: "step_saved", ...updatedRec, tags: opts.tags || {}, documentId });
      dbg('step.end', { key: fullKey, ok: true, durationMs: updatedRec.durationMs });
      dbg('step.response', { key: fullKey, title: opts.title, fromCache: false, responseMs: Date.now() - reqT0 });
      return out;
    } catch (e: unknown) {
      rec.status = "failed";
      rec.error = String((e as Error)?.message || e);
      rec.durationMs = Date.now() - t0;
      // If LLM error provided raw content, persist it for debugging
      const raw = (e as any)?.rawContent;
      const status = (e as any)?.status;
      const stack = (e as any)?.stack || (new Error(String(rec.error))).stack;
      if (raw != null) {
        try {
          rec.resultJson = JSON.stringify({ error: rec.error, raw, status, stack });
        } catch {}
      }
      await stores.steps.put(rec);
      stores.events.emit({ type: "step_saved", ...rec, tags: opts.tags || {}, documentId });
      dbg('step.end', { key: fullKey, ok: false, durationMs: rec.durationMs, error: rec.error });
      dbg('step.response', { key: fullKey, title: opts.title, fromCache: false, responseMs: Date.now() - reqT0, error: rec.error });
      throw e;
    } finally {
      currentStepStack.pop();
    }
  }

  async function group(title: string, tags: Record<string, any>, fn: () => Promise<void>): Promise<void> {
    const parent = currentStepStack.at(-1) || '';
    const hashed = await sha256(`${title}:${parent}`);
    const groupKey = `group:${hashed}`;
    await step(groupKey, fn, { title, parentKey: currentStepStack.at(-1), tags });
  }

  async function span(title: string, tags: Record<string, any>, fn: () => Promise<void>): Promise<void> {
    const parent = currentStepStack.at(-1) || '';
    const unique = `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const spanKey = `span:${await sha256(`${title}:${parent}:${unique}`)}`;
    await step(spanKey, fn, { title, parentKey: currentStepStack.at(-1), tags, forceRecompute: true });
  }

  async function getStepResult(stepKey: string): Promise<any> {
    const rec = await stores.steps.get(workflowId, stepKey);
    return rec && rec.status === "done" ? JSON.parse(rec.resultJson) : undefined;
  }

  async function isPhaseComplete(phaseName: string): Promise<boolean> {
    const phaseSteps = await stores.steps.listByWorkflow(workflowId);
    const phaseKeys = phaseSteps.filter(s => s.key.startsWith(`phase:${phaseName}:`));
    return phaseKeys.length > 0 && phaseKeys.every(s => s.status === "done");
  }

  async function link(from: { type: string; id: ID }, role: string, to: { type: string; id: ID }, tags?: Record<string, any>): Promise<Link> {
    const id = `link:${await sha256(`${documentId}:${from.type}:${from.id}:${role}:${to.type}:${to.id}`)}`;
    const rec: Link = {
      id, documentId,
      fromType: from.type as any, fromId: from.id,
      toType: to.type as any, toId: to.id,
      role, tags, createdAt: nowIso()
    };
    await stores.links.upsert(rec);
    return rec;
  }

  async function createArtifact(spec: { id?: ID; kind: string; version: number; title?: string; content?: string; tags?: Record<string, any>; links?: Array<{ dir: "from"; role: string; ref: { type: string; id: ID }; tags?: Record<string, any>; }>; autoProduced?: boolean; }): Promise<Artifact> {
    const id = spec.id ?? `artifact:${await sha256(`${documentId}:${spec.kind}:${spec.version}:${spec.title || ""}:${JSON.stringify(spec.tags || {})}`)}`;
    const base: Artifact = {
      id, documentId, kind: spec.kind, version: spec.version,
      title: spec.title, content: spec.content, tags: spec.tags,
      createdAt: nowIso(), updatedAt: nowIso()
    };
    await stores.artifacts.upsert(base);

    const curStepKey = currentStepStack.at(-1);
    if (curStepKey && spec.autoProduced !== false) {
      await link({ type: "step", id: curStepKey }, "produced", { type: "artifact", id: base.id });
    }

    for (const l of spec.links || []) {
      const from = l.dir === "from" ? { type: "artifact", id: base.id } : l.ref;
      const to = l.dir === "from" ? l.ref : { type: "artifact", id: base.id };
      await link(from, l.role, to, l.tags);
    }
    return base;
  }

  async function callLLMCore(
    modelTask: string,
    prompt: string,
    opts?: { expect?: "text" | "json"; temperature?: number; tags?: Record<string, any>; }
  ): Promise<{ result: any; meta: { stepKey: string; tokensUsed: number; raw: string; attempts: number; status?: number; prompt: string } }> {
    const fullKey = `llm:${modelTask}:${await sha256(prompt)}`;
    let metaLocal: { tokensUsed: number; raw: string; attempts: number; status?: number } | null = null;
    const result = await step(fullKey, async () => {
      const { result, tokensUsed, raw, attempts, status } = await llmCall(modelTask, prompt, opts ?? {});
      metaLocal = { tokensUsed, raw, attempts, status };
      const stepRec = await stores.steps.get(workflowId, fullKey);
      if (stepRec) {
        const tags = stepRec.tagsJson ? JSON.parse(stepRec.tagsJson) : {};
        const newTags = { ...tags, modelTask, attempts, llmRaw: raw };
        await stores.steps.put({ ...stepRec, llmTokens: tokensUsed, prompt, tagsJson: JSON.stringify(newTags) });
      }
      return result;
    }, { title: `LLM: ${modelTask}`, tags: { ...(opts?.tags || {}), modelTask }, prompt });
    const meta = { stepKey: fullKey, tokensUsed: metaLocal?.tokensUsed || 0, raw: metaLocal?.raw || '', attempts: metaLocal?.attempts || 1, status: metaLocal?.status, prompt };
    return { result, meta };
  }

  async function callLLM(modelTask: string, prompt: string, opts?: { expect?: "text" | "json"; temperature?: number; tags?: Record<string, any>; }): Promise<any> {
    const { result } = await callLLMCore(modelTask, prompt, opts);
    return result;
  }

  async function callLLMEx(
    modelTask: string,
    prompt: string,
    opts?: { expect?: "text" | "json"; temperature?: number; tags?: Record<string, any>; }
  ): Promise<{ result: any; meta: { stepKey: string; tokensUsed: number; raw: string; attempts: number; status?: number; prompt: string } }> {
    return callLLMCore(modelTask, prompt, opts);
  }

  return {
    workflowId, documentId, stores,
    step, group, span, getStepResult, isPhaseComplete,
    createArtifact, link,
    callLLM,
    callLLMEx
  };
}

async function llmCall(task: string, prompt: string, { expect = "text", temperature }: { expect?: "text" | "json"; temperature?: number; } = {}): Promise<{ result: any; tokensUsed: number; raw: string; attempts: number; status?: number }> {
  const cfg = resolveTaskConfig(task);
  if (!cfg.apiKey) throw new Error("API key required for LLM; set localStorage 'TASK_DEFAULT_API_KEY'");
  const retries = Number(localStorage.getItem('TASK_DEFAULT_RETRIES') ?? 3);
  let lastRaw = '';
  let lastStatus: number | undefined = undefined;

  await llmPool.acquire();
  try {
    for (let attempt = 1; attempt <= retries; attempt++) {
      const a0 = Date.now();
      dbg('llm.fetch.begin', { task, attempt, expect, temperature: temperature ?? cfg.temperature });
      const response = await fetch(`${cfg.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          temperature: temperature ?? cfg.temperature ?? 0.2,
          messages: [
            { role: "system", content: expect === "json" ? "Return only JSON. No commentary." : "You write narrative text." },
            { role: "user", content: prompt }
          ],
          response_format: expect === "json" ? { type: "json_object" } : undefined
        })
      });
      if (!response.ok) {
        const body = await response.text();
        lastRaw = body;
        lastStatus = response.status;
        dbg('llm.fetch.end', { task, attempt, ok: false, httpStatus: response.status, durationMs: Date.now() - a0 });
        if (attempt >= retries) {
          throw new LLMCallError(`LLM HTTP error ${response.status}: ${response.statusText} (after ${retries} attempts)`, { rawContent: body, status: response.status });
        }
        continue;
      }
      const data = await response.json();
      const content = data.choices[0]?.message?.content ?? "";
      lastRaw = content;
      const tokensUsed = data.usage?.total_tokens ?? 0;
      dbg('llm.fetch.end', { task, attempt, ok: true, httpStatus: lastStatus, durationMs: Date.now() - a0, tokensUsed });
      if (expect === "json") {
        const obj = tolerantJsonParse(content);
        if (!obj) {
          if (attempt >= retries) {
            throw new LLMCallError(`LLM returned non-JSON content (after ${retries} attempts)`, { rawContent: content, status: lastStatus });
          }
          continue;
        }
        return { result: obj, tokensUsed, raw: content, attempts: attempt, status: lastStatus };
      }
      return { result: content, tokensUsed, raw: content, attempts: attempt, status: lastStatus };
    }
  } finally {
    llmPool.release();
  }
  // Should not reach here, but throw with last raw
  throw new LLMCallError(`LLM call failed (exhausted ${retries} attempts)`, { rawContent: lastRaw });
}

export async function runWorkflow(stores: Stores, workflowId: ID, documentId: ID, pipeline: Array<(ctx: Context) => Promise<void>>): Promise<void> {
  const ctx = makeContext(stores, workflowId, documentId);
  const wfStart = Date.now();
  try { dbg('workflow.run.begin', { workflowId, documentId, phases: pipeline.length }); } catch {}
  await stores.workflows.setStatus(workflowId, "running");
  // Reflect running state at the document level for accurate UI/error clearing
  await stores.documents.updateStatus(documentId, "running");
  try {
    for (const phaseFn of pipeline) {
      await phaseFn(ctx);
    }
    await stores.workflows.setStatus(workflowId, "done");
    await stores.documents.updateStatus(documentId, "done");
    dbg('workflow.run.end', { workflowId, documentId, status: 'done', durationMs: Date.now() - wfStart });
  } catch (e: any) {
    if (e instanceof PauseForApprovalError) {
      await stores.workflows.setStatus(workflowId, "pending", e.reason);
      dbg('workflow.run.end', { workflowId, documentId, status: 'pending', reason: e.reason, durationMs: Date.now() - wfStart });
      return;
    }
    await stores.workflows.setStatus(workflowId, "failed", String(e?.message || e));
    await stores.documents.updateStatus(documentId, "blocked");
    dbg('workflow.run.end', { workflowId, documentId, status: 'failed', error: String(e?.message || e), durationMs: Date.now() - wfStart });
    throw e;
  }
}
