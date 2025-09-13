import type { Stores, ID, Context, NarrativeInputs, KnownDocument, DocumentType, InputsUnion, FhirInputs } from '../types';
import { sha256 } from '../helpers';
import { runWorkflow } from '../engine';
import { buildNarrativeWorkflow } from './narrative';
import { buildFhirWorkflow } from './fhir';
import { registry } from '../documentTypes/registry';

export async function resumeDocument(stores: Stores, documentId: ID): Promise<void> {
  try { console.log('[WF]', JSON.stringify({ ts: new Date().toISOString(), type: 'resume.begin', documentId })); } catch {}
  const doc = (await stores.documents.get(documentId)) as KnownDocument | undefined;
  if (!doc) return;
  const isNarr = doc.type === 'narrative';
  const isFhir = doc.type === 'fhir';
  const input = isNarr ? { title: doc.title, sketch: (doc.inputs as any).sketch } : { title: doc.title } as any;

  const steps = await stores.steps.listByDocument(documentId);
  const byWf = new Map<ID, { pending: number; running: number; failed: number }>();
  for (const s of steps) {
    const cur = byWf.get(s.workflowId as ID) || { pending: 0, running: 0, failed: 0 };
    if (s.status === 'pending') cur.pending++;
    if (s.status === 'running') cur.running++;
    if (s.status === 'failed') cur.failed++;
    byWf.set(s.workflowId as ID, cur);
  }

  const pipeline: Array<(ctx: Context) => Promise<void>> = (function(){
    if (isNarr) {
      return buildNarrativeWorkflow({ sketch: (doc.inputs as any).sketch } as NarrativeInputs);
    }
    if (isFhir) {
      return buildFhirWorkflow({ noteText: (doc.inputs as any).noteText, source: (doc.inputs as any).source } as FhirInputs);
    }
    return [];
  })();
  const wfIds = Array.from(byWf.entries())
    .filter(([_, c]) => c.pending > 0 || c.running > 0 || c.failed > 0)
    .map(([wfId]) => wfId);

  if (wfIds.length) {
    try {
      const clear = (function(){ try { const v = localStorage.getItem('CLEAR_STEPS_ON_RESUME'); return v != null && !/^0|false|off$/i.test(v); } catch { return false; } })();
      if (clear) {
        await stores.steps.deleteByDocument(documentId);
        console.log('[WF]', JSON.stringify({ ts: new Date().toISOString(), type: 'resume.clear_steps', documentId }));
      }
    } catch {}
    await stores.artifacts.deleteByDocument(documentId);
    await stores.links.deleteByDocument(documentId);
    try { stores.events.emit({ type: 'artifacts_cleared', documentId } as any); } catch {}
    try { stores.events.emit({ type: 'links_cleared', documentId } as any); } catch {}
    for (const wfId of wfIds) {
      await stores.workflows.setStatus(wfId, 'running');
      try {
        await runWorkflow(stores, wfId, documentId, pipeline, { type: doc.type, inputs: doc.inputs as any });
      } catch (e) {
        try { console.error('[WF] resumeDocument error', e); } catch {}
      }
    }
    try { console.log('[WF]', JSON.stringify({ ts: new Date().toISOString(), type: 'resume.end', documentId, mode: 'resume', workflows: wfIds })); } catch {}
    return;
  }

  const latestStep = steps.slice().sort((a, b) => b.ts.localeCompare(a.ts))[0];
  const replayWfId = latestStep?.workflowId as ID | undefined;
  if (replayWfId) {
    await stores.artifacts.deleteByDocument(documentId);
    await stores.links.deleteByDocument(documentId);
    await stores.workflows.setStatus(replayWfId, 'running');
    try {
      await runWorkflow(stores, replayWfId, documentId, pipeline, { type: doc.type, inputs: doc.inputs as any });
    } catch (e) {
      try { console.error('[WF] resumeDocument replay error', e); } catch {}
    }
  }
  // If still no workflow to replay (e.g., a blocked dependent that never started), create a fresh one and run.
  if (!replayWfId) {
    const wfId = `wf:${await sha256(documentId + ':' + Date.now())}` as ID;
    await stores.workflows.create(wfId, documentId, `${doc.type}_workflow`);
    try { console.log('[WF] resumeDocument: created and starting new workflow', { documentId, wfId, type: doc.type }); } catch {}
    try {
      await runWorkflow(stores, wfId, documentId, pipeline, { type: doc.type, inputs: doc.inputs as any });
    } catch (e) {
      try { console.error('[WF] resumeDocument start error', e); } catch {}
    }
    return;
  }
  try { console.log('[WF]', JSON.stringify({ ts: new Date().toISOString(), type: 'resume.end', documentId, mode: 'replay', workflowId: replayWfId })); } catch {}
  return;
}

