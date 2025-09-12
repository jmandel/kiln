import React, { ReactNode, useState, Children, cloneElement } from 'react';

export const Card = ({ children, className = "" }: { children: ReactNode; className?: string }) => (
  <div className={`card-kiln ${className}`}>
    {children}
  </div>
);

export const Badge = ({ variant = "default", children }: { variant?: string; children: ReactNode }) => {
  const variants: Record<string, string> = {
    default: "badge-kiln bg-gray-100 text-gray-700",
    success: "badge-success",
    warning: "badge-warning",
    error: "badge-error",
    info: "badge-blue"
  };
  return (
    <span className={`${variants[variant] || variants.default}`}>
      {children}
    </span>
  );
};


export const MetricPill = ({ 
  label, 
  value, 
  total, 
  icon 
}: { 
  label: string; 
  value: string | number; 
  total?: number; 
  icon?: string 
}) => (
  <div className="flex items-center gap-1.5 text-sm bg-warm-paper/50 px-3 py-1.5 rounded-soft">
    {icon && <span className="text-kiln-ember/60">{icon}</span>}
    <span className="text-gray-600 font-medium">{label}:</span>
    <span className="font-semibold text-text-charcoal">
      {value}
      {total && <span className="text-gray-500">/{total}</span>}
    </span>
  </div>
);

export const ViewToggle = ({ 
  views, 
  active, 
  onChange 
}: { 
  views: string[]; 
  active: string; 
  onChange: (v: string) => void 
}) => (
  <div className="flex items-center gap-1 border border-gray-200 rounded-md p-0.5">
    {views.map(view => (
      <button
        key={view}
        className={`px-2 py-1 text-xs rounded transition-colors ${
          active === view 
            ? 'bg-gray-100 text-gray-900' 
            : 'text-gray-600 hover:text-gray-900'
        }`}
        onClick={() => onChange(view)}
      >
        {view}
      </button>
    ))}
  </div>
);

export const StatusBadge = ({ status }: { status: string }) => {
  const map: Record<string, { text: string; className: string }> = {
    queued: { text: 'Queued', className: 'badge-kiln bg-gray-100 text-gray-700' },
    running: { text: 'Running', className: 'badge-blue' },
    done: { text: 'Done', className: 'badge-success' },
    error: { text: 'Error', className: 'badge-error' }
  };
  const variant = map[status] || map.running;
  return (
    <span className={variant.className}>
      {variant.text}
    </span>
  );
};

export const EmptyState = ({ message = "Create a new job or select one to begin" }: { message?: string }) => (
  <div className="card-kiln p-16 text-center max-w-md mx-auto">
    <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-4 text-kiln-ember/40">
      <path d="M12 2L2 7l10 5 10-5-10-5z"/>
      <path d="M2 17l10 5 10-5"/>
      <path d="M2 12l10 5 10-5"/>
    </svg>
    <div className="text-gray-600">{message}</div>
  </div>
);

export const ErrorBanner = ({ error, onResume, onOpenFailed }: { error: string; onResume?: () => void; onOpenFailed?: () => void }) => (
  <div className="card-kiln bg-rose-50 border-rose-200 text-rose-800 p-4">
    <div className="text-sm font-medium mb-1">Something went awry in the kiln</div>
    <div className="text-sm">{error}</div>
    <div className="flex items-center gap-3 mt-2">
      {onResume && (
        <button className="btn-kiln text-xs px-2.5 py-1" onClick={onResume}>Resume</button>
      )}
      {onOpenFailed && (
        <button className="btn-kiln-outline text-xs px-2.5 py-1" onClick={onOpenFailed}>Open failed step</button>
      )}
    </div>
  </div>
);
