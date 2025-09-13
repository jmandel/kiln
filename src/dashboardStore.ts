import type { Stores, ID, Step, Artifact, Event } from './types';

type Level = 'info' | 'warn' | 'error';

export type DashboardView = {
  jobId: string;
  title: string;
  status: 'queued' | 'running' | 'done' | 'error';
  currentPhase?: string;
  jobStartTime?: string;
  metrics: { stepCounts: Record<string, number>; totalTokens: number; elapsedMs: number };
  artifacts: Array<{ id: string; name: string; kind: string; status: 'done'; createdAt?: string; phase?: string }>;
  events: Array<{ ts: string; level: Level; msg: string }>;
  error?: string;
  phases: Array<{ id: string; label: string; done: number; total: number; pct: number }>;
};

const defaultView: DashboardView = {
  jobId: '',
  title: 'No job selected',
  status: 'queued',
  metrics: { stepCounts: {}, totalTokens: 0, elapsedMs: 0 },
  artifacts: [],
  events: [],
  phases: []
};

function guessKind(kind: string): 'draft'|'outline'|'assets'|'review'|'final'|string {
  const k = (kind || '').toLowerCase();
  if (k.includes('outline')) return 'outline';
  if (k.includes('draft')) return 'draft';
  if (k.includes('note')) return 'final';
  if (k.includes('asset')) return 'assets';
  if (k.includes('review')) return 'review';
  return k;
}

function toMsg(ev: any): { level: Level; msg: string } | null {
  switch (ev.type) {
    case 'step_saved':     return { level: ev.status === 'failed' ? 'error' : ev.status === 'pending' ? 'warn' : 'info', msg: `Step ${ev.title || ev.key} → ${ev.status}` };
    case 'artifact_saved': return { level: 'info', msg: `Artifact ${ev.kind} v${ev.version} saved` };
    case 'job_created':     return { level: 'info', msg: `Job created` };
    case 'job_status':      return { level: ev.status === 'failed' ? 'error' : 'info', msg: `Job → ${ev.status}` };
    default: return null;
  }
}

type StepMeta = { status: Step['status']; phase: string; llmTokens?: number; ts: string };
type PhaseCounts = Map<string, { done: number; total: number }>;

function safePhase(tagsJson?: string | null): string {
  try { const t = tagsJson ? JSON.parse(tagsJson) : {}; return t.phase || 'untagged'; } catch { return 'untagged'; }
}

export class DashboardStore {
  private listeners = new Map<ID, Set<() => void>>();
  private views = new Map<ID, DashboardView>();
  private stepIndex = new Map<ID, Map<string, StepMeta>>();
  private phaseCounts = new Map<ID, PhaseCounts>();
  private pendingEvents = new Map<ID, any[]>();
  private flushScheduled = false;
  private selectedDoc: ID | null = null;

  constructor(private stores: Stores) {
    this.stores.events.subscribe((ev: Event) => {
      try { console.log('[WF]', JSON.stringify({ ts: new Date().toISOString(), type: 'event.recv', evType: (ev as any)?.type, jobId: (ev as any)?.jobId })); } catch {}
      const docId: ID | undefined = (ev as any).jobId;
      if (!docId) return;
      if (this.selectedDoc && docId !== this.selectedDoc) return;
      const q = this.pendingEvents.get(docId) || [];
      q.push(ev);
      this.pendingEvents.set(docId, q);
      this.scheduleFlush();
    });
  }

  select(jobId: ID) {
    if (this.selectedDoc === jobId) return;
    this.selectedDoc = jobId;
    if (!this.views.has(jobId)) {
      void this.bootstrap(jobId);
    } else {
      this.notify(jobId);
    }
  }

  subscribe(jobId: ID, cb: () => void): () => void {
    let set = this.listeners.get(jobId);
    if (!set) { set = new Set(); this.listeners.set(jobId, set); }
    set.add(cb);
    return () => { set!.delete(cb); };
  }

  getState(jobId: ID): DashboardView {
    return this.views.get(jobId) || defaultView;
  }

