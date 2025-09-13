import * as React from 'react';
import type { Stores, ID } from '../types';
import { DashboardStore, type DashboardView } from '../dashboardStore';

const EMPTY_STATE: DashboardView = {
  jobId: '',
  title: 'No job selected',
  status: 'queued',
  metrics: { stepCounts: {}, totalTokens: 0, elapsedMs: 0 },
  artifacts: [],
  events: [],
  phases: []
};

export function useDashboardState(stores: Stores | null, jobId: ID | null): DashboardView {
  const storeRef = React.useRef<DashboardStore | null>(null);

  if (stores && !storeRef.current) {
    storeRef.current = new DashboardStore(stores);
  }

  React.useEffect(() => {
    if (!storeRef.current || !jobId) return;
    storeRef.current.select(jobId);
  }, [jobId]);

  return React.useSyncExternalStore(
    (cb) => (storeRef.current && jobId) ? storeRef.current.subscribe(jobId, cb) : () => {},
    () => (storeRef.current && jobId) ? storeRef.current.getState(jobId) : EMPTY_STATE,
    () => EMPTY_STATE
  );
}
