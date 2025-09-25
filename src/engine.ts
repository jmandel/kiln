import type { ID, Artifact, Step, Link, Context, Stores } from './types';
import { sha256, nowIso, tolerantJsonParse, resolveTaskConfig, toEnvKey } from './helpers';
import { config as appConfig } from './config';
import { PROMPTS } from './prompts';

class ConcurrencyPool {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private limit: number) {}

  setLimit(limit: number) {
    this.limit = Math.max(1, limit);
  }

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

const llmPool = new ConcurrencyPool(4);
// Update concurrency once config is ready
try {
  appConfig.ready().then(() => {
    try {
      const override = ((): number | null => {
        try {
          const v = localStorage.getItem('OVERRIDE_LLM_MAX_CONCURRENCY');
          const n = v != null ? Number(v) : NaN;
          return Number.isFinite(n) && n > 0 ? n : null;
        } catch {
          return null;
        }
      })();
      llmPool.setLimit(override ?? appConfig.llmMaxConcurrency());
    } catch {}
  });
} catch {}

let currentStepStack: string[] = [];

function isDebugEnabled(): boolean {
  try {
    // localStorage flag takes precedence (default OFF)
    const v = localStorage.getItem('WORKFLOW_DEBUG');
    if (v != null) return !/^0|false|off$/i.test(v);
  } catch {}
  try {
    // globalThis flag alternative
    const g: any = globalThis as any;
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

export class StaleRunError extends Error {
  ctxRun: number;
  latestRun: number;
  constructor(ctxRun: number, latestRun: number, message?: string) {
    super(message || 'Stale run');
    this.ctxRun = ctxRun;
    this.latestRun = latestRun;
  }
}

export class JobDeletedError extends Error {
  constructor(message?: string) {
    super(message || 'Job was deleted');
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

export function makeContext(stores: Stores, jobId: ID, extras?: { type?: string; inputs?: any }): Context {
  currentStepStack = [];

  async function step(
    key: string,
    fn: () => Promise<any>,
    opts: {
      title?: string;
      tags?: Record<string, any>;
      parentKey?: string;
      forceRecompute?: boolean;
      prompt?: string;
    } = {}
  ): Promise<any> {
    const fullKey = opts.parentKey ? `${opts.parentKey}:${key}` : key;
    const reqT0 = Date.now();
    // Abort if job was deleted mid-run
    const jobRec = await stores.jobs.get(jobId);
    if (!jobRec) {
      dbg('step.abort.job_deleted', { key: fullKey });
      throw new JobDeletedError();
    }
    const existing = await stores.steps.get(jobId, fullKey);
    // Initial request log
    dbg('step.request', {
      key: fullKey,
      title: opts.title,
      parent: opts.parentKey,
      cachedCandidate: !!(existing && existing.status === 'done' && !opts.forceRecompute),
    });
    if (existing && existing.status === 'done' && !opts.forceRecompute) {
      stores.events.emit({
        type: 'step_replayed',
        jobId,
        key: fullKey,
        title: opts.title,
        tags: opts.tags || {},
      });
      const r0 = Date.now();
      const val = JSON.parse(existing.resultJson);
      const replayMs = Date.now() - r0;
      dbg('step.replay', {
        key: fullKey,
        title: opts.title,
        parent: opts.parentKey,
        cached: true,
        origDurationMs: existing.durationMs,
        replayMs,
      });
      dbg('step.response', {
        key: fullKey,
        title: opts.title,
        fromCache: true,
        responseMs: Date.now() - reqT0,
      });
      return val;
    }
    const rec: Partial<Step> = {
      jobId,
      key: fullKey,
      title: opts.title,
      status: 'running',
      resultJson: '',
      tagsJson: opts.tags ? JSON.stringify(opts.tags) : null,
      parentKey: opts.parentKey ?? currentStepStack.at(-1) ?? null,
      error: null,
      progress: 0,
      durationMs: null,
      llmTokens: null,
      prompt: opts.prompt ?? null,
      ts: nowIso(),
    };
    await stores.steps.put(rec);
    currentStepStack.push(fullKey);

    const t0 = Date.now();
    dbg('step.begin', { key: fullKey, title: opts.title, parent: rec.parentKey, tags: opts.tags });
    try {
      const out = await fn();
      // Refetch the record to ensure we have the latest tags from sub-steps (e.g. llmRaw from callLLM)
      const finalRec = await stores.steps.get(jobId, fullKey);
      const updatedRec = { ...(finalRec || rec) };

      updatedRec.status = 'done';
      updatedRec.progress = 1;
      updatedRec.durationMs = Date.now() - t0;
      updatedRec.resultJson = JSON.stringify(out);
      await stores.steps.put(updatedRec);
      dbg('step.end', { key: fullKey, ok: true, durationMs: updatedRec.durationMs });
      dbg('step.response', {
        key: fullKey,
        title: opts.title,
        fromCache: false,
        responseMs: Date.now() - reqT0,
      });
      return out;
    } catch (e: unknown) {
      rec.status = 'failed';
      rec.error = String((e as Error)?.message || e);
      rec.durationMs = Date.now() - t0;
      // If LLM error provided raw content, persist it for debugging
      const raw = (e as any)?.rawContent;
      const status = (e as any)?.status;
      const stack = (e as any)?.stack || new Error(String(rec.error)).stack;
      try {
        rec.resultJson = JSON.stringify({
          error: rec.error,
          ...(raw != null ? { raw } : {}),
          status,
          stack,
        });
      } catch {}
      await stores.steps.put(rec);
      dbg('step.end', { key: fullKey, ok: false, durationMs: rec.durationMs, error: rec.error });
      dbg('step.response', {
        key: fullKey,
        title: opts.title,
        fromCache: false,
        responseMs: Date.now() - reqT0,
        error: rec.error,
      });
      throw e;
    } finally {
      currentStepStack.pop();
    }
  }

  async function getStepResult(stepKey: string): Promise<any> {
    const rec = await stores.steps.get(jobId, stepKey);
    return rec && rec.status === 'done' ? JSON.parse(rec.resultJson) : undefined;
  }

  async function isPhaseComplete(phaseName: string): Promise<boolean> {
    const phaseSteps = await stores.steps.listByJob(jobId);
    const phaseKeys = phaseSteps.filter((s) => s.key.startsWith(`phase:${phaseName}:`));
    return phaseKeys.length > 0 && phaseKeys.every((s) => s.status === 'done');
  }

  async function link(
    from: { type: string; id: ID },
    role: string,
    to: { type: string; id: ID },
    tags?: Record<string, any>
  ): Promise<Link> {
    const latest = await stores.jobs.get(jobId);
    if (!latest) throw new JobDeletedError('Job deleted — skipping link');
    const ctxRun = (extras as any)?.runCount || 0;
    const latestRun = (latest as any)?.runCount || 0;
    if (ctxRun !== latestRun) throw new StaleRunError(ctxRun, latestRun, 'Stale run — skipping link');
    const id = `link:${await sha256(`${jobId}:${from.type}:${from.id}:${role}:${to.type}:${to.id}`)}`;
    const rec: Link = {
      id,
      jobId: jobId as any,
      fromType: from.type as any,
      fromId: from.id,
      toType: to.type as any,
      toId: to.id,
      role,
      tags,
      createdAt: nowIso(),
    };
    await stores.links.upsert(rec);
    return rec;
  }

  async function createArtifact(spec: {
    id?: ID;
    kind: string;
    version: number;
    title?: string;
    content?: string;
    tags?: Record<string, any>;
    links?: Array<{
      dir: 'from';
      role: string;
      ref: { type: string; id: ID };
      tags?: Record<string, any>;
    }>;
    autoProduced?: boolean;
  }): Promise<Artifact> {
    // Attach runCount for debugging/traceability
    const runCountTag = (extras as any)?.runCount ?? 0;
    const mergedTags = { ...(spec.tags || {}), runCount: runCountTag };
    const latest = await stores.jobs.get(jobId);
    if (!latest) throw new JobDeletedError('Job deleted — skipping artifact');
    const ctxRun = (extras as any)?.runCount || 0;
    const latestRun = (latest as any)?.runCount || 0;
    if (ctxRun !== latestRun) throw new StaleRunError(ctxRun, latestRun, 'Stale run — skipping artifact');
    const id =
      spec.id ??
      `artifact:${await sha256(`${jobId}:${spec.kind}:${spec.version}:${spec.title || ''}:${JSON.stringify(spec.tags || {})}`)}`;
    const base: Artifact = {
      id,
      jobId: jobId as any,
      kind: spec.kind,
      version: spec.version,
      title: spec.title,
      content: spec.content,
      tags: mergedTags,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await stores.artifacts.upsert(base);

    const curStepKey = currentStepStack.at(-1);
    if (curStepKey && spec.autoProduced !== false) {
      await link({ type: 'step', id: curStepKey }, 'produced', { type: 'artifact', id: base.id });
    }

    for (const l of spec.links || []) {
      // If the reference is a step, create a step -> artifact link (producer/contributor semantics)
      if ((l.ref as any)?.type === 'step') {
        await link(l.ref as any, l.role, { type: 'artifact', id: base.id }, l.tags);
      } else {
        // Otherwise, default to artifact -> ref (e.g., artifact uses/relates to another artifact)
        await link({ type: 'artifact', id: base.id }, l.role, l.ref as any, l.tags);
      }
    }
    return base;
  }

  async function callLLMCore(
    modelTask: string,
    prompt: string,
    opts?: { expect?: 'text' | 'json'; temperature?: number; tags?: Record<string, any> }
  ): Promise<{
    result: any;
    meta: {
      stepKey: string;
      tokensUsed: number;
      promptTokens?: number;
      completionTokens?: number;
      raw: string;
      attempts: number;
      status?: number;
      prompt: string;
    };
  }> {
    const fullKey = `llm:${modelTask}:${await sha256(prompt)}`;
    let metaLocal: any = null;
    // Resolve effective config for provenance tagging (does not affect key)
    const cfg = resolveTaskConfig(modelTask);
    const usedTemperature = opts?.temperature ?? cfg.temperature ?? 0.2;
    const result = await step(
      fullKey,
      async () => {
        const { result, tokensUsed, promptTokens, completionTokens, raw, attempts, status } = await llmCall(
          modelTask,
          prompt,
          opts ?? {}
        );
        metaLocal = { tokensUsed, promptTokens, completionTokens, raw, attempts, status };
        const stepRec = await stores.steps.get(jobId, fullKey);
        if (stepRec) {
          const tags = stepRec.tagsJson ? JSON.parse(stepRec.tagsJson) : {};
          const llmProv = { model: cfg.model, temperature: usedTemperature, baseURL: cfg.baseURL };
          const usage = {
            in: typeof promptTokens === 'number' ? promptTokens : undefined,
            out: typeof completionTokens === 'number' ? completionTokens : undefined,
            total: typeof tokensUsed === 'number' ? tokensUsed : undefined,
          };
          const newTags = { ...tags, modelTask, llm: llmProv, usage, attempts, llmRaw: raw };
          await stores.steps.put({
            ...stepRec,
            llmTokens: tokensUsed,
            prompt,
            tagsJson: JSON.stringify(newTags),
          });
        }
        return result;
      },
      { title: `LLM: ${modelTask}`, tags: { ...(opts?.tags || {}), modelTask }, prompt }
    );
    const meta = {
      stepKey: fullKey,
      tokensUsed: metaLocal?.tokensUsed || 0,
      promptTokens: metaLocal?.promptTokens,
      completionTokens: metaLocal?.completionTokens,
      raw: metaLocal?.raw || '',
      attempts: metaLocal?.attempts || 1,
      status: metaLocal?.status,
      prompt,
    };
    return { result, meta };
  }

  async function callLLMEx(
    modelTask: string,
    prompt: string,
    opts?: { expect?: 'text' | 'json'; temperature?: number; tags?: Record<string, any> }
  ): Promise<{
    result: any;
    meta: {
      stepKey: string;
      tokensUsed: number;
      raw: string;
      attempts: number;
      status?: number;
      prompt: string;
    };
  }> {
    return callLLMCore(modelTask, prompt, opts);
  }

  const base: Context = {
    jobId,
    stores,
    step,
    getStepResult,
    isPhaseComplete,
    createArtifact,
    link,
    callLLMEx,
    runCount: (extras as any)?.runCount || 0,
  };
  // Attach typed inputs if provided (structural superset of Context)
  return Object.assign({}, base, extras && extras.inputs ? { inputs: extras.inputs } : {});
}

async function llmCall(
  task: string,
  prompt: string,
  { expect = 'text', temperature }: { expect?: 'text' | 'json'; temperature?: number } = {}
): Promise<{
  result: any;
  tokensUsed: number;
  promptTokens?: number;
  completionTokens?: number;
  raw: string;
  attempts: number;
  status?: number;
}> {
  const cfg = resolveTaskConfig(task);
  if (!cfg.apiKey) throw new Error("API key required for LLM; set localStorage 'TASK_DEFAULT_API_KEY'");
  const retries = ((): number => {
    try {
      return appConfig.isReady() ? appConfig.maxRetries() : 3;
    } catch {
      return 3;
    }
  })();
  let lastRaw = '';
  let lastStatus: number | undefined = undefined;
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  const backoffMs = (attempt: number) => {
    const base = 250 * Math.pow(2, Math.max(0, attempt - 1));
    return Math.min(2000, base) + Math.floor(Math.random() * 100);
  };

  await llmPool.acquire();
  try {
    for (let attempt = 1; attempt <= retries; attempt++) {
      const a0 = Date.now();
      dbg('llm.fetch.begin', {
        task,
        attempt,
        expect,
        temperature: temperature ?? cfg.temperature,
      });
      let response: Response;
      try {
        const payload: Record<string, unknown> = {
          ...cfg.requestOptions,
          model: cfg.model,
          temperature: temperature ?? cfg.temperature ?? 0.2,
          messages: [
            {
              role: 'system',
              content: expect === 'json' ? 'Return only JSON. No commentary.' : 'You write narrative text.',
            },
            { role: 'user', content: prompt },
          ],
        };
        if (expect === 'json') {
          payload.response_format = { type: 'json_object' };
        }
        response = await fetch(`${cfg.baseURL}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (netErr: any) {
        lastRaw = String(netErr?.message || netErr || 'fetch failed');
        dbg('llm.fetch.end', {
          task,
          attempt,
          ok: false,
          error: lastRaw,
          durationMs: Date.now() - a0,
        });
        if (attempt >= retries) {
          // Wrap with details to surface in step failure UI
          throw new LLMCallError(`LLM fetch failed: ${lastRaw}`, {
            rawContent: JSON.stringify({
              baseURL: cfg.baseURL,
              model: cfg.model,
              message: String(lastRaw),
            }),
            status: lastStatus,
          });
        }
        await sleep(backoffMs(attempt));
        await sleep(backoffMs(attempt));
        continue;
      }
      if (!response.ok) {
        const body = await response.text();
        lastRaw = body;
        lastStatus = response.status;
        dbg('llm.fetch.end', {
          task,
          attempt,
          ok: false,
          httpStatus: response.status,
          durationMs: Date.now() - a0,
        });
        if (attempt >= retries) {
          throw new LLMCallError(
            `LLM HTTP error ${response.status}: ${response.statusText} (after ${retries} attempts)`,
            { rawContent: body, status: response.status }
          );
        }
        continue;
      }
      let data: any;
      try {
        data = await response.json();
      } catch (e: any) {
        lastRaw = String(e?.message || 'invalid JSON response');
        lastStatus = response.status;
        dbg('llm.fetch.end', {
          task,
          attempt,
          ok: false,
          httpStatus: lastStatus,
          parseError: lastRaw,
          durationMs: Date.now() - a0,
        });
        if (attempt >= retries) {
          throw new LLMCallError(`LLM response JSON parse failed (after ${retries} attempts)`, {
            rawContent: await response.text().catch(() => ''),
            status: lastStatus,
          });
        }
        await sleep(backoffMs(attempt));
        continue;
      }
      // Treat explicit API error payloads as retryable failures even if HTTP 200
      if (data && typeof data === 'object' && data.error) {
        lastRaw = (function () {
          try {
            return JSON.stringify(data);
          } catch {
            return String(data);
          }
        })();
        lastStatus = response.status;
        dbg('llm.fetch.end', {
          task,
          attempt,
          ok: false,
          httpStatus: lastStatus,
          apiError: true,
          durationMs: Date.now() - a0,
        });
        if (attempt >= retries) {
          throw new LLMCallError(`LLM API error in response (after ${retries} attempts)`, {
            rawContent: lastRaw,
            status: lastStatus,
          });
        }
        await sleep(backoffMs(attempt));
        continue;
      }
      // Safely extract content; do not use reasoning fallbacks
      const contentNode =
        Array.isArray(data?.choices) && data.choices.length > 0 ? data.choices[0]?.message?.content : undefined;
      if (typeof contentNode !== 'string') {
        lastRaw = (function () {
          try {
            return JSON.stringify(data);
          } catch {
            return String(data);
          }
        })();
        lastStatus = response.status;
        dbg('llm.fetch.end', {
          task,
          attempt,
          ok: false,
          httpStatus: lastStatus,
          badShape: true,
          durationMs: Date.now() - a0,
        });
        if (attempt >= retries) {
          throw new LLMCallError(`LLM returned unexpected response shape (after ${retries} attempts)`, {
            rawContent: lastRaw,
            status: lastStatus,
          });
        }
        await sleep(backoffMs(attempt));
        continue;
      }
      const content = contentNode ?? '';
      lastRaw = content;
      const tokensUsed = data.usage?.total_tokens ?? 0;
      const promptTokens = data.usage?.prompt_tokens ?? undefined;
      const completionTokens = data.usage?.completion_tokens ?? undefined;
      dbg('llm.fetch.end', {
        task,
        attempt,
        ok: true,
        httpStatus: lastStatus,
        durationMs: Date.now() - a0,
        tokensUsed,
      });
      if (expect === 'json') {
        const obj = tolerantJsonParse(content);
        if (!obj) {
          if (attempt >= retries) {
            throw new LLMCallError(`LLM returned non-JSON content (after ${retries} attempts)`, {
              rawContent: content,
              status: lastStatus,
            });
          }
          await sleep(backoffMs(attempt));
          continue;
        }
        return {
          result: obj,
          tokensUsed,
          promptTokens,
          completionTokens,
          raw: content,
          attempts: attempt,
          status: lastStatus,
        };
      }
      return {
        result: content,
        tokensUsed,
        promptTokens,
        completionTokens,
        raw: content,
        attempts: attempt,
        status: lastStatus,
      };
    }
  } finally {
    llmPool.release();
  }
  // Should not reach here, but throw with last raw
  throw new LLMCallError(`LLM call failed (exhausted ${retries} attempts)`, {
    rawContent: lastRaw,
  });
}

// Removed legacy runWorkflow; runPipeline is the job-centric entrypoint

// Phase 3 (initial): job-centric entrypoint that wraps existing runWorkflow
export async function runPipeline(
  stores: Stores,
  jobId: ID,
  pipeline: Array<(ctx: Context) => Promise<void>>,
  extras?: { type?: string; inputs?: any; runCount?: number }
): Promise<void> {
  // If job was deleted before starting, abort silently
  const initial = await stores.jobs.get(jobId);
  if (!initial) {
    dbg('pipeline.abort.job_deleted.prestart', { jobId });
    return;
  }
  const ctx = makeContext(stores, jobId, extras);
  try {
    await stores.jobs.updateStatus(jobId, 'running');
  } catch {}
  try {
    for (const phaseFn of pipeline) {
      const alive = await stores.jobs.get(jobId);
      if (!alive) {
        throw new JobDeletedError();
      }
      await phaseFn(ctx);
    }
    try {
      await stores.jobs.updateStatus(jobId, 'done');
    } catch {}
  } catch (e: any) {
    if (e instanceof StaleRunError) {
      // Old run aborted due to newer run; do not mark failed
      dbg('pipeline.stale_abort', { jobId });
      return;
    }
    if (e instanceof JobDeletedError) {
      // Job deleted mid-run; abort quietly
      dbg('pipeline.job_deleted_abort', { jobId });
      return;
    }
    const msg = typeof e?.message === 'string' ? e.message : String(e);
    try {
      await stores.jobs.updateStatus(jobId, 'failed' as any, msg);
    } catch {}
    try {
      console.warn('[job.failed]', { jobId, error: msg });
    } catch {}
  }
}
