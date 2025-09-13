import type { ID, Artifact, Step, Link, Event, Stores } from './types';
import { EventHub } from './types';
import { nowIso } from './helpers';
import { emitArtifactSaved, emitLinkSaved, emitStepSaved } from './stores.base';

const DB_NAME = 'narrative_db_v3';
const DB_VERSION = 5;

async function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    // Reset stores to job-first schema (drops old data)
    for (const name of Array.from(db.objectStoreNames)) {
      try { db.deleteObjectStore(name); } catch {}
    }
    // jobs
    {
      const s = db.createObjectStore('jobs', { keyPath: 'id' });
      s.createIndex('type', 'type', { unique: false });
      s.createIndex('status', 'status', { unique: false });
      s.createIndex('updatedAt', 'updatedAt', { unique: false });
      try { (s as any).createIndex('dependsOn', 'dependsOn', { unique: false, multiEntry: true }); } catch {}
    }
    // artifacts
    {
      const s = db.createObjectStore('artifacts', { keyPath: 'id' });
      s.createIndex('jobId', 'jobId', { unique: false });
      s.createIndex('kind', 'kind', { unique: false });
      s.createIndex('updatedAt', 'updatedAt', { unique: false });
    }
    // steps
    {
      const s = db.createObjectStore('steps', { keyPath: 'pk' });
      s.createIndex('jobId', 'jobId', { unique: false });
      s.createIndex('ts', 'ts', { unique: false });
      s.createIndex('status', 'status', { unique: false });
    }
    // links
    {
      const s = db.createObjectStore('links', { keyPath: 'id' });
      s.createIndex('jobId', 'jobId', { unique: false });
      s.createIndex('createdAt', 'createdAt', { unique: false });
    }
  };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db: IDBDatabase, stores: string[], mode: IDBTransactionMode = 'readonly') {
  return db.transaction(stores, mode);
}

