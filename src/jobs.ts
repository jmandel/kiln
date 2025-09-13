import type { Stores, ID, DocumentType, InputsUnion } from './types';
import { sha256 } from './helpers';
import { registry } from './documentTypes/registry';
import { runPipeline } from './engine';
// No legacy dependency scanner; use jobs store

export async function createJob<T extends InputsUnion>(
  stores: Stores,
  type: DocumentType,
  inputs: T,
  title?: string,
  options: { dependsOn?: ID[] } = {}
): Promise<ID> {
  const computedTitle = title || (type === 'narrative'
    ? `Patient: ${((inputs as any).sketch || '').slice(0, 30)}...`
    : 'FHIR Bundle');
  // Always create a unique id regardless of inputs/title
  const nonce = `:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  const idSeed = `${type}:${computedTitle}:${JSON.stringify(inputs)}${nonce}`;
  const jobId = `job:${await sha256(idSeed)}` as ID;

  // Create job record (single source of truth)
  try { await stores.jobs.create(jobId, computedTitle, type, inputs as any, options.dependsOn || []); } catch {}
  // Apply dependencies (map to tags.blockedOn)
  const dependsOn = Array.isArray(options.dependsOn) ? options.dependsOn.filter(Boolean) : [];
  if (dependsOn.length > 0) {
    try { await stores.jobs.updateStatus(jobId, 'blocked'); } catch {}
  } else {
    try { await stores.jobs.updateStatus(jobId, 'queued' as any); } catch {}
  }
  // Immediately check if dependencies are already satisfied (e.g., creating FHIR from a completed Narrative)
  try { await triggerReadyJobs(stores); } catch {}
  return jobId;
}

export async function startJob(stores: Stores, jobId: ID): Promise<void> {
  const job = await stores.jobs.get(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  if (job.status === 'blocked') throw new Error('Job is blocked on dependencies');
  const def = registry.get<any>(job.type as any);
  if (!def) throw new Error(`Unknown job type: ${job.type}`);
  const pipeline = def.buildWorkflow(job.inputs as any);
  try { await stores.jobs.updateStatus(jobId, 'running'); } catch {}
  await runPipeline(stores, jobId, pipeline, { type: job.type as any, inputs: job.inputs as any, runCount: (job as any).runCount || 0 });
}

export async function rerunJob(stores: Stores, jobId: ID): Promise<void> {
  const job = await stores.jobs.get(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  // Increment runCount to invalidate stale contexts
  const updated = { ...job, runCount: (job.runCount || 0) + 1, updatedAt: new Date().toISOString() } as any;
  await stores.jobs.upsert(updated);

  // Clear outputs (artifacts + links)
  await stores.artifacts.deleteByJob(jobId);
  await stores.links.deleteByJob(jobId);

  // Reset only failed/pending steps
  const steps = await stores.steps.listByJob(jobId);
  for (const s of steps) {
    if (s.status === 'failed' || s.status === 'pending') {
      await stores.steps.put({ ...s, status: 'pending', error: null, progress: 0, ts: new Date().toISOString() });
    }
  }
  try { await stores.jobs.updateStatus(jobId, 'running' as any); } catch {}
  // Start fresh pipeline from the beginning (cached steps will replay)
  await startJob(stores, jobId);
}

export async function clearJobCache(
  stores: Stores,
  jobId: ID,
  filter?: (step: any) => boolean
): Promise<number> {
  const steps = await stores.steps.listByJob(jobId);
  let cleared = 0;
  for (const s of steps) {
    if (!filter || filter(s)) {
      await stores.steps.put({ ...s, status: 'pending', error: null, ts: new Date().toISOString() });
      cleared++;
    }
  }
  try { console.log('[cache_cleared]', { jobId, cleared }); } catch {}
  return cleared;
}

export async function resumeJob(stores: Stores, jobId: ID): Promise<void> {
  // Reset failed/pending steps handled by caller (e.g., clear cache path), then start
  await startJob(stores, jobId);
}

export async function triggerReadyJobs(stores: Stores): Promise<void> {
  const all = await stores.jobs.all();
  const blocked = all.filter(j => j.status === 'blocked' && Array.isArray(j.dependsOn) && j.dependsOn.length > 0);
  for (const job of blocked) {
    const deps = job.dependsOn || [];
    const parents = await Promise.all(deps.map(id => stores.jobs.get(id)));
    const allDone = parents.every(p => p && p.status === 'done');
    if (!allDone) continue;
    try {
      await stores.jobs.updateStatus(job.id, 'running');
      await startJob(stores, job.id);
    } catch (e) {
      try { console.error('[deps] triggerReadyJobs error', e); } catch {}
    }
  }
}
