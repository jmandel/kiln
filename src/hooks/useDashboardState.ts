import * as React from 'react';
import type { ID, Job } from '../types';
import type { DashboardStore } from '../dashboardStore';
import type { DashboardView } from '../dashboardStore';

const EMPTY_STATE: DashboardView = {
  jobId: '',
  title: 'No job selected',
  status: 'queued',
  metrics: { stepCounts: {}, totalTokens: 0, elapsedMs: 0 },
  artifacts: [],
  events: [],
  phases: [],
  stepTypes: [],
};

const EMPTY_JOBS: Job[] = [];

// Singleton DashboardStore per app lifecycle
let singleton: DashboardStore | null = null;
function getStore(stores: Stores | null): DashboardStore | null {
  if (!stores) return null;
  if (!singleton) singleton = new DashboardStore(stores);
  return singleton;
}

export function useDashboardState(store: DashboardStore | null, jobId: ID | null): DashboardView {
  React.useEffect(() => {
    if (!store || !jobId) return;
    store.select(jobId);
  }, [store, jobId]);

  return React.useSyncExternalStore(
    (cb) => (store && jobId ? store.subscribe(jobId, cb) : () => {}),
    () => (store && jobId ? store.getState(jobId) : EMPTY_STATE),
    () => EMPTY_STATE
  );
}

export function useJobsList(store: DashboardStore | null): Job[] {
  return React.useSyncExternalStore(
    (cb) => (store ? store.subscribeToJobs(cb) : () => {}),
    () => (store ? store.getJobs() : EMPTY_JOBS),
    () => EMPTY_JOBS
  );
}