  private async bootstrap(jobId: ID): Promise<void> {
    const doc = await this.stores.jobs.get(jobId);
    const steps = await this.stores.steps.listByJob(jobId);
    const arts  = await this.stores.artifacts.listByJob(jobId);

    const sIndex = new Map<string, StepMeta>();
    const pCounts: PhaseCounts = new Map();
    const stepCounts: Record<string, number> = { running: 0, pending: 0, done: 0, failed: 0 };
    let tokens = 0;

    for (const s of steps) {
      const ph = safePhase(s.tagsJson);
      const meta: StepMeta = { status: s.status, phase: ph, llmTokens: s.llmTokens || 0, ts: s.ts };
      sIndex.set(`${s.jobId}:${s.key}`, meta);
      if (!pCounts.has(ph)) pCounts.set(ph, { done: 0, total: 0 });
      const pc = pCounts.get(ph)!; pc.total += 1; if (s.status === 'done') pc.done += 1;
      stepCounts[s.status] = (stepCounts[s.status] || 0) + 1;
      tokens += s.llmTokens || 0;
    }

    this.stepIndex.set(jobId, sIndex);
    this.phaseCounts.set(jobId, pCounts);

    const jobStartTime = doc?.createdAt || steps[0]?.ts || undefined;
    const lastTs = steps.length ? steps[steps.length - 1].ts : jobStartTime;
    const elapsedMs = jobStartTime && lastTs ? (new Date(lastTs).getTime() - new Date(jobStartTime).getTime()) : 0;
    const phases = Array.from(pCounts.entries()).map(([id, v]) => ({ id, label: id, done: v.done, total: v.total, pct: v.total ? v.done / v.total : 0 }));

    const artifacts = arts.map(a => ({
      id: a.id,
      name: a.title || `${a.kind} v${a.version}`,
      kind: guessKind(a.kind),
      status: 'done' as const,
      createdAt: a.updatedAt,
      phase: a.tags?.phase
    }));

    // Latest failed step for banner
    let error: string | undefined;
    const failed = steps.filter(s => s.status === 'failed').sort((a, b) => b.ts.localeCompare(a.ts))[0];
    if (failed) {
      const details = failed.resultJson ? (() => { try { return JSON.parse(failed.resultJson); } catch { return null; } })() : null;
      const rawSnippet = details?.raw ? String(details.raw).slice(0, 200).replace(/\s+/g, ' ') + (String(details.raw).length > 200 ? '…' : '') : '';
      error = `${failed.title || failed.key} — ${failed.error || 'failed'}` + (rawSnippet ? ` — Raw: ${rawSnippet}` : '');
    }

    const view: DashboardView = {
      jobId,
      title: doc?.title || 'Document',
      status: doc?.status === 'done' ? 'done' : doc?.status === 'blocked' ? 'error' : 'running',
      currentPhase: (() => {
        const latest = steps.slice().sort((a,b)=> b.ts.localeCompare(a.ts))[0];
        return latest ? safePhase(latest.tagsJson) : undefined;
      })(),
      jobStartTime,
      metrics: { stepCounts, totalTokens: tokens, elapsedMs },
      artifacts,
      events: [],
      error,
      phases
    };

    this.views.set(jobId, view);
    try { console.log('[WF]', JSON.stringify({ ts: new Date().toISOString(), type: 'bootstrap.done', jobId, artifacts: artifacts.length })); } catch {}
    this.notify(jobId);
  }

  private scheduleFlush() {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    requestAnimationFrame(() => {
      this.flushScheduled = false;
      void this.flush();
    });
  }

