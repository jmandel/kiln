import React, { useEffect, useMemo, useState } from 'react';
import { createStores } from '../stores.adapter';
import type { Stores, ID, Step, Job } from '../types';
import { isNarrativeInputs, isFhirInputs } from '../types';
import DocGenDashboard from './DocGenDashboard';
import ArtifactDetails from './ArtifactDetails';
import StepDetails from './StepDetails';
import { pretty, tryJson } from './ui';
import logoUrl from '../../public/logo.png';
import { config as appConfig } from '../config';
// New jobs-first API (no runs in UI)
import {
  createJob,
  startJob as startJobApi,
  rerunJob,
  clearJobCache as clearJobCacheAPI,
  resumeJob,
  triggerReadyJobs,
} from '../jobs';
import { sha256 } from '../helpers';
import { useDashboardState, useJobsList } from '../hooks/useDashboardState';
import { DashboardStore } from '../dashboardStore';
import { JobsList } from './ui/JobsList';
import { registry } from '../documentTypes/registry';
import type { DocumentType, InputsUnion, FhirInputs, NarrativeInputs } from '../types';

function mapDocStatus(s: Job['status']): 'queued' | 'running' | 'done' | 'error' {
  if (s === 'running') return 'running';
  if (s === 'done') return 'done';
  if (s === 'blocked') return 'queued';
  return 'error';
}

function guessKind(kind: string): 'draft' | 'outline' | 'assets' | 'review' | 'final' | string {
  const k = kind.toLowerCase();
  if (k.includes('outline')) return 'outline';
  if (k.includes('draft')) return 'draft';
  if (k.includes('note')) return 'final';
  if (k.includes('asset')) return 'assets';
  if (k.includes('review')) return 'review';
  return k;
}

