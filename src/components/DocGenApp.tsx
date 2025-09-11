import React, { useEffect, useMemo, useState } from 'react';
import { createStores } from '../stores.adapter';
import type { Stores, ID, Document, Step } from '../types';
import DocGenDashboard from './DocGenDashboard';
import ArtifactDetails from './ArtifactDetails';
import StepDetails from './StepDetails';
import { escapeHtml, pretty, tryJson } from './ui';
import { runDocumentWorkflow, resume, resumeDocument } from '../workflows';
import { sha256 } from '../helpers';
import { useDashboardState } from '../hooks/useDashboardState';
import { JobsList } from './ui/JobsList';
import CodingResolverTester from './CodingResolverTester';

function mapDocStatus(s: Document['status']): 'queued' | 'running' | 'done' | 'error' {
  if (s === 'running') return 'running';
  if (s === 'done') return 'done';
  return 'error';
}

function guessKind(kind: string): 'draft'|'outline'|'assets'|'review'|'final'|string {
  const k = kind.toLowerCase();
  if (k.includes('outline')) return 'outline';
  if (k.includes('draft')) return 'draft';
  if (k.includes('note')) return 'final';
  if (k.includes('asset')) return 'assets';
  if (k.includes('review')) return 'review';
  return k;
}

// Removed legacy HTML artifact viewer and dashboard projector

