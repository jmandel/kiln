import React from 'react';

interface Job {
  id: string;
  title: string;
  status?: string;
  createdAt?: string;
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
      case 'done': return 'bg-emerald-50 border-emerald-200';
      case 'running': return 'bg-blue-50 border-blue-200';
      case 'blocked': return 'bg-rose-50 border-rose-200';
      case 'error': return 'bg-rose-50 border-rose-200';
      default: return 'bg-gray-50 border-gray-200';
    }
  };

  const getStatusBadge = (status?: string) => {
    const colors = {
      done: 'text-emerald-700 bg-emerald-100',
      running: 'text-blue-700 bg-blue-100',
      blocked: 'text-rose-700 bg-rose-100',
      error: 'text-rose-700 bg-rose-100'
    };
    const color = colors[status as keyof typeof colors] || 'text-gray-700 bg-gray-100';
    
    return (
      <span className={`text-xs px-1.5 py-0.5 rounded ${color}`}>
        {status || 'queued'}
      </span>
    );
  };

  if (jobs.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500 text-sm">
        No jobs yet. Create one to get started.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {jobs.map(job => (
        <div
          key={job.id}
          className={`
            p-3 rounded-lg border cursor-pointer transition-all
            ${selected === job.id 
              ? 'bg-blue-50 border-blue-300 shadow-sm' 
              : `${getStatusColor(job.status)} hover:shadow-sm`
            }
          `}
          onClick={() => onSelect(job.id)}
        >
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm truncate">
                {job.title || 'Untitled'}
              </div>
              <div className="text-xs text-gray-500 mt-1">
                {job.id.slice(0, 12)}...
              </div>
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