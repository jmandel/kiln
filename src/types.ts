export type ID = string;

export type EntityType = "artifact" | "step" | "document" | "workflow";

export interface Artifact {
  id: ID;
  documentId: ID;
  kind: string;
  version: number;
  title?: string;
  content?: string;
  tags?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface Step {
  workflowId: ID;
  key: string;
  title?: string;
  status: "running" | "pending" | "done" | "failed";
  resultJson: string;
  tagsJson?: string | null;
  parentKey?: string | null;
  error?: string | null;
  progress?: number | null;
  durationMs?: number | null;
  llmTokens?: number | null;
  prompt?: string | null;
  ts: string;
}

export interface Document {
  id: ID;
  title: string;
  sketch: string;
  status: "running" | "done" | "blocked";
  createdAt: string;
  updatedAt: string;
}

export interface Workflow {
  id: ID;
  documentId: ID;
  name: string;
  status: "running" | "pending" | "done" | "failed";
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Link {
  id: ID;
  documentId: ID;
  fromType: EntityType;
  fromId: ID;
  toType: EntityType;
  toId: ID;
  role: string;
  tags?: Record<string, any>;
  createdAt: string;
}

export interface Event {
  type: string;
  [key: string]: any;
}

export interface DocumentSummary {
  documentId: ID;
  title: string;
  lane: "in_progress" | "blocked" | "done";
  phase: string;
  counts: {
    running: number;
    failed: number;
    done: number;
    pending: number;
  };
  lastUpdated: string | null;
  badges: Array<{ label: string; value: string }>;
  reason?: string | null;
}

export interface Config {
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number;
}

export interface LLMResult {
  result: string | object;
  tokensUsed: number;
}

export interface Stores {
  documents: {
    create: (id: ID, title: string, sketch: string) => Promise<void>;
    all: () => Promise<Document[]>;
    get: (id: ID) => Promise<Document | undefined>;
    updateStatus: (id: ID, status: Document["status"]) => Promise<void>;
    delete: (id: ID) => Promise<void>;
  };
  workflows: {
    create: (id: ID, documentId: ID, name: string) => Promise<void>;
    setStatus: (id: ID, status: Workflow["status"], lastError?: string | null) => Promise<void>;
    listResumable: () => Promise<Array<{ id: ID; documentId: ID; name: string }>>;
    deleteByDocument: (documentId: ID) => Promise<void>;
  };
  artifacts: {
    get: (id: ID) => Promise<Artifact | undefined>;
    upsert: (a: Artifact) => Promise<void>;
    listByDocument: (documentId: ID, pred?: (a: Artifact) => boolean) => Promise<Artifact[]>;
    latestVersion: (documentId: ID, kind: string, tagsKey?: string, tagsValue?: any) => Promise<number | null>;
    deleteByDocument: (documentId: ID) => Promise<void>;
  };
  steps: {
    get: (workflowId: ID, key: string) => Promise<Step | undefined>;
    put: (rec: Partial<Step>) => Promise<void>;
    listByDocument: (documentId: ID) => Promise<Step[]>;
    listByWorkflow: (workflowId: ID) => Promise<Step[]>;
    listRunning: () => Promise<Step[]>;
    deleteByDocument: (documentId: ID) => Promise<void>;
  };
  links: {
    get: (id: ID) => Promise<Link | undefined>;
    upsert: (l: Link) => Promise<void>;
    listByDocument: (documentId: ID) => Promise<Link[]>;
    deleteByDocument: (documentId: ID) => Promise<void>;
  };
  events: EventHub;
}

export class EventHub {
  private subs = new Set<((ev: Event) => void)>();

  subscribe(fn: (ev: Event) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  emit(ev: Event): void {
    for (const s of this.subs) {
      queueMicrotask(() => {
        try { s(ev); } catch {}
      });
    }
  }
}

export interface ContextOpts {
  title?: string;
  tags?: Record<string, any>;
  parentKey?: string;
  forceRecompute?: boolean;
  prompt?: string;
}

export interface Context {
  workflowId: ID;
  documentId: ID;
  stores: Stores;
  step: (key: string, fn: () => Promise<any>, opts?: ContextOpts) => Promise<any>;
  group: (title: string, tags: Record<string, any>, fn: () => Promise<void>) => Promise<void>;
  getStepResult: (stepKey: string) => Promise<any>;
  isPhaseComplete: (phaseName: string) => Promise<boolean>;
  createArtifact: (spec: { id?: ID; kind: string; version: number; title?: string; content?: string; tags?: Record<string, any>; links?: Array<{ dir: "from"; role: string; ref: { type: EntityType; id: ID }; tags?: Record<string, any>; }>; autoProduced?: boolean; }) => Promise<Artifact>;
  link: (from: { type: EntityType; id: ID }, role: string, to: { type: EntityType; id: ID }, tags?: Record<string, any>) => Promise<Link>;
  callLLM: (modelTask: string, prompt: string, opts?: { expect?: "text" | "json"; temperature?: number; tags?: Record<string, any>; }) => Promise<any>;
  // Extended API returns result + metadata for artifact creation without step lookups
  callLLMEx?: (modelTask: string, prompt: string, opts?: { expect?: "text" | "json"; temperature?: number; tags?: Record<string, any>; }) => Promise<{ result: any; meta: { stepKey: string; tokensUsed: number; raw: string; attempts: number; status?: number; prompt: string } }>;
  // Non-caching labeled container
  span?: (title: string, tags: Record<string, any>, fn: () => Promise<void>) => Promise<void>;
}

export interface PromptParams {
  [key: string]: any;
}

export interface Prompts {
  [key: string]: (params: any) => string;
}

export interface Targets {
  SECTION: number;
  NOTE: number;
  SECTION_MAX_REVS: number;
  NOTE_MAX_REVS: number;
}
