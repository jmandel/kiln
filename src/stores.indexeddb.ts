import type { ID, Workflow, Artifact, Step, Link, Event, Stores, KnownDocument, DocumentType, InputsUnion, Document } from './types';
import { EventHub, isNarrativeInputs, isFhirInputs } from './types';
import { nowIso } from './helpers';
import { emitArtifactSaved, emitLinkSaved, emitStepSaved } from './stores.base';

const DB_NAME = 'narrative_db_v2';
const DB_VERSION = 2;

async function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('documents')) {
        const s = db.createObjectStore('documents', { keyPath: 'id' });
        s.createIndex('type', 'type', { unique: false });
        s.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('workflows')) {
        const s = db.createObjectStore('workflows', { keyPath: 'id' });
        s.createIndex('documentId', 'documentId', { unique: false });
        s.createIndex('status', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains('artifacts')) {
        const s = db.createObjectStore('artifacts', { keyPath: 'id' });
        s.createIndex('documentId', 'documentId', { unique: false });
        s.createIndex('kind', 'kind', { unique: false });
        s.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('steps')) {
        const s = db.createObjectStore('steps', { keyPath: 'pk' });
        s.createIndex('workflowId', 'workflowId', { unique: false });
        s.createIndex('ts', 'ts', { unique: false });
        s.createIndex('status', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains('links')) {
        const s = db.createObjectStore('links', { keyPath: 'id' });
        s.createIndex('documentId', 'documentId', { unique: false });
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

  // Function overloads for typed document access
  async function docsAll(): Promise<KnownDocument[]>;
  async function docsAll<T extends InputsUnion>(type: DocumentType): Promise<Document<T>[]>;
  async function docsAll(type?: DocumentType): Promise<any[]> {
    const t0 = tx(db, ['documents']);
    const s0 = t0.objectStore('documents');
    const req0 = s0.getAll();
    const list: any[] = await new Promise(res => { req0.onsuccess = () => res(req0.result as any[]); });
    const sorted = list.slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    if (!type) return sorted as KnownDocument[];
    const filtered = sorted.filter(d => d.type === type);
    const guarded = filtered.filter((d) => {
      return (type === 'narrative' && isNarrativeInputs(d.inputs)) || (type === 'fhir' && isFhirInputs(d.inputs));
    });
    return guarded as any;
  }

  async function docsGet(id: ID): Promise<KnownDocument | undefined>;
  async function docsGet<T extends InputsUnion>(id: ID, expectedType: DocumentType): Promise<Document<T> | undefined>;
  async function docsGet(id: ID, expectedType?: DocumentType): Promise<any | undefined> {
    const t0 = tx(db, ['documents']);
    const s0 = t0.objectStore('documents');
    const req0 = s0.get(id);
    const rec = await new Promise<any>(res => { req0.onsuccess = () => res(req0.result as any | undefined); });
    if (!rec) return undefined;
    if (!expectedType) return rec as KnownDocument;
    if (rec.type !== expectedType) return undefined;
    const ok = (expectedType === 'narrative' && isNarrativeInputs(rec.inputs)) || (expectedType === 'fhir' && isFhirInputs(rec.inputs));
    if (!ok) return undefined;
    return rec as any;
  }

  const stores: Stores = {
    documents: {
      async create<T extends InputsUnion>(id: ID, title: string, type: DocumentType, inputs: T): Promise<void> {
        const t = tx(db, ['documents'], 'readwrite');
        const s = t.objectStore('documents');
        const getReq = s.get(id);
        await new Promise(res => { getReq.onsuccess = () => res(null); });
        const existing = getReq.result as KnownDocument | undefined;
        if (!existing) {
          // Basic guard before insert
          const ok = (type === 'narrative' && isNarrativeInputs(inputs)) || (type === 'fhir' && isFhirInputs(inputs));
          if (!ok) throw new Error(`Invalid inputs for type '${type}'`);
          const rec: KnownDocument = { id, title, type, inputs, status: 'running', createdAt: nowIso(), updatedAt: nowIso() } as KnownDocument;
          s.put(rec as any);
          await new Promise(res => { t.oncomplete = () => res(null); });
          events.emit({ type: 'document_created', id, title, documentId: id, documentType: type } as Event);
        }
      },
      all: docsAll as any,
      get: docsGet as any,
      async put(doc: KnownDocument): Promise<void> {
        const t = tx(db, ['documents'], 'readwrite');
        const s = t.objectStore('documents');
        // Guard before upsert
        const ok = (doc.type === 'narrative' && isNarrativeInputs((doc as any).inputs)) || (doc.type === 'fhir' && isFhirInputs((doc as any).inputs));
        if (!ok) throw new Error(`Invalid inputs for type '${(doc as any).type}'`);
        s.put(doc as any);
        await new Promise(res => { t.oncomplete = () => res(null); });
        events.emit({ type: 'document_created', id: doc.id, title: doc.title, documentId: doc.id, documentType: doc.type } as Event);
      },
      async updateStatus(id: ID, status: KnownDocument['status']): Promise<void> {
        const t = tx(db, ['documents'], 'readwrite');
        const s = t.objectStore('documents');
        const getReq = s.get(id);
        await new Promise(res => { getReq.onsuccess = () => res(null); });
        const doc = getReq.result as KnownDocument | undefined;
        if (doc) {
          const prev = (doc as any).status;
          (doc as any).status = status;
          (doc as any).updatedAt = nowIso();
          s.put(doc as any);
          await new Promise(res => { t.oncomplete = () => res(null); });
          try { console.log('[doc.status]', { id, from: prev, to: status }); } catch {}
          events.emit({ type: 'document_status', id, status, documentId: id, documentType: (doc as any).type } as Event);
        }
      },
      async delete(id: ID): Promise<void> {
        const t = tx(db, ['documents'], 'readwrite');
        const s = t.objectStore('documents');
        s.delete(id);
        await new Promise(res => { t.oncomplete = () => res(null); });
        events.emit({ type: 'document_deleted', id } as Event);
      }
    },

    workflows: {
      async create(id: ID, documentId: ID, name: string): Promise<void> {
        const t = tx(db, ['workflows'], 'readwrite');
        const s = t.objectStore('workflows');
        const getReq = s.get(id);
        await new Promise(res => { getReq.onsuccess = () => res(null); });
        const existing = getReq.result as Workflow | undefined;
        if (!existing) {
          const rec: Workflow = { id, documentId, name, status: 'running', lastError: null, createdAt: nowIso(), updatedAt: nowIso() };
          s.put(rec);
          await new Promise(res => { t.oncomplete = () => res(null); });
          events.emit({ type: 'workflow_created', id, documentId, name } as Event);
        }
      },
      async setStatus(id: ID, status: Workflow['status'], lastError?: string | null): Promise<void> {
        const t = tx(db, ['workflows'], 'readwrite');
        const s = t.objectStore('workflows');
        const getReq = s.get(id);
        await new Promise(res => { getReq.onsuccess = () => res(null); });
        const wf = getReq.result as Workflow | undefined;
        if (wf) {
          wf.status = status;
          wf.lastError = lastError ?? null;
          wf.updatedAt = nowIso();
          s.put(wf);
          await new Promise(res => { t.oncomplete = () => res(null); });
          events.emit({ type: 'workflow_status', id, documentId: wf.documentId, status, lastError: wf.lastError } as Event);
        }
      },
      async listResumable(): Promise<Array<{ id: ID; documentId: ID; name: string }>> {
        const t = tx(db, ['workflows']);
        const s = t.objectStore('workflows');
        const req = s.getAll();
        const list: Workflow[] = await new Promise(res => { req.onsuccess = () => res(req.result as Workflow[]); });
        return list
          .filter(w => w.status === 'running' || w.status === 'pending' || w.status === 'failed')
          .map(w => ({ id: w.id, documentId: w.documentId, name: w.name }));
      },
      async deleteByDocument(documentId: ID): Promise<void> {
        const t = tx(db, ['workflows'], 'readwrite');
        const s = t.objectStore('workflows');
        const req = s.index('documentId').getAll(IDBKeyRange.only(documentId));
        const list: Workflow[] = await new Promise(res => { req.onsuccess = () => res(req.result as Workflow[]); });
        for (const wf of list) s.delete(wf.id);
        await new Promise(res => { t.oncomplete = () => res(null); });
      }
    },

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
      async listByDocument(documentId: ID, pred?: (a: Artifact) => boolean): Promise<Artifact[]> {
        const t = tx(db, ['artifacts']);
        const s = t.objectStore('artifacts');
        const req = s.index('documentId').getAll(IDBKeyRange.only(documentId));
        let list: Artifact[] = await new Promise(res => { req.onsuccess = () => res(req.result as Artifact[]); });
        list = list.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
        if (pred) list = list.filter(pred);
        return list;
      },
      async latestVersion(documentId: ID, kind: string, tagsKey?: string, tagsValue?: any): Promise<number | null> {
        const list = await this.listByDocument(documentId, (a: Artifact) => a.kind === kind && (!tagsKey || a.tags?.[tagsKey] === tagsValue));
        const sorted = list.sort((a, b) => b.version - a.version);
        return sorted.length > 0 ? sorted[0].version : null;
      },
      async deleteByDocument(documentId: ID): Promise<void> {
        const t = tx(db, ['artifacts'], 'readwrite');
        const s = t.objectStore('artifacts');
        const req = s.index('documentId').getAll(IDBKeyRange.only(documentId));
        const list: Artifact[] = await new Promise(res => { req.onsuccess = () => res(req.result as Artifact[]); });
        for (const a of list) s.delete(a.id);
        await new Promise(res => { t.oncomplete = () => res(null); });
        events.emit({ type: 'artifacts_cleared', documentId } as Event);
      }
    },

    steps: {
      async get(workflowId: ID, key: string): Promise<Step | undefined> {
        const pk = `${workflowId}:${key}`;
        const t = tx(db, ['steps']);
        const s = t.objectStore('steps');
        const req = s.get(pk);
        const rec = await new Promise<any>(res => { req.onsuccess = () => res(req.result); });
        if (!rec) return undefined;
        const { pk: _pk, ...rest } = rec;
        return rest as Step;
      },
      async put(rec: Partial<Step>): Promise<void> {
        const pk = `${rec.workflowId}:${rec.key}`;
        const t = tx(db, ['steps'], 'readwrite');
        const s = t.objectStore('steps');
        s.put({ ...rec, pk });
        await new Promise(res => { t.oncomplete = () => res(null); });
        const wfTx = tx(db, ['workflows']);
        const wfStore = wfTx.objectStore('workflows');
        const wfReq = wfStore.get(rec.workflowId as ID);
        const wf = await new Promise<Workflow | undefined>(res => { wfReq.onsuccess = () => res(wfReq.result as Workflow | undefined); });
        emitStepSaved(events, rec as any, wf?.documentId);
      },
      async listByDocument(documentId: ID): Promise<Step[]> {
        const wfTx = tx(db, ['workflows']);
        const wfStore = wfTx.objectStore('workflows');
        const wfReq = wfStore.index('documentId').getAll(IDBKeyRange.only(documentId));
        const wfs: Workflow[] = await new Promise(res => { wfReq.onsuccess = () => res(wfReq.result as Workflow[]); });
        const ids = new Set(wfs.map(w => w.id));
        const t = tx(db, ['steps']);
        const s = t.objectStore('steps');
        const req = s.getAll();
        const all: any[] = await new Promise(res => { req.onsuccess = () => res(req.result as any[]); });
        const steps = all.filter(r => ids.has(r.workflowId)).map(r => { const { pk: _pk, ...rest } = r; return rest as Step; });
        return steps.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
      },
      async listByWorkflow(workflowId: ID): Promise<Step[]> {
        const t = tx(db, ['steps']);
        const s = t.objectStore('steps');
        const req = s.index('workflowId').getAll(IDBKeyRange.only(workflowId));
        const all: any[] = await new Promise(res => { req.onsuccess = () => res(req.result as any[]); });
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
      async deleteByDocument(documentId: ID): Promise<void> {
        const wfTx = tx(db, ['workflows']);
        const wfStore = wfTx.objectStore('workflows');
        const wfReq = wfStore.index('documentId').getAll(IDBKeyRange.only(documentId));
        const wfs: Workflow[] = await new Promise(res => { wfReq.onsuccess = () => res(wfReq.result as Workflow[]); });
        const ids = new Set(wfs.map(w => w.id));
        const t = tx(db, ['steps'], 'readwrite');
        const s = t.objectStore('steps');
        const req = s.getAll();
        const all: any[] = await new Promise(res => { req.onsuccess = () => res(req.result as any[]); });
        for (const r of all) if (ids.has(r.workflowId)) s.delete(r.pk);
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
        const reqAll = s.index('documentId').getAll(IDBKeyRange.only(l.documentId));
        const list: Link[] = await new Promise(res => { reqAll.onsuccess = () => res(reqAll.result as Link[]); });
        const composite = `${l.documentId}-${l.fromType}-${l.fromId}-${l.toType}-${l.toId}-${l.role}`;
        const dup = list.find(li => `${li.documentId}-${li.fromType}-${li.fromId}-${li.toType}-${li.toId}-${li.role}` === composite && li.id !== l.id);
        if (dup) s.delete(dup.id);
        s.put(l);
        await new Promise(res => { t.oncomplete = () => res(null); });
        emitLinkSaved(events, l);
      },
      async listByDocument(documentId: ID): Promise<Link[]> {
        const t = tx(db, ['links']);
        const s = t.objectStore('links');
        const req = s.index('documentId').getAll(IDBKeyRange.only(documentId));
        const list: Link[] = await new Promise(res => { req.onsuccess = () => res(req.result as Link[]); });
        return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      },
      async deleteByDocument(documentId: ID): Promise<void> {
        const t = tx(db, ['links'], 'readwrite');
        const s = t.objectStore('links');
        const req = s.index('documentId').getAll(IDBKeyRange.only(documentId));
        const list: Link[] = await new Promise(res => { req.onsuccess = () => res(req.result as Link[]); });
        for (const l of list) s.delete(l.id);
        await new Promise(res => { t.oncomplete = () => res(null); });
        events.emit({ type: 'links_cleared', documentId } as Event);
      }
    },

    events
  };

  return stores;
}
