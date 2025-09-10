import type { ID, Document, Workflow, Artifact, Step, Link, Event, Stores } from './types';
import { EventHub } from './types';
import { emitArtifactSaved, emitLinkSaved, emitStepSaved, sortByUpdatedAtAsc, sortByTsAsc } from './stores.base';
import { STORAGE_KEYS, nowIso } from './helpers';


function loadFromStorage(key: string): any[] {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveToStorage(key: string, data: any): void {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    console.error('localStorage quota exceeded:', e);
  }
}

export function createLocalStores(): Stores {
  const events = new EventHub();

  let docCache: Document[] = loadFromStorage(STORAGE_KEYS.documents);
  let wfCache: Workflow[] = loadFromStorage(STORAGE_KEYS.workflows);
  let artCache: Artifact[] = loadFromStorage(STORAGE_KEYS.artifacts);
  let stepCache: Step[] = loadFromStorage(STORAGE_KEYS.steps);
  let linkCache: Link[] = loadFromStorage(STORAGE_KEYS.links);

  function syncCache(): void {
    saveToStorage(STORAGE_KEYS.documents, docCache);
    saveToStorage(STORAGE_KEYS.workflows, wfCache);
    saveToStorage(STORAGE_KEYS.artifacts, artCache);
    saveToStorage(STORAGE_KEYS.steps, stepCache);
    saveToStorage(STORAGE_KEYS.links, linkCache);
  }

  const stores: Stores = {
    documents: {
      async create(id: ID, title: string, sketch: string): Promise<void> {
        const existing = docCache.find(d => d.id === id);
        if (!existing) {
          const newDoc: Document = { id, title, sketch, status: "running", createdAt: nowIso(), updatedAt: nowIso() };
          docCache.push(newDoc);
          syncCache();
          events.emit({ type: "document_created", id, documentId: id, title } as Event);
        }
      },
      async all(): Promise<Document[]> {
        return docCache.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      },
      async get(id: ID): Promise<Document | undefined> {
        return docCache.find(d => d.id === id);
      },
      async updateStatus(id: ID, status: Document["status"]): Promise<void> {
        const doc = docCache.find(d => d.id === id);
        if (doc) {
          doc.status = status;
          doc.updatedAt = nowIso();
          syncCache();
          events.emit({ type: "document_status", id, documentId: id, status } as Event);
        }
      },
      async delete(id: ID): Promise<void> {
        const idx = docCache.findIndex(d => d.id === id);
        if (idx > -1) {
          docCache.splice(idx, 1);
          syncCache();
          events.emit({ type: "document_deleted", id, documentId: id } as Event);
        }
      }
    },

    workflows: {
      async create(id: ID, documentId: ID, name: string): Promise<void> {
        const existing = wfCache.find(w => w.id === id);
        if (!existing) {
          const newWf: Workflow = { id, documentId, name, status: "running", lastError: null, createdAt: nowIso(), updatedAt: nowIso() };
          wfCache.push(newWf);
          syncCache();
          events.emit({ type: "workflow_created", id, documentId, name } as Event);
        }
      },
      async setStatus(id: ID, status: Workflow["status"], lastError?: string | null): Promise<void> {
        const wf = wfCache.find(w => w.id === id);
        if (wf) {
          wf.status = status;
          wf.lastError = lastError ?? null;
          wf.updatedAt = nowIso();
          syncCache();
          events.emit({ type: "workflow_status", id, documentId: wf.documentId, status, lastError: lastError ?? null } as Event);
        }
      },
      async listResumable(): Promise<Array<{ id: ID; documentId: ID; name: string }>> {
        return wfCache
          .filter(w => w.status === "running" || w.status === "pending" || w.status === "failed")
          .map(w => ({ id: w.id, documentId: w.documentId, name: w.name }));
      },
      async deleteByDocument(documentId: ID): Promise<void> {
        wfCache = wfCache.filter(w => w.documentId !== documentId);
        syncCache();
      }
    },

    artifacts: {
      async get(id: ID): Promise<Artifact | undefined> {
        return artCache.find(a => a.id === id);
      },
      async upsert(a: Artifact): Promise<void> {
        const existingIdx = artCache.findIndex(ar => ar.id === a.id);
        if (existingIdx > -1) {
          artCache[existingIdx] = { ...artCache[existingIdx], ...a, updatedAt: a.updatedAt };
        } else {
          artCache.push(a);
        }
        syncCache();
        emitArtifactSaved(events, a);
      },
      async listByDocument(documentId: ID, pred?: (a: Artifact) => boolean): Promise<Artifact[]> {
        let list = sortByUpdatedAtAsc(artCache.filter(a => a.documentId === documentId));
        if (pred) list = list.filter(pred);
        return list;
      },
      async latestVersion(documentId: ID, kind: string, tagsKey?: string, tagsValue?: any): Promise<number | null> {
        let list = artCache.filter(a => a.documentId === documentId && a.kind === kind);
        if (tagsKey && tagsValue) list = list.filter(a => a.tags?.[tagsKey] === tagsValue);
        const sorted = list.sort((a, b) => b.version - a.version);
        return sorted.length > 0 ? sorted[0].version : null;
      },
      async deleteByDocument(documentId: ID): Promise<void> {
        artCache = artCache.filter(a => a.documentId !== documentId);
        syncCache();
        events.emit({ type: "artifacts_cleared", documentId } as Event);
      }
    },

    steps: {
      async get(workflowId: ID, key: string): Promise<Step | undefined> {
        return stepCache.find(s => s.workflowId === workflowId && s.key === key);
      },
      async put(rec: Partial<Step>): Promise<void> {
        const existingIdx = stepCache.findIndex(st => st.workflowId === rec.workflowId && st.key === rec.key);
        if (existingIdx > -1) {
          stepCache[existingIdx] = { ...stepCache[existingIdx], ...rec };
        } else {
          stepCache.push(rec as Step);
        }
        syncCache();
        const wf = wfCache.find(w => w.id === rec.workflowId);
        emitStepSaved(events, rec as any, wf?.documentId);
      },
      async listByDocument(documentId: ID): Promise<Step[]> {
        const wfIds = wfCache.filter(w => w.documentId === documentId).map(w => w.id);
        return sortByTsAsc(stepCache.filter(s => wfIds.includes(s.workflowId)));
      },
      async listByWorkflow(workflowId: ID): Promise<Step[]> {
        return sortByTsAsc(stepCache.filter(s => s.workflowId === workflowId));
      },
      async listRunning(): Promise<Step[]> {
        return sortByTsAsc(stepCache.filter(s => s.status === "running" || s.status === "pending"));
      },
      async deleteByDocument(documentId: ID): Promise<void> {
        const wfIds = wfCache.filter(w => w.documentId === documentId).map(w => w.id);
        stepCache = stepCache.filter(s => !wfIds.includes(s.workflowId));
        syncCache();
      }
    },

    links: {
      async get(id: ID): Promise<Link | undefined> {
        return linkCache.find(l => l.id === id);
      },
      async upsert(l: Link): Promise<void> {
        const existingIdx = linkCache.findIndex(li => li.id === l.id);
        const compositeKey = `${l.documentId}-${l.fromType}-${l.fromId}-${l.toType}-${l.toId}-${l.role}`;
        const dupIdx = linkCache.findIndex(li => li.id !== l.id && `${li.documentId}-${li.fromType}-${li.fromId}-${li.toType}-${li.toId}-${li.role}` === compositeKey);
        if (dupIdx >= 0) linkCache.splice(dupIdx, 1);
        if (existingIdx > -1) linkCache[existingIdx] = { ...linkCache[existingIdx], ...l };
        else linkCache.push(l);
        syncCache();
        emitLinkSaved(events, l);
      },
      async listByDocument(documentId: ID): Promise<Link[]> {
        return linkCache.filter(l => l.documentId === documentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      },
      async deleteByDocument(documentId: ID): Promise<void> {
        linkCache = linkCache.filter(l => l.documentId !== documentId);
        syncCache();
        events.emit({ type: "links_cleared", documentId } as Event);
      }
    },

    events
  };

  return stores;
}
