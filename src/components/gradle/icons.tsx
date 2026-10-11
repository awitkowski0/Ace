import type { ReactNode } from "react";
const I = ({ children, size = 16 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
/** Simplified Gradle elephant: head + trunk + ear. */
export const GradleIcon = ({ size = 16 }: { size?: number }) => (
  <I size={size}><path d="M13.2 4.3c-1.4-1.2-3.4-.7-4.3.6-.7-.5-1.600-.6-2.500-.3C4.200 5.300 2.600 8 3.200 10.400c.2.800.8 1.200 1.400 1.100.5-.1.800-.5.800-1l-.1-1.200M13.200 4.300c1 1 .7 2.600-.5 3.100-.6.200-1.200.1-1.700-.2M9 9.200l-.6 3.800M5.700 12.700h4" /><circle cx="11.200" cy="5.200" r=".4" fill="currentColor" /></I>
);
export const ReloadIcon = () => <I><path d="M13 8a5 5 0 1 1-1.500-3.600M13 2.500v2.800h-2.800" /></I>;
export const TaskIcon = () => <I size={14}><path d="M3.500 2.500h6l3 3v8h-9z M9.500 2.500v3h3" /></I>;
export const ExecIcon = () => <I><path d="M2.500 3.500h11v9h-11zM5 7l2 1.500L5 10M8.500 10h2.500" /></I>;
export const ExpandAllIcon = () => <I><path d="M4 6l4 3.500L12 6M4 2.500l4 3.500 4-3.500M4 13.500" /></I>;
export const CollapseAllIcon = () => <I><path d="M4 9.500L8 6l4 3.500M4 13.500L8 10l4 3.500" /></I>;
