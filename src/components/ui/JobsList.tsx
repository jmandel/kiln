import React from 'react';

interface Job {
  id: string;
  title: string;
  status?: string;
  createdAt?: string;
  type?: 'narrative' | 'fhir' | string;
  dependsOn?: string[];
}

interface JobsListProps {
  jobs: Job[];
  selected: string | null;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
}

export function JobsList({ jobs, selected, onSelect, onDelete }: JobsListProps) {
  const getStatusColor = (status?: string) => {
    switch (status) {
      case 'done':
        return 'bg-green-50 border-green-200';
      case 'running':
        return 'bg-craft-blue/10 border-craft-blue/30';
      case 'blocked':
        return 'bg-rose-50 border-rose-200';
      case 'error':
        return 'bg-rose-50 border-rose-200';
      default:
        return 'bg-gray-50 border-gray-200';
    }
  };

  const getStatusBadge = (status?: string) => {
    const colors = {
      done: 'badge-success',
      running: 'badge-blue',
      blocked: 'badge-error',
      error: 'badge-error',
    };
    const color = colors[status as keyof typeof colors] || 'badge-kiln bg-gray-100 text-gray-700';

    return <span className={color}>{status || 'queued'}</span>;
  };

  if (jobs.length === 0) {
    return <div className="text-center py-8 text-gray-500 text-sm">No jobs yet. Create one to get started.</div>;
  }

  return (
    <div className="space-y-2">
      {jobs.map((job) => (
        <div
          key={job.id}
          className={`
            p-3 rounded-soft border cursor-pointer transition-all
            ${
              selected === job.id ?
                'bg-craft-blue/20 border-craft-blue/50 shadow-sm ring-2 ring-craft-blue/30'
              : `${getStatusColor(job.status)} hover:shadow-md`
            }
          `}
          onClick={() => onSelect(job.id)}
        >
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm truncate">
                <span className="truncate">{job.title || 'Untitled'}</span>
              </div>
              {job.type && (
                <div className="mt-1">
                  <span
                    className={`uppercase text-[10px] px-2 py-0.5 rounded-full border ${
                      job.type === 'fhir' ?
                        'bg-blue-50 border-blue-200 text-blue-700'
                      : 'bg-gray-100 border-gray-300 text-gray-700'
                    }`}
                    title={`Type: ${job.type}`}
                  >
                    {job.type === 'fhir' ? 'FHIR' : 'Narrative'}
                  </span>
                </div>
              )}
              <div className="text-xs text-gray-500 mt-1">{job.id.slice(0, 12)}...</div>
              {(() => {
                const deps = Array.isArray(job.dependsOn) ? job.dependsOn : [];
                if (deps.length === 0) return null;
                // Determine unresolved dependencies based on the jobs list we have
                const unresolved = deps.filter((id) => jobs.find((j) => j.id === id)?.status !== 'done');
                if (unresolved.length > 0) {
                  return (
                    <div className="text-[11px] text-amber-700 mt-1">
                      Blocked on: {unresolved.map((id) => id.slice(0, 8)).join(', ')}
                    </div>
                  );
                }
                // All deps resolved: optionally show a subtle note, or nothing
                return null;
              })()}
            </div>
            <div className="flex items-center gap-2">
              {getStatusBadge(job.status)}
              {onDelete && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(job.id);
                  }}
                  className="text-gray-400 hover:text-red-600 text-sm"
                  aria-label="Delete job"
                >
                  ×
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
