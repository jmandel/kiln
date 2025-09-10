export const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
};

export const formatTime = (iso: string): string => {
  const date = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return date.toLocaleDateString();
};

export const getVariantForKind = (kind: string): string => {
  const map: Record<string, string> = {
    'outline': 'info',
    'draft': 'default',
    'final': 'success',
    'error': 'error',
    'fhir': 'warning',
    'assets': 'info',
    'review': 'warning'
  };
  return map[kind.toLowerCase()] || 'default';
};

export const getTotalSteps = (stepCounts: Record<string, number>): number => {
  const done = stepCounts.done || 0;
  const running = stepCounts.running || 0;
  const pending = stepCounts.pending || 0;
  const failed = stepCounts.failed || 0;
  return done + running + pending + failed;
};