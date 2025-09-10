import React, { ReactNode, useState, Children, cloneElement } from 'react';

export const Card = ({ children, className = "" }: { children: ReactNode; className?: string }) => (
  <div className={`rounded-lg border border-gray-200 bg-white ${className}`}>
    {children}
  </div>
);

export const Badge = ({ variant = "default", children }: { variant?: string; children: ReactNode }) => {
  const variants: Record<string, string> = {
    default: "bg-gray-100 text-gray-700",
    success: "bg-emerald-50 text-emerald-700",
    warning: "bg-amber-50 text-amber-700",
    error: "bg-rose-50 text-rose-700",
    info: "bg-blue-50 text-blue-700"
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${variants[variant] || variants.default}`}>
      {children}
    </span>
  );
};

export const Tabs = ({ defaultValue, children }: { defaultValue: string; children: ReactNode }) => {
  const [active, setActive] = useState(defaultValue);
  return (
    <div data-active={active}>
      {Children.map(children, child => 
        cloneElement(child as React.ReactElement, { active, setActive })
      )}
    </div>
  );
};

export const TabsList = ({ children, active, setActive }: { children: ReactNode; active?: string; setActive?: (v: string) => void }) => (
  <div className="flex items-center gap-2 border-b border-gray-200">
    {Children.map(children, child => 
      cloneElement(child as React.ReactElement, { active, setActive })
    )}
  </div>
);

export const TabsTrigger = ({ value, children, active, setActive }: { value: string; children: ReactNode; active?: string; setActive?: (v: string) => void }) => (
  <button
    className={`px-3 py-2 -mb-px text-sm transition-colors ${
      active === value 
        ? 'border-b-2 border-blue-600 text-blue-700 font-medium' 
        : 'text-gray-600 hover:text-gray-800'
    }`}
    onClick={() => setActive?.(value)}
  >
    {children}
  </button>
);

export const TabsContent = ({ value, children, active }: { value: string; children: ReactNode; active?: string }) => {
  if (active !== value) return null;
  return <div>{children}</div>;
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
  <div className="flex items-center gap-1.5 text-sm">
    {icon && <span className="text-gray-500">{icon}</span>}
    <span className="text-gray-600">{label}:</span>
    <span className="font-medium">
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
    queued: { text: 'Queued', className: 'bg-gray-100 text-gray-700' },
    running: { text: 'Running', className: 'bg-blue-50 text-blue-700' },
    done: { text: 'Done', className: 'bg-emerald-50 text-emerald-700' },
    error: { text: 'Error', className: 'bg-rose-50 text-rose-700' }
  };
  const variant = map[status] || map.running;
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${variant.className}`}>
      {variant.text}
    </span>
  );
};

export const EmptyState = ({ message = "Select a job from the left to view progress." }: { message?: string }) => (
  <div className="rounded-2xl border border-gray-200 p-12 text-center">
    <div className="text-gray-600">{message}</div>
  </div>
);

export const ErrorBanner = ({ error, onResume }: { error: string; onResume?: () => void }) => (
  <div className="rounded-xl border border-rose-200 bg-rose-50 text-rose-800 p-4">
    <div className="text-sm font-medium mb-1">Error</div>
    <div className="text-sm">{error}</div>
    {onResume && (
      <div className="text-xs text-rose-700 mt-2">
        Use Resume to retry. Open the most recent failed step or artifact to inspect full prompt/output.
      </div>
    )}
  </div>
);