  private async flush() {
    for (const [docId, queue] of this.pendingEvents.entries()) {
      if (!queue.length) continue;
      const view = this.views.get(docId);
      if (!view) continue;
      const stepsByPk = this.stepIndex.get(docId)!;
      const phases = this.phaseCounts.get(docId)!;

      let latestTs = view.jobStartTime ? new Date(view.jobStartTime).getTime() + (view.metrics.elapsedMs || 0) : 0;
      let shouldClearError = false;

      for (const ev of queue.splice(0)) {
        const m = toMsg(ev);
        if (m) {
          view.events = [...view.events, { ts: new Date().toISOString(), level: m.level, msg: m.msg }].slice(-50);
        }

        if (ev.type === 'step_saved') {
          const pk = `${ev.jobId}:${ev.key}`;
          const prev = stepsByPk.get(pk);
          const newPhase = safePhase(JSON.stringify(ev.tags || (ev.tagsJson ? JSON.parse(ev.tagsJson) : {})));
          const curStatus = ev.status as Step['status'];
          const prevStatus = prev?.status;

          if (!prev) {
            view.metrics.stepCounts[curStatus] = (view.metrics.stepCounts[curStatus] || 0) + 1;
            if (!phases.has(newPhase)) phases.set(newPhase, { done: 0, total: 0 });
            const pc = phases.get(newPhase)!; pc.total += 1; if (curStatus === 'done') pc.done += 1;
            view.metrics.totalTokens += ev.llmTokens || 0;
          } else {
            if (prevStatus !== curStatus) {
              view.metrics.stepCounts[prevStatus!] = Math.max(0, (view.metrics.stepCounts[prevStatus!] || 1) - 1);
              view.metrics.stepCounts[curStatus] = (view.metrics.stepCounts[curStatus] || 0) + 1;
              const oldPc = phases.get(prev.phase)!;
              if (prevStatus === 'done') oldPc.done = Math.max(0, oldPc.done - 1);
              let newPc = phases.get(newPhase); if (!newPc) { newPc = { done: 0, total: 0 }; phases.set(newPhase, newPc); }
              if (curStatus === 'done') newPc.done += 1;
              if (prev.phase !== newPhase) { oldPc.total = Math.max(0, oldPc.total - 1); newPc.total += 1; }
            } else if (prev.phase !== newPhase) {
              const oldPc = phases.get(prev.phase)!; oldPc.total = Math.max(0, oldPc.total - 1);
              let newPc = phases.get(newPhase); if (!newPc) { newPc = { done: 0, total: 0 }; phases.set(newPhase, newPc); }
              newPc.total += 1; if (curStatus === 'done') { oldPc.done = Math.max(0, oldPc.done - 1); newPc.done += 1; }
            }
            const prevTok = prev.llmTokens || 0; const curTok = ev.llmTokens || 0; if (curTok > prevTok) view.metrics.totalTokens += (curTok - prevTok);
          }
          stepsByPk.set(pk, { status: curStatus, phase: newPhase, llmTokens: ev.llmTokens || 0, ts: ev.ts });
          const t = ev.ts ? new Date(ev.ts).getTime() : 0; if (t >= latestTs) { latestTs = t; view.currentPhase = newPhase; }
        }

        if (ev.type === 'artifact_saved') {
          try {
            const a: Artifact | undefined = await this.stores.artifacts.get(ev.id);
            if (a) {
              const idx = view.artifacts.findIndex(x => x.id === a.id);
              const next = { id: a.id, name: a.title || `${a.kind} v${a.version}`, kind: guessKind(a.kind), status: 'done' as const, createdAt: a.updatedAt, phase: a.tags?.phase };
              if (idx >= 0) view.artifacts[idx] = next; else view.artifacts.push(next);
            }
          } catch {}
        }

        if (ev.type === 'artifacts_cleared' || ev.type === 'links_cleared') {
          try {
            const arts = await this.stores.artifacts.listByJob(docId);
            view.artifacts = arts.map(a => ({
              id: a.id,
              name: a.title || `${a.kind} v${a.version}`,
              kind: guessKind(a.kind),
              status: 'done' as const,
              createdAt: a.updatedAt,
              phase: a.tags?.phase
            }));
            try { console.log('[WF]', JSON.stringify({ ts: new Date().toISOString(), type: 'artifacts.cleared.applied', jobId: docId, count: view.artifacts.length })); } catch {}
          } catch {}
        }

        if (ev.type === 'job_status') {
          view.status = ev.status === 'done' ? 'done' : ev.status === 'blocked' ? 'error' : 'running';
          if (ev.status === 'running') shouldClearError = true;
        }
        // document_status removed in job-centric design

        const nowTs = ev.ts ? new Date(ev.ts).getTime() : Date.now();
        if (view.jobStartTime) view.metrics.elapsedMs = Math.max(view.metrics.elapsedMs, nowTs - new Date(view.jobStartTime).getTime());
      }

      // Update error banner: clear on resume signals, otherwise reflect latest failed step if any
      if (shouldClearError) {
        view.error = undefined;
      } else {
        const failedCount = Number(view.metrics.stepCounts.failed || 0);
        if (failedCount === 0) {
          view.error = undefined;
        } else {
          try {
            const steps = await this.stores.steps.listByJob(docId);
            const failed = steps.filter(s => s.status === 'failed').sort((a, b) => b.ts.localeCompare(a.ts))[0];
            if (failed) {
              const details = failed.resultJson ? (() => { try { return JSON.parse(failed.resultJson); } catch { return null; } })() : null;
              const rawSnippet = details?.raw ? String(details.raw).slice(0, 200).replace(/\s+/g, ' ') + (String(details.raw).length > 200 ? '…' : '') : '';
              view.error = `${failed.title || failed.key} — ${failed.error || 'failed'}` + (rawSnippet ? ` — Raw: ${rawSnippet}` : '');
            } else {
              view.error = undefined;
            }
          } catch {
            // ignore
          }
        }
      }

      view.phases = Array.from(phases.entries()).map(([id, v]) => ({ id, label: id, done: v.done, total: v.total, pct: v.total ? v.done / v.total : 0 }));
      this.views.set(docId, { ...view });
      try { console.log('[WF]', JSON.stringify({ ts: new Date().toISOString(), type: 'flush.view.updated', jobId: docId, artifacts: view.artifacts.length })); } catch {}
      this.notify(docId);
    }
  }

  private notify(jobId: ID) {
    const set = this.listeners.get(jobId);
    if (!set) return;
    for (const cb of set) { try { cb(); } catch {} }
  }
}
