import React, { useEffect, useState } from 'react';
import { 
  Card, 
  Badge, 
  StatusBadge, 
  MetricPill, 
  EmptyState, 
  ErrorBanner,
  ViewToggle 
} from './ui/index';
import { ArtifactsTable, ArtifactsGrid, ArtifactsTimeline } from './ui/ArtifactsTable';
import { EventsList } from './ui/EventsList';
import { PhaseProgress } from './ui/PhaseProgress';
import { formatDuration, getTotalSteps } from './ui/utils';

type Artifact = {
  id: string;
  name: string;
  kind: 'draft' | 'outline' | 'assets' | 'review' | 'final' | string;
  status: 'queued' | 'running' | 'done' | 'error';
  href?: string;
  size?: string;
  notes?: string;
  createdAt?: string;
  phase?: string;
};

type DocGenEvent = { ts: string; level: 'info' | 'warn' | 'error'; msg: string };

type Metrics = {
  stepCounts: Record<string, number>;
  totalTokens: number;
  elapsedMs: number;
};

type PhaseInfo = { id: string; label: string; done: number; total: number; pct: number };

type DocGenState = {
  jobId: string;
  title: string;
  status: 'queued' | 'running' | 'done' | 'error';
  currentPhase?: string;
  jobStartTime?: string;
  metrics: Metrics;
  artifacts: Artifact[];
  events: DocGenEvent[];
  error?: string;
  phases?: PhaseInfo[];
  featured?: Artifact[];
};

const defaultState: DocGenState = {
  jobId: '',
  title: 'No job selected',
  status: 'queued',
  metrics: { stepCounts: {}, totalTokens: 0, elapsedMs: 0 },
  artifacts: [],
  events: []
};

