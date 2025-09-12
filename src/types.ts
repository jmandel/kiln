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

// =============================
// Generic Document Model
// =============================

export type DocumentType = "narrative" | "fhir";

export interface NarrativeInputs {
  sketch: string;
}

export interface Source {
  documentId: ID;
  artifactId?: ID;
}

export interface FhirInputs {
  noteText: string;
  source?: Source;
}

export type InputsUnion = NarrativeInputs | FhirInputs;

export interface DocumentTags {
  blockedOn?: ID[];
  [key: string]: any;
}

export interface BaseDocument {
  id: ID;
  title: string;
  status: "running" | "done" | "blocked";
  createdAt: string;
  updatedAt: string;
}

export interface Document<T = InputsUnion> extends BaseDocument {
  type: DocumentType;
  inputs: T;
  tags?: DocumentTags;
}

export type KnownDocument = Document<NarrativeInputs> | Document<FhirInputs>;

export function isNarrativeInputs(inputs: unknown): inputs is NarrativeInputs {
  return !!inputs && typeof inputs === 'object' && typeof (inputs as any).sketch === 'string';
}

export function isFhirInputs(inputs: unknown): inputs is FhirInputs {
  if (!inputs || typeof inputs !== 'object') return false;
  const noteTextOk = typeof (inputs as any).noteText === 'string';
  const src = (inputs as any).source;
  const srcOk = src == null || (
    src && typeof src === 'object' && typeof (src as any).documentId === 'string' && (
      (src as any).artifactId == null || typeof (src as any).artifactId === 'string'
    )
  );
  return noteTextOk && srcOk;
}

export function isNarrativeDocument(doc: KnownDocument | undefined): doc is Document<NarrativeInputs> {
  return !!doc && doc.type === 'narrative' && isNarrativeInputs((doc as any).inputs);
}

export function isFhirDocument(doc: KnownDocument | undefined): doc is Document<FhirInputs> {
  return !!doc && doc.type === 'fhir' && isFhirInputs((doc as any).inputs);
}

// =============================
// Workflows / Context (generic-friendly)
// =============================

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
  getStepResult: (stepKey: string) => Promise<any>;
  isPhaseComplete: (phaseName: string) => Promise<boolean>;
  createArtifact: (spec: { id?: ID; kind: string; version: number; title?: string; content?: string; tags?: Record<string, any>; links?: Array<{ dir: "from"; role: string; ref: { type: EntityType; id: ID }; tags?: Record<string, any>; }>; autoProduced?: boolean; }) => Promise<Artifact>;
  link: (from: { type: EntityType; id: ID }, role: string, to: { type: EntityType; id: ID }, tags?: Record<string, any>) => Promise<any>;
  callLLMEx?: (modelTask: string, prompt: string, opts?: { expect?: "text" | "json"; temperature?: number; tags?: Record<string, any>; }) => Promise<{ result: any; meta: { stepKey: string; tokensUsed: number; raw: string; attempts: number; status?: number; prompt: string } }>;
}

export type TypedContext<T> = Context & { inputs: T };

// Make workflow compatible with current engine (context-agnostic function signature)
export type DocumentWorkflow<T> = Array<(ctx: Context) => Promise<void>>;

// =============================
// Registry Typings
// =============================

export interface DocumentTypeDef<T extends InputsUnion> {
  // Optional example shape for UI scaffolding
  inputsShape?: Partial<T>;
  InputComponent?: React.FC<{
    stores?: Stores;
    initialInputs?: Partial<T>;
    onSubmit: (inputs: T) => void;
    onCancel: () => void;
  }>;
  buildWorkflow: (inputs: T) => DocumentWorkflow<T>;
  previewComponent?: React.FC<{ document: Document<T> }>;
}

// Simple document type registry interface
export type RegisteredType = 'narrative' | 'fhir';
export type AnyDef = DocumentTypeDef<InputsUnion>;
export interface DocumentTypeRegistry {
  register: <T extends InputsUnion>(type: RegisteredType, def: DocumentTypeDef<T>) => void;
  get: <T extends InputsUnion>(type: RegisteredType) => DocumentTypeDef<T> | undefined;
  all: () => Array<{ type: RegisteredType; def: AnyDef }>;
}

// =============================
// Workflows (legacy names)
// =============================

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
  documentType?: DocumentType;
  [key: string]: any;
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

export interface Prompts {
  [key: string]: (params: any) => string;
}

export interface Targets {
  SECTION: number;
  NOTE: number;
  SECTION_MAX_REVS: number;
  NOTE_MAX_REVS: number;
}

// =============================
// Stores API (generic-aware)
// =============================

export interface Stores {
  documents: {
    create: <T extends InputsUnion>(id: ID, title: string, type: DocumentType, inputs: T) => Promise<void>;
    // Overloads: list all or list by expected type (narrowed)
    all: {
      (): Promise<KnownDocument[]>;
      <T extends InputsUnion>(type: DocumentType): Promise<Document<T>[]>;
    };
    // Overloads: get by id (union) or by id with expected type (narrowed)
    get: {
      (id: ID): Promise<KnownDocument | undefined>;
      <T extends InputsUnion>(id: ID, expectedType: DocumentType): Promise<Document<T> | undefined>;
    };
    put: (doc: KnownDocument) => Promise<void>;
    updateStatus: (id: ID, status: BaseDocument["status"]) => Promise<void>;
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