// Generic: create document of any registered type and run its workflow
export async function createAndRunDocument<T extends InputsUnion>(
  stores: Stores,
  type: DocumentType,
  inputs: T,
  title?: string,
  options: { blockedOn?: ID[]; run?: boolean } = {}
): Promise<ID> {
  const def = registry.get<T>(type);
  if (!def) throw new Error(`Unknown document type: ${type}`);
  const computedTitle = title || (type === 'narrative'
    ? `Patient: ${((inputs as any).sketch || '').slice(0, 30)}...`
    : 'FHIR Bundle');
  const idSeed = `${computedTitle}:${JSON.stringify(inputs)}`;
  const documentId = `doc:${await sha256(idSeed)}` as ID;
  const workflowId = `wf:${await sha256(documentId + ':' + Date.now())}` as ID;
  await stores.documents.create(documentId, computedTitle, type, inputs);
  // Apply dependency tags if provided
  const blockedOn = Array.isArray(options.blockedOn) ? options.blockedOn.filter(Boolean) as ID[] : [];
  if (blockedOn.length > 0) {
    const rec = await stores.documents.get(documentId);
    if (rec) {
      await stores.documents.put({ ...(rec as any), tags: { ...(rec as any).tags, blockedOn } });
      await stores.documents.updateStatus(documentId, 'blocked');
      try { console.log('[deps] created blocked doc', { documentId, type, blockedOn }); } catch {}
    }
  }
  const shouldRun = (options.run !== false) && blockedOn.length === 0;
  if (shouldRun) {
    await stores.workflows.create(workflowId, documentId, `${type}_workflow`);
    const pipeline = def.buildWorkflow(inputs);
    try { console.log('[deps] starting workflow immediately', { documentId, workflowId, type }); } catch {}
    runWorkflow(stores, workflowId, documentId, pipeline, { type, inputs }).catch(console.error);
  }
  return documentId;
}

// Scan for documents with deps satisfied and trigger their workflows
export async function triggerReadyDependents(stores: Stores): Promise<void> {
  const all = await stores.documents.all();
  const byId = new Map(all.map(d => [d.id, d] as const));
  const blocked = all.filter(d => d.status === 'blocked' && Array.isArray((d as any).tags?.blockedOn) && (d as any).tags.blockedOn.length > 0);
  try { console.log('[deps] scan', { total: all.length, blocked: blocked.map(b => ({ id: b.id, type: (b as any).type, blockedOn: (b as any).tags?.blockedOn })) }); } catch {}
  for (const dep of blocked) {
    const deps: ID[] = ((dep as any).tags?.blockedOn || []) as ID[];
    const statusByDep = deps.map(pid => ({ id: pid, status: byId.get(pid)?.status || 'missing' }));
    const anyBlocked = statusByDep.some(s => s.status === 'blocked');
    if (anyBlocked) { try { console.log('[deps] skip: parent still blocked', { depId: dep.id, statusByDep }); } catch {}; continue; }
    const allDone = statusByDep.every(s => s.status === 'done');
    try { console.log('[deps] check', { depId: dep.id, allDone, statusByDep }); } catch {}
    if (!allDone) continue;
    try {
      const def = registry.get<any>(dep.type);
      if (!def) continue;
      const wfId = `wf:${await sha256(dep.id + ':' + Date.now())}` as ID;
      await stores.workflows.create(wfId, dep.id, `${dep.type}_workflow`);
      await stores.documents.updateStatus(dep.id, 'running');
      // Clear deps to avoid re-trigger; fetch fresh doc to preserve latest status
      try {
        const fresh = await stores.documents.get(dep.id);
        if (fresh) {
          await stores.documents.put({ ...(fresh as any), tags: { ...(fresh as any).tags, blockedOn: [] } });
        }
      } catch {}
      const pipeline = def.buildWorkflow(dep.inputs as any);
      try { console.log('[deps] start dependent', { depId: dep.id, wfId, type: dep.type }); } catch {}
      runWorkflow(stores, wfId, dep.id, pipeline, { type: dep.type, inputs: dep.inputs as any }).catch(console.error);
    } catch (e) {
      try { console.error('triggerReadyDependents error', e); } catch {}
    }
  }
}