export async function createIndexedDbStores(): Promise<Stores> {
  const db = await openDb();
  const events = new EventHub();

  // documents store removed; jobs are the source of truth

  const stores: Stores = {
    jobs: {
      async create(id, title, type, inputs, dependsOn) {
        const t = tx(db, ['jobs'], 'readwrite');
        const s = t.objectStore('jobs');
        const getReq = s.get(id);
        await new Promise(res => { getReq.onsuccess = () => res(null); });
        const existing = getReq.result as any | undefined;
        if (!existing) {
          const now = nowIso();
          const rec = { id, title, type, inputs, status: (dependsOn && dependsOn.length ? 'blocked' : 'queued'), dependsOn: dependsOn || [], lastError: null, cacheVersion: 0, createdAt: now, updatedAt: now };
          s.put(rec);
          await new Promise(res => { t.oncomplete = () => res(null); });
          events.emit({ type: 'job_created', jobId: id, title, jobType: type } as any);
        }
      },
      async all() {
        const t = tx(db, ['jobs']);
        const s = t.objectStore('jobs');
        const req = s.getAll();
        const list: any[] = await new Promise(res => { req.onsuccess = () => res(req.result as any[]); });
        return list.slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      },
      async get(id) {
        const t = tx(db, ['jobs']);
        const s = t.objectStore('jobs');
        const req = s.get(id);
        return await new Promise(res => { req.onsuccess = () => res(req.result as any | undefined); });
      },
      async updateStatus(id, status, lastError) {
        const t = tx(db, ['jobs'], 'readwrite');
        const s = t.objectStore('jobs');
        const getReq = s.get(id);
        await new Promise(res => { getReq.onsuccess = () => res(null); });
        const job = getReq.result as any | undefined;
        if (job) {
          const prev = job.status;
          job.status = status;
          job.lastError = lastError ?? null;
          job.updatedAt = nowIso();
          s.put(job);
          await new Promise(res => { t.oncomplete = () => res(null); });
          try { console.log('[job.status]', { id, from: prev, to: status }); } catch {}
          events.emit({ type: 'job_status', jobId: id, status, lastError: job.lastError } as any);
        }
      },
      async upsert(jobRec) {
        const t = tx(db, ['jobs'], 'readwrite');
        const s = t.objectStore('jobs');
        s.put(jobRec as any);
        await new Promise(res => { t.oncomplete = () => res(null); });
        try { console.log('[job.upsert]', { id: jobRec.id, status: (jobRec as any).status, runCount: (jobRec as any).runCount }); } catch {}
        // Emit status to refresh UI
        events.emit({ type: 'job_status', jobId: jobRec.id, status: (jobRec as any).status, lastError: (jobRec as any).lastError } as any);
      },
      async setDependsOn(id, dependsOn) {
        const t = tx(db, ['jobs'], 'readwrite');
        const s = t.objectStore('jobs');
        const getReq = s.get(id);
        await new Promise(res => { getReq.onsuccess = () => res(null); });
        const job = getReq.result as any | undefined;
        if (job) {
          job.dependsOn = dependsOn || [];
          job.updatedAt = nowIso();
          s.put(job);
          await new Promise(res => { t.oncomplete = () => res(null); });
          try { console.log('[job.dependsOn]', { id, dependsOn: job.dependsOn }); } catch {}
          events.emit({ type: 'job_status', jobId: id, status: job.status, lastError: job.lastError } as any);
        }
      },
      async delete(id) {
        const t = tx(db, ['jobs'], 'readwrite');
        const s = t.objectStore('jobs');
        s.delete(id);
        await new Promise(res => { t.oncomplete = () => res(null); });
        try { events.emit({ type: 'job_deleted', jobId: id } as any); } catch {}
      },
      async listByDependsOn(parentId) {
        const t = tx(db, ['jobs']);
        const s = t.objectStore('jobs');
        try {
          const idx = (s as any).index('dependsOn');
          const req = idx.getAll(IDBKeyRange.only(parentId));
          const list: any[] = await new Promise(res => { req.onsuccess = () => res(req.result as any[]); });
          return list;
        } catch {
          const reqAll = s.getAll();
          const list: any[] = await new Promise(res => { reqAll.onsuccess = () => res(reqAll.result as any[]); });
          return list.filter(j => Array.isArray(j.dependsOn) && j.dependsOn.includes(parentId));
        }
      }
    },

    // workflows removed

    artifacts: {
      async get(id: ID): Promise<Artifact | undefined> {
        const t = tx(db, ['artifacts']);
        const s = t.objectStore('artifacts');
        const req = s.get(id);
        return await new Promise(res => { req.onsuccess = () => res(req.result as Artifact | undefined); });
      },
      async upsert(a: Artifact): Promise<void> {
        const t = tx(db, ['artifacts'], 'readwrite');
        const s = t.objectStore('artifacts');
        s.put(a);
        await new Promise(res => { t.oncomplete = () => res(null); });
        emitArtifactSaved(events, a);
      },
      async listByJob(jobId: ID, pred?: (a: Artifact) => boolean): Promise<Artifact[]> {
        const t = tx(db, ['artifacts']);
        const s = t.objectStore('artifacts');
        const req = s.index('jobId').getAll(IDBKeyRange.only(jobId));
        let list: Artifact[] = await new Promise(res => { (req as any).onsuccess = () => res((req as any).result as Artifact[]); });
        list = list.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
        if (pred) list = list.filter(pred);
        return list;
      },
      async latestVersion(jobId: ID, kind: string, tagsKey?: string, tagsValue?: any): Promise<number | null> {
        const list = await this.listByJob(jobId, (a: Artifact) => a.kind === kind && (!tagsKey || a.tags?.[tagsKey] === tagsValue));
        const sorted = list.sort((a, b) => b.version - a.version);
        return sorted.length > 0 ? sorted[0].version : null;
      },
      async deleteByJob(jobId: ID): Promise<void> {
        const t = tx(db, ['artifacts'], 'readwrite');
        const s = t.objectStore('artifacts');
        const req = s.index('jobId').getAll(IDBKeyRange.only(jobId));
        const list: Artifact[] = await new Promise(res => { req.onsuccess = () => res(req.result as Artifact[]); });
        for (const a of list) s.delete(a.id);
        await new Promise(res => { t.oncomplete = () => res(null); });
        events.emit({ type: 'artifacts_cleared', jobId } as Event);
      }
    },

    steps: {
      async get(jobId: ID, key: string): Promise<Step | undefined> {
        const pk = `${jobId}:${key}`;
        const t = tx(db, ['steps']);
        const s = t.objectStore('steps');
        const req = s.get(pk);
        const rec = await new Promise<any>(res => { req.onsuccess = () => res(req.result); });
        if (!rec) return undefined;
        const { pk: _pk, ...rest } = rec;
        return rest as Step;
      },
      async put(rec: Partial<Step>): Promise<void> {
        const pk = `${rec.jobId}:${rec.key}`;
        const t = tx(db, ['steps'], 'readwrite');
        const s = t.objectStore('steps');
        s.put({ ...rec, pk });
        await new Promise(res => { t.oncomplete = () => res(null); });
        emitStepSaved(events, rec as any);
      },
      async listByJob(jobId: ID): Promise<Step[]> {
        const t = tx(db, ['steps']);
        const s = t.objectStore('steps');
        const req = s.index('jobId').getAll(IDBKeyRange.only(jobId));
        const all: any[] = await new Promise(res => { (req as any).onsuccess = () => res((req as any).result as any[]); });
        const steps = all.map(r => { const { pk: _pk, ...rest } = r; return rest as Step; });
        return steps.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
      },
      async listRunning(): Promise<Step[]> {
        const t = tx(db, ['steps']);
        const s = t.objectStore('steps');
        const req = s.getAll();
        const all: any[] = await new Promise(res => { req.onsuccess = () => res(req.result as any[]); });
        return all
          .map(r => { const { pk: _pk, ...rest } = r; return rest as Step; })
          .filter(s => s.status === 'running' || s.status === 'pending')
          .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
      },
      async deleteByJob(jobId: ID): Promise<void> {
        const t = tx(db, ['steps'], 'readwrite');
        const s = t.objectStore('steps');
        const req = s.index('jobId').getAll(IDBKeyRange.only(jobId));
        const all: any[] = await new Promise(res => { (req as any).onsuccess = () => res((req as any).result as any[]); });
        for (const r of all) s.delete(r.pk);
        await new Promise(res => { t.oncomplete = () => res(null); });
      }
    },

    links: {
      async get(id: ID): Promise<Link | undefined> {
        const t = tx(db, ['links']);
        const s = t.objectStore('links');
        const req = s.get(id);
        return await new Promise(res => { req.onsuccess = () => res(req.result as Link | undefined); });
      },
      async upsert(l: Link): Promise<void> {
        const t = tx(db, ['links'], 'readwrite');
        const s = t.objectStore('links');
        const rec = { ...l } as any;
        const reqAll = s.index('jobId').getAll(IDBKeyRange.only(rec.jobId));
        const list: Link[] = await new Promise(res => { reqAll.onsuccess = () => res(reqAll.result as Link[]); });
        const composite = `${rec.jobId}-${rec.fromType}-${rec.fromId}-${rec.toType}-${rec.toId}-${rec.role}`;
        const dup = list.find(li => `${li.jobId}-${li.fromType}-${li.fromId}-${li.toType}-${li.toId}-${li.role}` === composite && li.id !== rec.id);
        if (dup) s.delete(dup.id);
        s.put(rec);
        await new Promise(res => { t.oncomplete = () => res(null); });
        emitLinkSaved(events, rec as any);
      },
      async listByJob(jobId: ID): Promise<Link[]> {
        const t = tx(db, ['links']);
        const s = t.objectStore('links');
        const req = s.index('jobId').getAll(IDBKeyRange.only(jobId));
        const list: Link[] = await new Promise(res => { (req as any).onsuccess = () => res((req as any).result as Link[]); });
        return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      },
      async deleteByJob(jobId: ID): Promise<void> {
        const t = tx(db, ['links'], 'readwrite');
        const s = t.objectStore('links');
        const req = s.index('jobId').getAll(IDBKeyRange.only(jobId));
        const list: Link[] = await new Promise(res => { req.onsuccess = () => res(req.result as Link[]); });
        for (const l of list) s.delete(l.id);
        await new Promise(res => { t.oncomplete = () => res(null); });
        events.emit({ type: 'links_cleared', jobId } as Event);
      }
    },

    events
  };

  return stores;
}