export default function DocGenDashboard({ 
  state: controlled,
  initial = defaultState, 
  onOpenArtifact, 
  onResume 
}: { 
  state?: DocGenState;
  initial?: DocGenState; 
  onOpenArtifact?: (id: string) => void; 
  onResume?: () => void 
}) {
  const [internalState, setInternalState] = useState<DocGenState>(initial);
  const state = controlled ?? internalState;
  const setState = controlled ? () => {} : setInternalState;
  
  const [artifactView, setArtifactView] = useState<'table' | 'cards' | 'timeline'>('table');
  const [eventsPanelOpen, setEventsPanelOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // Auto-open events panel when new errors occur
  useEffect(() => {
    const hasErrors = state.events.some(e => e.level === 'error');
    if (hasErrors && !eventsPanelOpen) setEventsPanelOpen(true);
  }, [state.events]);

  // Update clock for running jobs
  useEffect(() => {
    if (state.status === 'running') {
      const timerId = setInterval(() => setNow(new Date()), 1000);
      return () => clearInterval(timerId);
    }
  }, [state.status]);

  // API bridge (legacy, only when uncontrolled)
  useEffect(() => {
    if (controlled) return;
    const api = {
      push(partial: Partial<DocGenState>) {
        setState(prev => {
          const next: DocGenState = { ...prev, ...partial } as DocGenState;
          if (partial?.events?.length) {
            next.events = [...prev.events, ...partial.events].slice(-50);
          }
          if (partial?.artifacts?.length) {
            const map = new Map<string, Artifact>(prev.artifacts.map(a => [a.id, a]));
            for (const a of partial.artifacts) {
              map.set(a.id, { ...(map.get(a.id) as Artifact), ...a });
            }
            next.artifacts = Array.from(map.values());
          }
          if (partial.metrics) {
            next.metrics = partial.metrics;
          }
          return next;
        });
      },
      set(full: DocGenState) {
        setState(full);
      },
      get() { return state; }
    };
    (window as any).docGen = api;
  }, [state, controlled]);

  const hasContent = state.jobId && state.artifacts.length > 0;
  const isRunning = state.status === 'running';

  const elapsedMs = (isRunning && state.jobStartTime)
    ? now.getTime() - new Date(state.jobStartTime).getTime()
    : state.metrics.elapsedMs;
  
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Sticky Header */}
      <div className="sticky top-0 z-20 bg-white border-b border-gray-200 backdrop-blur-sm bg-white/95">
        <div className="max-w-7xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold">{state.title || 'No job selected'}</h1>
              <div className="flex items-center gap-4 mt-1">
                <StatusBadge status={state.status} />
                {state.currentPhase && (
                  <span className="text-sm text-gray-600">
                    Phase: {state.currentPhase}
                  </span>
                )}
                {state.jobId && (
                  <span className="text-xs text-gray-400">
                    ID: {state.jobId.slice(0, 12)}...
                  </span>
                )}
              </div>
            </div>
            
            {/* Compact metrics bar */}
            <div className="flex items-center gap-6 text-sm">
              <MetricPill 
                label="Time" 
                value={formatDuration(elapsedMs)}
                icon="⏱" 
              />
              <MetricPill 
                label="Steps" 
                value={state.metrics.stepCounts.done || 0}
                total={getTotalSteps(state.metrics.stepCounts)}
                icon="📊" 
              />
              <MetricPill 
                label="Tokens" 
                value={`${(state.metrics.totalTokens / 1000).toFixed(1)}k`}
                icon="🔤" 
              />
              {state.jobId && onResume && (
                <button 
                  className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                  onClick={onResume}
                >
                  Resume
                </button>
              )}
            </div>
          </div>
          
          {/* Progress bar */}
          {isRunning && state.phases && state.phases.length > 0 && (
            <div className="mt-3">
              <PhaseProgress phases={state.phases} compact />
            </div>
          )}
        </div>
      </div>

      {/* Error Banner (if present) */}
      {state.error && (
        <div className="max-w-7xl mx-auto px-4 mt-4">
          <ErrorBanner error={state.error} onResume={onResume} />
        </div>
      )}

      {/* Main Content Area */}
      <div className="max-w-7xl mx-auto px-4 py-6">
        {!state.jobId ? (
          <EmptyState />
        ) : (
          <div className="flex gap-6">
            {/* Primary Content */}
            <div className="flex-1 min-w-0">
              <Card className="p-4">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-medium">Artifacts</h2>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-500">
                      {state.artifacts.length} items
                    </span>
                    <ViewToggle 
                      views={['table', 'cards', 'timeline']} 
                      active={artifactView}
                      onChange={setArtifactView}
                    />
                  </div>
                </div>
                
                {state.artifacts.length === 0 ? (
                  <div className="text-sm text-gray-500 text-center py-8">
                    No artifacts generated yet.
                  </div>
                ) : (
                  <>
                    {artifactView === 'table' && (
                      <ArtifactsTable 
                        items={state.artifacts} 
                        onOpen={onOpenArtifact || (() => {})}
                      />
                    )}
                    {artifactView === 'cards' && (
                      <ArtifactsGrid 
                        items={state.artifacts} 
                        onOpen={onOpenArtifact || (() => {})}
                      />
                    )}
                    {artifactView === 'timeline' && (
                      <ArtifactsTimeline 
                        items={state.artifacts} 
                        onOpen={onOpenArtifact || (() => {})}
                      />
                    )}
                  </>
                )}
              </Card>

              {/* Phase progress cards (when not running) */}
              {!isRunning && state.phases && state.phases.length > 0 && (
                <Card className="p-4 mt-4">
                  <h3 className="text-lg font-medium mb-3">Phase Progress</h3>
                  <PhaseProgress phases={state.phases} />
                </Card>
              )}
            </div>

            {/* Collapsible Events Sidebar */}
            <div className={`transition-all duration-300 ${
              eventsPanelOpen ? 'w-96' : 'w-12'
            }`}>
              {eventsPanelOpen ? (
                <Card className="p-4 h-full max-h-[600px] overflow-hidden flex flex-col">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-medium">Recent Events</h3>
                    <button 
                      onClick={() => setEventsPanelOpen(false)}
                      className="text-gray-400 hover:text-gray-600 text-lg leading-none"
                      aria-label="Close events panel"
                    >
                      ×
                    </button>
                  </div>
                  <EventsList events={state.events} className="flex-1 overflow-auto" />
                </Card>
              ) : (
                <button
                  onClick={() => setEventsPanelOpen(true)}
                  className="w-12 h-32 bg-white border border-gray-200 rounded-lg flex flex-col items-center justify-center hover:bg-gray-50 relative"
                  aria-label="Open events panel"
                >
                  <span className="text-xs text-gray-500 -rotate-90 whitespace-nowrap">
                    Events
                  </span>
                  {state.events.some(e => e.level === 'error') && (
                    <div className="absolute top-2 right-2 w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                  )}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
