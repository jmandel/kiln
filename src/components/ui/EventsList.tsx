import React from 'react';

interface DocGenEvent {
  ts: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

interface EventsListProps {
  events: DocGenEvent[];
  className?: string;
}

function formatEventTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return ts;
  }
}

export function EventsList({ events, className = "" }: EventsListProps) {
  const recent = events.slice(-20).reverse();
  
  return (
    <div className={`space-y-1 ${className}`}>
      {recent.length ? (
        recent.map((e, i) => (
          <div key={i} className="text-xs py-1 px-2 hover:bg-gray-50 rounded">
            <span className="text-gray-400 mr-2 font-mono">
              {formatEventTime(e.ts)}
            </span>
            <span className={
              e.level === 'error' ? 'text-rose-700' :
              e.level === 'warn' ? 'text-amber-700' :
              'text-gray-700'
            }>
              {e.msg}
            </span>
          </div>
        ))
      ) : (
        <div className="text-sm text-gray-500 text-center py-4">
          No events yet.
        </div>
      )}
    </div>
  );
}