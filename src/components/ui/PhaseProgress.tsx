import React from 'react';

interface PhaseInfo {
  id: string;
  label: string;
  done: number;
  total: number;
  pct: number;
}

interface PhaseProgressProps {
  phases?: PhaseInfo[];
  compact?: boolean;
}

export function PhaseProgress({ phases, compact = false }: PhaseProgressProps) {
  if (!phases || phases.length === 0) return null;

  if (compact) {
    // Compact horizontal bar with step counts
    return (
      <div className="w-full">
        {/* Step counts above the bar */}
        <div className="flex justify-between text-[10px] text-gray-600 font-medium mb-1">
          {phases.map(p => (
            <span key={`count-${p.id}`} className="text-center" style={{ width: `${100 / phases.length}%` }}>
              {p.done}/{p.total}
            </span>
          ))}
        </div>
        {/* Progress bar */}
        <div className="flex h-1 bg-gray-100 rounded-full overflow-hidden">
          {phases.map((p, idx) => (
            <div 
              key={p.id}
              className="relative"
              style={{ width: `${100 / phases.length}%` }}
              title={`${p.label}: ${p.done}/${p.total}`}
            >
              <div 
                className="h-full bg-emerald-500 transition-all"
                style={{ 
                  width: `${p.pct * 100}%`,
                  opacity: 0.8 + (idx * 0.05)
                }}
              />
            </div>
          ))}
        </div>
        {/* Phase labels below */}
        <div className="flex justify-between text-xs text-gray-500 mt-1">
          {phases.map(p => (
            <span key={p.id} className="text-center" style={{ width: `${100 / phases.length}%` }}>
              {p.label}
            </span>
          ))}
        </div>
      </div>
    );
  }

  // Full phase cards
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
      {phases.map(p => (
        <div key={p.id} className="rounded-xl border border-gray-200 p-2">
          <div className="text-xs text-gray-600 mb-1 truncate" title={p.label}>
            {p.label}
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div 
              className="h-full bg-emerald-500 transition-all"
              style={{ width: `${Math.round(p.pct * 100)}%` }}
            />
          </div>
          <div className="text-[11px] text-gray-500 mt-1">
            {p.done}/{p.total}
          </div>
        </div>
      ))}
    </div>
  );
}