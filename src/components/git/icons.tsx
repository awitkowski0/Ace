import type { ReactNode } from "react";

const I = ({ children, size = 16 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
export const CommitIcon = () => <I><circle cx="8" cy="8" r="2.6" /><path d="M1.5 8h3.9M10.6 8h3.9" /></I>;
export const RefreshIcon = () => <I><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v2.8h-2.8" /></I>;
export const RollbackIcon = () => <I><path d="M5 3.5L2.5 6 5 8.5M2.5 6H9a4 4 0 0 1 0 8H6" /></I>;
export const ExpandAllIcon = () => <I><path d="M4 6l4 4 4-4M4 2.5h8" /></I>;
export const CollapseAllIcon = () => <I><path d="M4 10l4-4 4 4M4 13.5h8" /></I>;
export const DiffIcon = () => <I><rect x="1.5" y="2.5" width="5.5" height="11" rx="1" /><rect x="9" y="2.5" width="5.5" height="11" rx="1" /></I>;
export const StopIcon = () => <I><rect x="4" y="4" width="8" height="8" rx="1" /></I>;
export const ArrowDownIcon = () => <I><path d="M8 3v9M4.5 8.5L8 12l3.5-3.5" /></I>;
export const ArrowUpIcon = () => <I><path d="M8 13V4M4.5 7.5L8 4l3.5 3.5" /></I>;
