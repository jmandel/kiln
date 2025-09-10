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

export function useDashboardState(stores: Stores | null, documentId: ID | null): DashboardView {
  const storeRef = React.useRef<DashboardStore | null>(null);

  if (stores && !storeRef.current) {
    storeRef.current = new DashboardStore(stores);
  }

  React.useEffect(() => {
    if (!storeRef.current || !documentId) return;
    storeRef.current.select(documentId);
  }, [documentId]);

  return React.useSyncExternalStore(
    (cb) => (storeRef.current && documentId) ? storeRef.current.subscribe(documentId, cb) : () => {},
    () => (storeRef.current && documentId) ? storeRef.current.getState(documentId) : EMPTY_STATE,
    () => EMPTY_STATE
  );
}

