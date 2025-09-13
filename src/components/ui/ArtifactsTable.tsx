import React, { useState } from 'react';
import { Badge } from './index';
import { formatTime, getVariantForKind } from './utils';

interface Artifact {
  id: string;
  name: string;
  kind: string;
  status?: string;
  notes?: string;
  createdAt?: string;
  phase?: string;
}

interface ArtifactsTableProps {
  items: Artifact[];
  onOpen: (id: string) => void;
}

export function ArtifactsTable({ items, onOpen }: ArtifactsTableProps) {
  const [sortBy, setSortBy] = useState('createdAt');
  const [filterPhase, setFilterPhase] = useState('all');

  const phases = ['all', ...Array.from(new Set(items.map((i) => i.phase || 'other')))];
  const filtered = filterPhase === 'all' ? items : items.filter((i) => (i.phase || 'other') === filterPhase);

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'createdAt') {
      const aTime = a.createdAt || '';
      const bTime = b.createdAt || '';
      return bTime.localeCompare(aTime);
    }
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    return 0;
  });

  return (
    <div>
      {/* Filters */}
      <div className="flex gap-2 mb-3 pb-3 border-b">
        <select
          className="text-sm border rounded px-2 py-1"
          value={filterPhase}
          onChange={(e) => setFilterPhase(e.target.value)}
        >
          {phases.map((p) => (
            <option key={p} value={p}>
              {p === 'all' ? 'All phases' : p}
            </option>
          ))}
        </select>

        <select className="text-sm border rounded px-2 py-1" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
          <option value="createdAt">Newest first</option>
          <option value="name">Name</option>
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="text-xs text-gray-500 uppercase tracking-wider">
            <tr className="border-b">
              <th className="text-left py-2">Name</th>
              <th className="text-left py-2">Type</th>
              <th className="text-left py-2">Phase</th>
              <th className="text-left py-2">Created</th>
              <th className="text-center py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((item) => (
              <tr key={item.id} className="border-b hover:bg-gray-50 cursor-pointer" onClick={() => onOpen(item.id)}>
                <td className="py-3">
                  <div className="font-medium text-sm">{item.name}</div>
                  {item.notes && <div className="text-xs text-gray-500">{item.notes}</div>}
                </td>
                <td className="py-3">
                  <Badge variant={getVariantForKind(item.kind)}>{item.kind}</Badge>
                </td>
                <td className="py-3 text-sm text-gray-600">{item.phase || '—'}</td>
                <td className="py-3 text-sm text-gray-600">{item.createdAt ? formatTime(item.createdAt) : '—'}</td>
                <td className="py-3 text-center">
                  <button
                    className="text-blue-600 hover:text-blue-800 text-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(item.id);
                    }}
                  >
                    View →
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ArtifactsGrid({ items, onOpen }: ArtifactsTableProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {items.map((item) => (
        <div
          key={item.id}
          className="p-4 border border-gray-200 rounded-lg hover:shadow-md transition-shadow cursor-pointer"
          onClick={() => onOpen(item.id)}
        >
          <div className="flex items-start justify-between mb-2">
            <div className="font-medium text-sm">{item.name}</div>
            <Badge variant={getVariantForKind(item.kind)}>{item.kind}</Badge>
          </div>
          {item.notes && <div className="text-xs text-gray-500 mb-2">{item.notes}</div>}
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>{item.phase || 'No phase'}</span>
            <span>{item.createdAt ? formatTime(item.createdAt) : '—'}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ArtifactsTimeline({ items, onOpen }: ArtifactsTableProps) {
  const sortedByTime = [...items].sort((a, b) => {
    const aTime = a.createdAt || '';
    const bTime = b.createdAt || '';
    return bTime.localeCompare(aTime);
  });

  return (
    <div className="space-y-4">
      {sortedByTime.map((item, idx) => (
        <div
          key={item.id}
          className="flex items-start gap-4 cursor-pointer hover:bg-gray-50 p-2 rounded"
          onClick={() => onOpen(item.id)}
        >
          <div className="flex flex-col items-center">
            <div className="w-3 h-3 bg-blue-500 rounded-full"></div>
            {idx < sortedByTime.length - 1 && <div className="w-0.5 h-16 bg-gray-300 mt-1"></div>}
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-medium text-sm">{item.name}</span>
              <Badge variant={getVariantForKind(item.kind)}>{item.kind}</Badge>
            </div>
            {item.notes && <div className="text-xs text-gray-500 mb-1">{item.notes}</div>}
            <div className="text-xs text-gray-500">
              {item.phase && <span className="mr-3">Phase: {item.phase}</span>}
              {item.createdAt ? formatTime(item.createdAt) : '—'}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