// Configuration Modal Component
function ConfigModal({ config, onSave, onClose }: { config: any; onSave: (cfg: any) => void; onClose: () => void }) {
  const [cfg, setCfg] = useState(config);
  const [defaults, setDefaults] = useState<{ [k: string]: any } | null>(null);
  useEffect(() => {
    (async () => {
      try {
        await appConfig.ready();
        setDefaults({
          baseURL: appConfig.baseURL(),
          model: appConfig.model(),
          temperature: appConfig.temperature(),
          fhirBaseURL: appConfig.fhirBaseURL(),
          validationServicesURL: appConfig.validationServicesURL() || '[same-origin]',
          fhirGenConcurrency: appConfig.fhirGenConcurrency(),
        });
      } catch {}
    })();
  }, []);

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="card-kiln w-full max-w-md p-6 max-h-[calc(100vh-2rem)] overflow-y-auto">
        <h2 className="text-lg font-semibold mb-4">API Configuration</h2>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-text-charcoal mb-1">Base URL</label>
            <input
              className="input-kiln"
              value={cfg.baseURL}
              onChange={(e) => setCfg({ ...cfg, baseURL: e.target.value })}
              placeholder={defaults?.baseURL || ''}
            />
            <p className="text-xs text-gray-500 mt-1">Default: {defaults?.baseURL || '…'}</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-charcoal mb-1">API Key</label>
            <input
              className="input-kiln"
              type="password"
              value={cfg.apiKey}
              onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })}
              placeholder="sk-..."
            />
            <p className="text-xs text-gray-500 mt-1">Stored only in your browser. Not sent to server.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-charcoal mb-1">Model</label>
            <input
              className="input-kiln"
              value={cfg.model}
              onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
              placeholder={defaults?.model || ''}
            />
            <p className="text-xs text-gray-500 mt-1">Default: {defaults?.model || '…'}</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-charcoal mb-1">Temperature</label>
            <input
              className="input-kiln"
              value={cfg.temperature}
              onChange={(e) => setCfg({ ...cfg, temperature: e.target.value })}
              placeholder={String(defaults?.temperature ?? '')}
            />
            <p className="text-xs text-gray-500 mt-1">Default: {String(defaults?.temperature ?? '…')}</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-charcoal mb-1">FHIR Base URL</label>
            <input
              className="input-kiln"
              value={cfg.fhirBaseURL}
              onChange={(e) => setCfg({ ...cfg, fhirBaseURL: e.target.value })}
              placeholder={defaults?.fhirBaseURL || ''}
            />
            <p className="text-xs text-gray-500 mt-1">
              Used for Bundle.entry.fullUrl. Relative references like "Observation/abc" will resolve to{' '}
              <code>FHIR Base URL</code>/Observation/abc.
            </p>
            <p className="text-xs text-gray-500 mt-1">Default: {defaults?.fhirBaseURL || '…'}</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-charcoal mb-1">Validation Services URL</label>
            <input
              className="input-kiln"
              value={cfg.validationServicesURL}
              onChange={(e) => setCfg({ ...cfg, validationServicesURL: e.target.value })}
              placeholder={defaults?.validationServicesURL || ''}
            />
            <p className="text-xs text-gray-500 mt-1">
              Base used for both <code>/validate</code> and <code>/tx</code> endpoints.
            </p>
            <p className="text-xs text-gray-500 mt-1">Default: {defaults?.validationServicesURL || '[same-origin]'}</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-charcoal mb-1">FHIR Generation Concurrency</label>
            <input
              className="input-kiln"
              type="number"
              min={1}
              value={cfg.fhirGenConcurrency}
              onChange={(e) => setCfg({ ...cfg, fhirGenConcurrency: e.target.value })}
              placeholder={String(defaults?.fhirGenConcurrency ?? '')}
            />
            <p className="text-xs text-gray-500 mt-1">
              How many FHIR resources to generate/refine in parallel. 1 = sequential (grouped artifacts).
            </p>
            <p className="text-xs text-gray-500 mt-1">Default: {String(defaults?.fhirGenConcurrency ?? '1')}</p>
          </div>
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <button className="btn-kiln-outline" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-kiln"
            onClick={() => {
              onSave(cfg);
              onClose();
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DocGenApp(): React.ReactElement {
  const [stores, setStores] = useState<Stores | null>(null);
  const [store, setStore] = useState<DashboardStore | null>(null);
  const [selected, setSelected] = useState<ID | null>(null);
  const [input, setInput] = useState({ title: '', sketch: '' });
  const [modalOpen, setModalOpen] = useState(false);
  const [docType, setDocType] = useState<DocumentType>('narrative');
  const [alsoFhir, setAlsoFhir] = useState<boolean>(false);
  const [fhirSourceId, setFhirSourceId] = useState<string>('');
  const [initialInputs, setInitialInputs] = useState<Partial<InputsUnion>>({});
  const [configOpen, setConfigOpen] = useState(false);
  const [viewArtifactId, setViewArtifactId] = useState<ID | null>(null);
  const [failedStep, setFailedStep] = useState<Step | null>(null);
  const urlCache = React.useRef<Map<string, string>>(new Map());
  const [cfg, setCfg] = useState({
    baseURL: localStorage.getItem('OVERRIDE_BASE_URL') || '',
    apiKey: localStorage.getItem('TASK_DEFAULT_API_KEY') || '',
    model: localStorage.getItem('OVERRIDE_MODEL') || '',
    temperature: localStorage.getItem('OVERRIDE_TEMPERATURE') || '',
    fhirBaseURL: localStorage.getItem('OVERRIDE_FHIR_BASE_URL') || '',
    validationServicesURL: localStorage.getItem('OVERRIDE_VALIDATION_SERVICES_URL') || '',
    fhirGenConcurrency: localStorage.getItem('OVERRIDE_FHIR_GEN_CONCURRENCY') || '',
  });

  useEffect(() => {
    let mounted = true;
    (async () => {
      const s = await createStores();
      if (!mounted) return;
      setStores(s);
      // On app load, mark any previously running jobs as paused
      try {
        const all = await s.jobs.all();
        for (const j of all) {
          if ((j as any).status === 'running') {
            await s.jobs.updateStatus(j.id as any, 'paused' as any);
          }
        }
      } catch {}
      const ds = new DashboardStore(s);
      setStore(ds);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // No automatic starts/resumes on startup. All runs are explicit via Rerun.
  useEffect(() => {
    /* intentionally empty */
  }, [stores]);

  // Ensure dashboard starts empty on first load (no placeholders)
  useEffect(() => {
    if ((window as any).docGen?.set) {
      (window as any).docGen.set({
        jobId: '',
        title: '',
        status: 'queued',
        metrics: { stepCounts: {}, totalTokens: 0, elapsedMs: 0 },
        artifacts: [],
        events: [],
      });
    }
  }, []);

  // Dashboard state is driven by an external store hook now

  const startJob = async () => {
    if (!stores || !input.sketch) return alert('Enter a patient sketch');
    const title = input.title || `Patient: ${input.sketch.slice(0, 30)}...`;
    const jobId = await createJob(stores, 'narrative', { sketch: input.sketch } as NarrativeInputs, title);
    await startJobApi(stores, jobId);
    setSelected(jobId);
    setInput({ title: '', sketch: '' });
  };

  const handleDeleteJob = async (docId: ID) => {
    if (!stores) return;
    if (!confirm('Delete this job and all associated data?')) return;
    await stores.jobs.delete(docId);
    // workflows store removed in job-centric design
    await stores.artifacts.deleteByJob(docId);
    await stores.steps.deleteByJob(docId);
    await stores.links.deleteByJob(docId);
    if (selected === docId) {
      const remainingLocal = (docs || []).filter((d: any) => d.id !== docId);
      setSelected(remainingLocal[0]?.id || null);
      if (!remainingLocal[0]) {
        (window as any).docGen?.set &&
          (window as any).docGen.set({
            jobId: '',
            title: '',
            status: 'queued',
            metrics: { stepCounts: {}, totalTokens: 0, elapsedMs: 0 },
            artifacts: [],
            events: [],
          });
      }
    }
  };

  const saveConfig = (newCfg: typeof cfg) => {
    const setOrRemove = (k: string, v: any) => {
      const s = String(v ?? '').trim();
      if (s) localStorage.setItem(k, s);
      else localStorage.removeItem(k);
    };
    // Store overrides only when provided; else use server defaults
    setOrRemove('OVERRIDE_BASE_URL', newCfg.baseURL);
    setOrRemove('OVERRIDE_MODEL', newCfg.model);
    setOrRemove('OVERRIDE_TEMPERATURE', newCfg.temperature);
    setOrRemove('OVERRIDE_FHIR_BASE_URL', newCfg.fhirBaseURL);
    setOrRemove('OVERRIDE_VALIDATION_SERVICES_URL', newCfg.validationServicesURL);
    setOrRemove('OVERRIDE_FHIR_GEN_CONCURRENCY', newCfg.fhirGenConcurrency);
    // API key remains local-only
    setOrRemove('TASK_DEFAULT_API_KEY', newCfg.apiKey);
    setCfg(newCfg);
  };

  const handleRerun = async () => {
    if (!stores || !selected) return;
    await rerunJob(stores, selected);
  };

  const docs = useJobsList(store);
  const selectedDoc = useMemo(() => docs.find((d: any) => d.id === selected), [docs, selected]);
  const canConvertToFhir = useMemo(
    () => selectedDoc?.type === 'narrative' && selectedDoc?.status === 'done',
    [selectedDoc]
  );
  // Header creation controls (must run before any conditional returns)
  const doneNarratives = useMemo(() => docs.filter((d) => d.type === 'narrative' && d.status === 'done'), [docs]);

  const openCreateModal = (type: DocumentType, init?: Partial<InputsUnion>) => {
    setDocType(type);
    setInitialInputs(init || {});
    setModalOpen(true);
  };

  const convertSelectedToFhir = async () => {
    if (!stores || !selected) return;
    try {
      const trajectoryTags = (() => {
        const tags = (selectedDoc as any)?.tags || {};
        if (tags?.trajectoryParentId == null) return undefined;
        return {
          trajectoryParentId: tags.trajectoryParentId,
          trajectoryEpisodeNumber: tags.trajectoryEpisodeNumber,
          trajectoryDateOffset: tags.trajectoryDateOffset,
        };
      })();
      const fhirInputs: FhirInputs = {
        noteText: '',
        source: { jobId: selected, title: selectedDoc?.title } as any,
      };
      const docTitle = selectedDoc?.title ? `FHIR: ${selectedDoc.title}` : 'FHIR Bundle';
      const docId = await createJob(stores, 'fhir', fhirInputs, docTitle, {
        dependsOn: [selected as ID],
        tags: trajectoryTags,
      });
      setSelected(docId);
    } catch (e) {
      console.error('Convert to FHIR failed', e);
    }
  };

  // Generic: clear ALL step cache for this job, then resume (no workflow-specific knowledge)
  const clearAllStepCache = async () => {
    if (!stores || !selected) return alert('Select a job first');
    await clearJobCacheAPI(stores, selected);
    await startJobApi(stores, selected);
  };

  const openLatestFailedStep = async () => {
    if (!stores || !selected) return;
    const list = await stores.steps.listByJob(selected);
    const failed = list.filter((s) => s.status === 'failed').sort((a, b) => b.ts.localeCompare(a.ts))[0];
    if (failed) setFailedStep(failed);
    else alert('No failed step found for this job.');
  };

  const docList = useMemo(() => docs, [docs]);
  const dashboardState = useDashboardState(store, selected);

  // URL routing via query params
  React.useEffect(() => {
    const apply = () => {
      const sp = new URLSearchParams(window.location.search);
      const job = sp.get('job');
      const art = sp.get('artifact');
      if (job) setSelected(job);
      setViewArtifactId(art);
    };
    window.addEventListener('popstate', apply);
    apply();
    return () => window.removeEventListener('popstate', apply);
  }, []);

  // Auto-open newly created jobs: when jobs list grows, select the newest (sorted by updatedAt desc in store)
  const prevDocsLen = React.useRef<number>(0);
  React.useEffect(() => {
    try {
      if (docs.length > prevDocsLen.current) {
        const newest = docs[0]?.id as ID | undefined;
        if (newest) setSelected(newest);
      }
    } finally {
      prevDocsLen.current = docs.length;
    }
  }, [docs]);

  // Keep the URL in sync with the selected job so refresh restores selection
  React.useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      if (selected) sp.set('job', selected);
      else sp.delete('job');
      const url = `${window.location.pathname}?${sp.toString()}`;
      // Use replaceState to avoid polluting history excessively
      window.history.replaceState({}, '', url);
    } catch {}
  }, [selected]);

  const openArtifact = (id: ID) => {
    const sp = new URLSearchParams();
    if (selected) sp.set('job', selected);
    sp.set('artifact', id);
    const url = `${window.location.pathname}?${sp.toString()}`;
    window.open(url, '_blank', 'noopener');
  };

  // Full-page artifact viewer mode
  if (stores && new URLSearchParams(window.location.search).get('artifact')) {
    const sp = new URLSearchParams(window.location.search);
    const job = (sp.get('job') as ID) || selected || (docs[0]?.id as ID);
    const artId = sp.get('artifact') as ID;
    if (!job || !artId) return <div className="p-6">Loading…</div>;
    return (
      <ArtifactDetails
        stores={stores}
        jobId={job}
        artifactId={artId}
        onClose={() => {
          if (window.history.length > 1) history.back();
          else window.close();
        }}
        onOpenArtifact={(id) => {
          const q = new URLSearchParams(window.location.search);
          if (job) q.set('job', job);
          q.set('artifact', id);
          history.pushState(null, '', `?${q.toString()}`);
          setViewArtifactId(id);
        }}
        fullPage
      />
    );
  }

  const BRAND = {
    name: 'Kiln',
    tagline: 'Clinical content from raw clay',
    logo: logoUrl,
  } as const;

  const createFromHeader = async () => {
    if (!stores) return;
    if (docType === 'trajectory') {
      setInitialInputs({});
      setModalOpen(true);
      return;
    }
    if (docType === 'narrative') {
      const sketch = (input.sketch || '').trim();
      if (!sketch) {
        alert('Enter a patient sketch');
        return;
      }
      const title = input.title || `Patient: ${sketch.slice(0, 30)}...`;
      const narrId = await createJob(stores, 'narrative', { sketch } as NarrativeInputs, title);
      void startJobApi(stores, narrId).catch((err) => console.error('start narrative job failed', err));
      if (alsoFhir) {
        let trajectoryTags: Record<string, any> | undefined;
        try {
          const freshNarrJob = await stores.jobs.get(narrId);
          const tags = (freshNarrJob as any)?.tags || {};
          if (tags?.trajectoryParentId != null) {
            trajectoryTags = {
              trajectoryParentId: tags.trajectoryParentId,
              trajectoryEpisodeNumber: tags.trajectoryEpisodeNumber,
              trajectoryDateOffset: tags.trajectoryDateOffset,
            };
          }
        } catch {}
        await createJob(
          stores,
          'fhir',
          { noteText: '', source: { jobId: narrId, title } } as any,
          `FHIR: ${title}`,
          {
            dependsOn: [narrId],
            tags: trajectoryTags,
          }
        );
      }
      setSelected(narrId);
      setInput({ title: '', sketch: '' });
      return;
    }
    // FHIR branch (from Narrative)
    const srcId = fhirSourceId;
    if (!srcId) {
      alert('Select a Narrative to convert, or use Paste Text');
      return;
    }
    const arts = await stores.artifacts.listByJob(srcId, (a) => a.kind === 'ReleaseCandidate');
    const latest = arts.sort((a, b) => b.version - a.version)[0];
    if (!latest?.content) {
      alert('Selected Narrative has no ReleaseCandidate');
      return;
    }
    const sourceJob = doneNarratives.find((d) => d.id === srcId);
    const sourceTitle = sourceJob?.title || '';
    const trajectoryTags = sourceJob?.tags?.trajectoryParentId != null ?
      {
        trajectoryParentId: (sourceJob as any).tags.trajectoryParentId,
        trajectoryEpisodeNumber: (sourceJob as any).tags.trajectoryEpisodeNumber,
        trajectoryDateOffset: (sourceJob as any).tags.trajectoryDateOffset,
      }
    : undefined;
    const inputs: FhirInputs = {
      noteText: latest.content as string,
      source: { jobId: srcId as ID, artifactId: latest.id as ID, title: sourceTitle },
    };
    const docTitle = sourceTitle ? `FHIR: ${sourceTitle}` : 'FHIR Bundle';
    const docId = await createJob(stores, 'fhir', inputs, docTitle, {
      dependsOn: [srcId as ID],
      tags: trajectoryTags,
    });
    setSelected(docId);
    setFhirSourceId('');
  };

  return (
    <div className="h-screen flex flex-col bg-warm-paper">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 flex-shrink-0">
        <div className="px-6 py-3 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <img src={BRAND.logo} alt={`${BRAND.name} logo`} className="h-12 w-12" />
            <h1 className="text-3xl font-bold text-text-charcoal tracking-tight">{BRAND.name}</h1>
          </div>

          <div className="flex items-center gap-3 flex-1">
            <select
              className="input-kiln input-kiln-inline"
              value={docType}
              onChange={(e) => setDocType(e.target.value as DocumentType)}
            >
              <option value="narrative">Narrative</option>
              <option value="trajectory">Trajectory</option>
              <option value="fhir">FHIR</option>
            </select>
            {docType === 'narrative' && (
              <>
                <input
                  className="flex-1 input-kiln"
                  placeholder="Describe your patient sketch (e.g., '52F with chest pain')"
                  value={input.sketch}
                  onChange={(e) => setInput((prev) => ({ ...prev, sketch: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && createFromHeader()}
                />
                <label className="flex items-center gap-2 text-sm text-gray-700 shrink-0 whitespace-nowrap">
                  <input type="checkbox" checked={alsoFhir} onChange={(e) => setAlsoFhir(e.target.checked)} />
                  Also generate FHIR Bundle
                </label>
                <button className="btn-kiln" onClick={createFromHeader}>
                  Start
                </button>
              </>
            )}
            {docType === 'trajectory' && (
              <>
                <button
                  className="btn-kiln"
                  onClick={() => {
                    setInitialInputs({});
                    setModalOpen(true);
                  }}
                >
                  Plan Trajectory…
                </button>
                <span className="text-sm text-gray-600">
                  Provide a longitudinal sketch to spawn sequential episode notes.
                </span>
              </>
            )}
            {docType === 'fhir' && (
              <>
                <select
                  className="input-kiln flex-1"
                  value={fhirSourceId}
                  onChange={(e) => setFhirSourceId(e.target.value)}
                >
                  <option value="">Select Narrative (done)…</option>
                  {doneNarratives.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                    </option>
                  ))}
                </select>
                <button className="btn-kiln" disabled={!fhirSourceId} onClick={createFromHeader}>
                  Create
                </button>
                <button
                  className="btn-kiln-outline"
                  onClick={() => {
                    setInitialInputs({});
                    setDocType('fhir');
                    setModalOpen(true);
                  }}
                >
                  Paste Text…
                </button>
              </>
            )}
          </div>

          <button
            className="p-2 hover:bg-gray-100 rounded-soft transition-colors"
            onClick={() => setConfigOpen(true)}
            aria-label="Settings"
            title="Settings"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-gray-600"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v6m0 6v6m3.22-10.22l4.24-4.24M5.54 5.54l4.24 4.24m8.44 0l4.24 4.24M5.54 18.46l4.24-4.24M23 12h-6m-6 0H1" />
            </svg>
          </button>
        </div>
      </header>

      <div className="flex flex-1">
        {/* Sidebar - Jobs List - Only show if there are jobs */}
        {docList.length > 0 && (
          <div className="w-96 sidebar-kiln flex flex-col">
            <div className="p-4 border-b border-gray-200">
              <h2 className="font-semibold text-text-charcoal">Jobs</h2>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              <JobsList jobs={docList} selected={selected} onSelect={setSelected} onDelete={handleDeleteJob} />
            </div>
          </div>
        )}

        {/* Main Content */}
        <div className="flex-1 flex flex-col">
          {/* Top Bar removed; creation moved to header */}

          {/* Dashboard */}
          <div className="flex-1 overflow-auto content-kiln">
            <DocGenDashboard
              state={dashboardState}
              hasJobs={docList.length > 0}
              onOpenArtifact={openArtifact}
              onRerun={async () => {
                if (!stores || !selected) return;
                await rerunJob(stores, selected);
              }}
              canConvertToFhir={!!canConvertToFhir}
              onConvertToFhir={() => convertSelectedToFhir()}
              onClearCache={async (opts?: { all?: boolean; phase?: string; type?: string }) => {
                if (!stores || !selected) return;
                // Clear cache by all/phase/type without clearing artifacts
                const filter = (s: any) => {
                  if (!opts || opts.all) return true;
                  if (opts.phase) {
                    try {
                      const t = s.tagsJson ? JSON.parse(s.tagsJson) : {};
                      return String(t.phase || '') === String(opts.phase);
                    } catch {
                      return false;
                    }
                  }
                  if (opts.type) {
                    try {
                      return String(s.key || '').startsWith(`${opts.type}:`);
                    } catch {
                      return false;
                    }
                  }
                  return true;
                };
                const cleared = await clearJobCacheAPI(stores, selected, filter);
                if (!cleared) {
                  alert('No cached steps found for this selection.');
                  return;
                }
                try {
                  await startJobApi(stores, selected);
                } catch (e) {
                  console.error('Start after clear failed', e);
                }
              }}
              onOpenFailed={openLatestFailedStep}
            />
          </div>
        </div>
      </div>

      {/* Modals */}
      {configOpen && <ConfigModal config={cfg} onSave={saveConfig} onClose={() => setConfigOpen(false)} />}

      {viewArtifactId && stores && selected && (
        <ArtifactDetails
          stores={stores}
          jobId={selected}
          artifactId={viewArtifactId}
          onClose={() => setViewArtifactId(null)}
          onOpenArtifact={openArtifact}
        />
      )}

      {failedStep && <StepDetails step={failedStep} onClose={() => setFailedStep(null)} />}

      {modalOpen && stores && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded-lg shadow-xl max-w-md w-full">
            <h2 className="text-lg font-semibold mb-3">Create New Job</h2>
            <div className="mb-3">
              <label className="block text-sm font-medium mb-1">Type</label>
              <select
                className="input-kiln w-full"
                value={docType}
                onChange={(e) => setDocType(e.target.value as DocumentType)}
              >
                <option value="narrative">Narrative Note</option>
                <option value="trajectory">Trajectory</option>
                <option value="fhir">FHIR Bundle</option>
              </select>
            </div>
            {(() => {
              const def = registry.get<any>(docType);
              const InputComp = def?.InputComponent as
                | React.FC<{
                    stores?: Stores;
                    initialInputs?: Partial<any>;
                    onSubmit: (i: any) => void;
                    onCancel: () => void;
                  }>
                | undefined;
              if (!InputComp)
                return <div className="text-sm text-red-600">No input form registered for {docType}.</div>;
              return (
                <InputComp
                  stores={stores}
                  initialInputs={initialInputs as any}
                  onCancel={() => {
                    setModalOpen(false);
                    setInitialInputs({});
                  }}
                  onSubmit={async (typedInputs: any) => {
                    try {
                      const def = registry.get<any>(docType as any);
                      const customTitle: string | undefined = def?.getTitle?.(typedInputs) as string | undefined;
                      const title =
                        customTitle ||
                        (docType === 'narrative' ?
                          `Patient: ${(typedInputs.sketch || '').slice(0, 30)}...`
                        : docType === 'trajectory' ?
                          `Trajectory: ${(typedInputs.trajectorySketch || '').slice(0, 40)}...`
                        : 'FHIR Bundle');
                      const options: { dependsOn?: ID[]; tags?: Record<string, any> } = {};
                      if (docType === 'fhir' && typedInputs?.source?.jobId) {
                        options.dependsOn = [typedInputs.source.jobId as ID];
                        try {
                          const sourceJob = await stores.jobs.get(typedInputs.source.jobId as ID);
                          const tags = (sourceJob as any)?.tags || {};
                          if (tags?.trajectoryParentId != null) {
                            options.tags = {
                              trajectoryParentId: tags.trajectoryParentId,
                              trajectoryEpisodeNumber: tags.trajectoryEpisodeNumber,
                              trajectoryDateOffset: tags.trajectoryDateOffset,
                            };
                          }
                        } catch {}
                      }
                      const jobId = await createJob(stores, docType as any, typedInputs as any, title, options);
                      void startJobApi(stores, jobId).catch((err) => console.error('start job failed', err));
                      setSelected(jobId);
                    } catch (e) {
                      console.error(e);
                    }
                    setModalOpen(false);
                    setInitialInputs({});
                  }}
                />
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