// Configuration Modal Component
function ConfigModal({ config, onSave, onClose }: { 
  config: any; 
  onSave: (cfg: any) => void; 
  onClose: () => void 
}) {
  const [cfg, setCfg] = useState(config);
  
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-md">
        <h2 className="text-lg font-semibold mb-4">API Configuration</h2>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Base URL</label>
            <input 
              className="w-full border border-gray-300 rounded px-3 py-2"
              value={cfg.baseURL}
              onChange={e => setCfg({...cfg, baseURL: e.target.value})}
              placeholder="https://openrouter.ai/api/v1"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
            <input 
              className="w-full border border-gray-300 rounded px-3 py-2"
              type="password"
              value={cfg.apiKey}
              onChange={e => setCfg({...cfg, apiKey: e.target.value})}
              placeholder="sk-..."
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
            <input 
              className="w-full border border-gray-300 rounded px-3 py-2"
              value={cfg.model}
              onChange={e => setCfg({...cfg, model: e.target.value})}
              placeholder="openai/gpt-4"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Temperature</label>
            <input 
              className="w-full border border-gray-300 rounded px-3 py-2"
              value={cfg.temperature}
              onChange={e => setCfg({...cfg, temperature: e.target.value})}
              placeholder="0.7"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">FHIR Base URL</label>
            <input 
              className="w-full border border-gray-300 rounded px-3 py-2"
              value={cfg.fhirBaseURL}
              onChange={e => setCfg({...cfg, fhirBaseURL: e.target.value})}
              placeholder="https://kiln.fhir.me"
            />
            <p className="text-xs text-gray-500 mt-1">Used for Bundle.entry.fullUrl. Relative references like "Observation/abc" will resolve to <code>FHIR Base URL</code>/Observation/abc.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">FHIR Validator URL</label>
            <input 
              className="w-full border border-gray-300 rounded px-3 py-2"
              value={cfg.fhirValidatorURL}
              onChange={e => setCfg({...cfg, fhirValidatorURL: e.target.value})}
              placeholder="Leave blank for same-origin (e.g., http://localhost:3500)"
            />
            <p className="text-xs text-gray-500 mt-1">Base used for validation. Leave blank to use the current server origin at <code>/validate</code>.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">FHIR Generation Concurrency</label>
            <input 
              className="w-full border border-gray-300 rounded px-3 py-2"
              type="number"
              min={1}
              value={cfg.fhirGenConcurrency}
              onChange={e => setCfg({...cfg, fhirGenConcurrency: e.target.value})}
              placeholder="1"
            />
            <p className="text-xs text-gray-500 mt-1">How many FHIR resources to generate/refine in parallel. 1 = sequential (grouped artifacts).</p>
          </div>
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <button 
            className="px-4 py-2 text-gray-600 hover:text-gray-800"
            onClick={onClose}
          >
            Cancel
          </button>
          <button 
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
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
  const [docs, setDocs] = useState<Document[]>([]);
  const [selected, setSelected] = useState<ID | null>(null);
  const [input, setInput] = useState({ title: '', sketch: '' });
  const [configOpen, setConfigOpen] = useState(false);
  const [showTester, setShowTester] = useState(false);
  const [viewArtifactId, setViewArtifactId] = useState<ID | null>(null);
  const [failedStep, setFailedStep] = useState<Step | null>(null);
  const urlCache = React.useRef<Map<string,string>>(new Map());
  const [cfg, setCfg] = useState({
    baseURL: localStorage.getItem('TASK_DEFAULT_BASE_URL') || 'https://openrouter.ai/api/v1',
    apiKey: localStorage.getItem('TASK_DEFAULT_API_KEY') || '',
    model: localStorage.getItem('TASK_DEFAULT_MODEL') || 'openai/gpt-oss-120b:nitro',
    temperature: localStorage.getItem('TASK_DEFAULT_TEMPERATURE') || '0.2',
    fhirBaseURL: localStorage.getItem('FHIR_BASE_URL') || 'https://kiln.fhir.me',
    fhirValidatorURL: localStorage.getItem('FHIR_VALIDATOR_BASE_URL') || localStorage.getItem('VALIDATOR_URL') || '',
    fhirGenConcurrency: localStorage.getItem('FHIR_GEN_CONCURRENCY') || '1'
  });

  useEffect(() => {
    let mounted = true;
    (async () => {
      const s = await createStores();
      if (!mounted) return;
      setStores(s);
      setDocs(await s.documents.all());
    })();
    return () => { mounted = false; };
  }, []);

  
  useEffect(() => {
    if (!stores) return;
    (async () => setDocs(await stores.documents.all()))();
    const unsub = stores.events.subscribe(async (ev: any) => {
      if (ev.type === 'document_created' || ev.type === 'document_deleted' || ev.type === 'document_status') {
        setDocs(await stores.documents.all());
      }
    });
    return () => unsub();
  }, [stores]);


  // Ensure dashboard starts empty on first load (no placeholders)
  useEffect(() => {
    if ((window as any).docGen?.set) {
      (window as any).docGen.set({ jobId: '', title: 'No job selected', status: 'queued', metrics: { stepCounts: {}, totalTokens: 0, elapsedMs: 0 }, artifacts: [], events: [] });
    }
  }, []);

  // Dashboard state is driven by an external store hook now

  const startJob = async () => {
    if (!stores || !input.sketch) return alert('Enter a patient sketch');
    const title = input.title || `Patient: ${input.sketch.slice(0, 30)}...`;
    const docId = `doc:${await sha256(title + ':' + input.sketch)}`;
    await stores.documents.create(docId as any, title, input.sketch);
    setSelected(docId);
    runDocumentWorkflow(stores, { title, sketch: input.sketch }).catch(console.error);
    setInput({ title: '', sketch: '' });
  };

  const handleDeleteJob = async (docId: ID) => {
    if (!stores) return;
    if (!confirm('Delete this document and all associated data?')) return;
    await stores.documents.delete(docId);
    await stores.workflows.deleteByDocument(docId);
    await stores.artifacts.deleteByDocument(docId);
    await stores.steps.deleteByDocument(docId);
    await stores.links.deleteByDocument(docId);
    const remaining = await stores.documents.all();
    setDocs(remaining);
    if (selected === docId) {
      setSelected(remaining[0]?.id || null);
      if (!remaining[0]) {
        (window as any).docGen?.set && (window as any).docGen.set({
          jobId: '', title: 'No job selected', status: 'queued', metrics: { stepCounts: {}, totalTokens: 0, elapsedMs: 0 }, artifacts: [], events: []
        });
      }
    }
  };

  const clearTerminologyCache = async () => {
    if (!stores || !selected) return alert('Select a job first');
    const steps = await stores.steps.listByDocument(selected);
    const isTerminologyStep = (s: Step): boolean => {
      try {
        const tags = s.tagsJson ? JSON.parse(s.tagsJson) : {};
        const phase = tags.phase || '';
        const modelTask = tags.modelTask || '';
        return (
          phase === 'terminology' ||
          modelTask === 'terminology_picker' ||
          modelTask === 'terminology_approximator' ||
          s.key.startsWith('resolve_code_')
        );
      } catch {
        return s.key.startsWith('resolve_code_');
      }
    };
    const targets = steps.filter(s => isTerminologyStep(s) && s.status !== 'pending');
    if (targets.length === 0) {
      alert('No cached terminology steps found for this job.');
      return;
    }
    for (const s of targets) {
      await stores.steps.put({
        ...s,
        status: 'pending',
        error: null,
        resultJson: '',
        progress: 0,
        ts: new Date().toISOString()
      });
    }
    // Mark owning workflows as resumable
    const wfIds = Array.from(new Set(targets.map(s => s.workflowId)));
    for (const wfId of wfIds) await stores.workflows.setStatus(wfId as any, 'pending');
    // Auto-resume
    await resumeDocument(stores, selected);
  };

  const clearFhirAndTerminologyCache = async () => {
    if (!stores || !selected) return alert('Select a job first');
    const steps = await stores.steps.listByDocument(selected);
    const isTarget = (s: Step): boolean => {
      try {
        const tags = s.tagsJson ? JSON.parse(s.tagsJson) : {};
        const phase = tags.phase || '';
        const task = (tags.modelTask || '') as string;
        return (
          phase === 'terminology' ||
          phase === 'fhir' ||
          s.key.startsWith('resolve_code_') ||
          task === 'terminology_picker' ||
          task === 'terminology_approximator' ||
          task === 'fhir_composition_plan' ||
          task === 'fhir_generate_resource'
        );
      } catch {
        return s.key.startsWith('resolve_code_');
      }
    };
    const targets = steps.filter(s => isTarget(s) && s.status !== 'pending');
    if (targets.length === 0) {
      alert('No cached FHIR/terminology steps found for this job.');
      return;
    }
    for (const s of targets) {
      await stores.steps.put({
        ...s,
        status: 'pending',
        error: null,
        resultJson: '',
        progress: 0,
        ts: new Date().toISOString()
      });
    }
    const wfIds = Array.from(new Set(targets.map(s => s.workflowId)));
    for (const wfId of wfIds) await stores.workflows.setStatus(wfId as any, 'pending');
    await resumeDocument(stores, selected);
  };

  const saveConfig = (newCfg: typeof cfg) => {
    localStorage.setItem('TASK_DEFAULT_BASE_URL', newCfg.baseURL);
    localStorage.setItem('TASK_DEFAULT_API_KEY', newCfg.apiKey);
    localStorage.setItem('TASK_DEFAULT_MODEL', newCfg.model);
    localStorage.setItem('TASK_DEFAULT_TEMPERATURE', newCfg.temperature);
    localStorage.setItem('FHIR_BASE_URL', newCfg.fhirBaseURL);
    localStorage.setItem('FHIR_VALIDATOR_BASE_URL', newCfg.fhirValidatorURL);
    localStorage.setItem('FHIR_GEN_CONCURRENCY', String(newCfg.fhirGenConcurrency || '1'));
    setCfg(newCfg);
  };

  const handleRerun = async () => {
    if (!stores || !selected) return;
    // Clear current artifacts/links so new outputs appear cleanly while resume starts
    await stores.artifacts.deleteByDocument(selected);
    await stores.links.deleteByDocument(selected);
    await resumeDocument(stores, selected);
  };

  // Generic: clear ALL step cache for this document, then resume (no workflow-specific knowledge)
  const clearAllStepCache = async () => {
    if (!stores || !selected) return alert('Select a job first');
    const steps = await stores.steps.listByDocument(selected);
    const targets = steps.filter(s => s.status !== 'pending');
    if (targets.length === 0) {
      alert('No cached steps found for this job.');
      return;
    }
    for (const s of targets) {
      await stores.steps.put({
        ...s,
        status: 'pending',
        error: null,
        resultJson: '',
        progress: 0,
        ts: new Date().toISOString()
      });
    }
    const wfIds = Array.from(new Set(targets.map(s => s.workflowId)));
    for (const wfId of wfIds) await stores.workflows.setStatus(wfId as any, 'pending');
    await stores.artifacts.deleteByDocument(selected);
    await stores.links.deleteByDocument(selected);
    await resumeDocument(stores, selected);
  };

  const openLatestFailedStep = async () => {
    if (!stores || !selected) return;
    const list = await stores.steps.listByDocument(selected);
    const failed = list.filter(s => s.status === 'failed').sort((a,b) => b.ts.localeCompare(a.ts))[0];
    if (failed) setFailedStep(failed);
    else alert('No failed step found for this job.');
  };

  const docList = useMemo(() => docs, [docs]);
  const dashboardState = useDashboardState(stores, selected);

  // URL routing via query params
  React.useEffect(() => {
    const apply = () => {
      const sp = new URLSearchParams(window.location.search);
      const doc = sp.get('doc');
      const art = sp.get('artifact');
      if (doc) setSelected(doc);
      setViewArtifactId(art);
    };
    window.addEventListener('popstate', apply);
    apply();
    return () => window.removeEventListener('popstate', apply);
  }, []);

  const openArtifact = (id: ID) => {
    const sp = new URLSearchParams();
    if (selected) sp.set('doc', selected);
    sp.set('artifact', id);
    const url = `${window.location.pathname}?${sp.toString()}`;
    window.open(url, '_blank', 'noopener');
  };

  // Full-page artifact viewer mode
  if (stores && new URLSearchParams(window.location.search).get('artifact')) {
    const sp = new URLSearchParams(window.location.search);
    const docId = (sp.get('doc') as ID) || selected || (docs[0]?.id as ID);
    const artId = sp.get('artifact') as ID;
    if (!docId || !artId) return <div className="p-6">Loading…</div>;
    return (
      <ArtifactDetails stores={stores} documentId={docId} artifactId={artId} onClose={()=>{ if (window.history.length>1) history.back(); else window.close(); }} onOpenArtifact={(id)=>{
        const q = new URLSearchParams(window.location.search);
        if (docId) q.set('doc', docId);
        q.set('artifact', id);
        history.pushState(null, '', `?${q.toString()}`);
        setViewArtifactId(id);
      }} fullPage />
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="flex h-screen">
        {/* Sidebar - Jobs List */}
        <div className="w-64 bg-white border-r border-gray-200 flex flex-col">
          <div className="p-4 border-b border-gray-200">
            <h2 className="font-semibold">Jobs</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            <JobsList 
              jobs={docList}
              selected={selected}
              onSelect={setSelected}
              onDelete={handleDeleteJob}
            />
          </div>
        </div>

        {/* Main Content */}
        <div className="flex-1 flex flex-col">
          {/* Top Bar */}
          <div className="bg-white border-b border-gray-200 p-4">
            <div className="flex items-center gap-4">
              <input
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Patient sketch (e.g., 52F with chest pain)"
                value={input.sketch}
                onChange={e => setInput(prev => ({ ...prev, sketch: e.target.value }))}
                onKeyDown={e => e.key === 'Enter' && startJob()}
              />
              <button
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors flex items-center gap-2"
                onClick={startJob}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
                Create Job
              </button>
              
              {/* Settings Dropdown */}
              <div className="relative">
                <button
                  className="p-2 hover:bg-gray-100 rounded-md"
                  onClick={() => setConfigOpen(true)}
                  aria-label="Settings"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="3"/>
                    <path d="M12 1v6m0 6v6m10.392-6.5l-5.196 3m-10.392 0l-5.196-3m15.588 0l-5.196-3m-10.392 0l5.196-3"/>
                  </svg>
                </button>
                <button
                  className="ml-2 px-3 py-2 text-sm border rounded hover:bg-gray-50"
                  onClick={() => setShowTester(true)}
                  title="Open Coding Resolver Tester"
                >
                  🧪 Coding Tester
                </button>
              </div>
            </div>
            
            {/* Quick Actions removed — use metadata-driven cache controls near Rerun */}
          </div>

          {/* Dashboard */}
          <div className="flex-1 overflow-auto">
          <DocGenDashboard 
            state={dashboardState}
            onOpenArtifact={openArtifact}
            onRerun={handleRerun}
            onClearCache={async (phaseId?: string) => {
              if (!stores || !selected) return;
              const steps = await stores.steps.listByDocument(selected);
              const targets = steps.filter(s => {
                if (s.status === 'pending') return false;
                if (!phaseId) return true;
                try { const t = s.tagsJson ? JSON.parse(s.tagsJson) : {}; return String(t.phase || '') === String(phaseId); } catch { return false; }
              });
              if (targets.length === 0) { alert('No cached steps found for this selection.'); return; }
              for (const s of targets) {
                await stores.steps.put({ ...s, status: 'pending', error: null, resultJson: '', progress: 0, ts: new Date().toISOString() });
              }
              const wfIds = Array.from(new Set(targets.map(s => s.workflowId)));
              for (const wfId of wfIds) await stores.workflows.setStatus(wfId as any, 'pending');
              await stores.artifacts.deleteByDocument(selected);
              await stores.links.deleteByDocument(selected);
              await resumeDocument(stores, selected);
            }}
            onOpenFailed={openLatestFailedStep}
          />
          </div>
        </div>
      </div>

      {/* Modals */}
      {configOpen && (
        <ConfigModal 
          config={cfg}
          onSave={saveConfig}
          onClose={() => setConfigOpen(false)}
        />
      )}
      {showTester && (
        <CodingResolverTester onClose={() => setShowTester(false)} />
      )}
      
      {viewArtifactId && stores && selected && (
        <ArtifactDetails 
          stores={stores} 
          documentId={selected} 
          artifactId={viewArtifactId} 
          onClose={() => setViewArtifactId(null)} 
          onOpenArtifact={openArtifact} 
        />
      )}

      {failedStep && (
        <StepDetails step={failedStep} onClose={() => setFailedStep(null)} />
      )}
    </div>
  );
}
