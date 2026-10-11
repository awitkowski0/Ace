import type { ReactNode } from "react";

const G = "#a3be8c";
const R = "#bf616a";
const B = "#81a1c1";
const Y = "#ebcb8b";
const S = ({ children, size = 16 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);

export const RunIcon = ({ size }: { size?: number }) => <S size={size}><path d="M4.5 2.8v10.4L13 8z" fill={G} stroke={G} /></S>;
export const DebugIcon = ({ size }: { size?: number }) => (
  <S size={size}><path d="M5.5 5.5a2.5 2.5 0 0 1 5 0" stroke={G} /><rect x="4.5" y="5.5" width="7" height="7" rx="3.5" stroke={G} /><path d="M2 8h2.5M11.5 8H14M2.5 12l2-1.2M13.5 12l-2-1.2M3 4.5l2 1.5M13 4.5L11 6M8 6v6.5" stroke={G} /></S>
);
export const StopIcon = ({ size }: { size?: number }) => <S size={size}><rect x="3.5" y="3.5" width="9" height="9" rx="1.2" fill={R} stroke={R} /></S>;
export const RerunIcon = ({ size }: { size?: number }) => <S size={size}><path d="M13 8a5 5 0 1 1-1.6-3.7" stroke={G} /><path d="M12.8 2v3.2H9.6" stroke={G} /></S>;
export const ScrollEndIcon = () => <S><path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3.5 13.5h9" /></S>;
export const WrapIcon = () => <S><path d="M2.5 4h11M2.5 8h8.5a2.2 2.2 0 0 1 0 4.4H8.5M10 10.5l-1.8 1.9 1.8 1.9M2.5 12h3" /></S>;
export const TrashIcon = () => <S><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4" /></S>;
export const KebabIcon = () => <S><circle cx="8" cy="3.5" r=".7" fill="currentColor" /><circle cx="8" cy="8" r=".7" fill="currentColor" /><circle cx="8" cy="12.5" r=".7" fill="currentColor" /></S>;
export const PlusIcon = () => <S><path d="M8 3v10M3 8h10" /></S>;
export const MinusSmall = () => <S><path d="M3 8h10" /></S>;
export const CopyIcon = () => <S><rect x="5.5" y="5.5" width="8" height="8" rx="1.2" /><path d="M10.5 3.5v-.3a.7.7 0 0 0-.7-.7H3.7a.7.7 0 0 0-.7.7v6.1a.7.7 0 0 0 .7.7h.3" /></S>;
export const ExpandAllIcon = () => <S><path d="M4 6l4 4 4-4M4 2.5l4 4 4-4" transform="translate(0 3)" /></S>;
export const CollapseAllIcon = () => <S><path d="M4 7l4-4 4 4M4 12l4-4 4 4" /></S>;
export const SortIcon = () => <S><path d="M4 3v10M2 11l2 2 2-2M9 4h4M9 8h3M9 12h2" /></S>;
export const FilterPassed = () => <S><circle cx="8" cy="8" r="5.8" stroke={G} /><path d="M5.2 8.2l2 2 3.6-4" stroke={G} /></S>;
export const FilterSkipped = () => <S><circle cx="8" cy="8" r="5.8" stroke={B} /><path d="M5 11l6-6" stroke={B} /></S>;

export const PassIcon = () => <S><circle cx="8" cy="8" r="6" fill={G} stroke={G} /><path d="M5.2 8.2l2 2 3.6-4" stroke="#2e3440" strokeWidth="1.5" /></S>;
export const FailIcon = () => <S><circle cx="8" cy="8" r="6" fill={R} stroke={R} /><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="#2e3440" strokeWidth="1.5" /></S>;
export const ErrorIcon = () => <S><circle cx="8" cy="8" r="6" fill={Y} stroke={Y} /><path d="M8 4.8v4M8 11v.2" stroke="#2e3440" strokeWidth="1.6" /></S>;
export const SkipIcon = () => <S><circle cx="8" cy="8" r="6" stroke={B} /><path d="M4.5 11.5l7-7" stroke={B} /></S>;
export const PendingIcon = () => <S><circle cx="8" cy="8" r="5.5" stroke="#616e88" strokeDasharray="2 2" /></S>;
export const RunningIcon = () => (
  <svg className="run-spin" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={B} strokeWidth="1.8" strokeLinecap="round"><path d="M8 2.2a5.8 5.8 0 1 1-5.8 5.8" /></svg>
);
export const ModuleIcon = () => <S><path d="M3.5 1.5h5l4 4v8.5a.5.5 0 0 1-.5.5h-8.5a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5z" stroke={B} /><path d="M8.5 1.5v4h4" stroke={B} /></S>;
export const ClassIcon = () => <S><circle cx="8" cy="8" r="5.5" stroke={B} /><path d="M10 6.2a2.6 2.6 0 1 0 0 3.6" stroke={B} /></S>;
export const PythonIcon = () => (
  <S><path d="M8 2c-2.6 0-2.5 1.1-2.5 1.1V5H8.2v.6H4.3S2.5 5.4 2.5 8s1.6 2.5 1.6 2.5H5V9.2S4.9 7.6 6.5 7.6h2.7s1.5 0 1.5-1.5V3.3S11 2 8 2z" stroke={B} /><path d="M8 14c2.6 0 2.5-1.1 2.5-1.1V11H7.8v-.6h3.9s1.8.2 1.8-2.4-1.6-2.5-1.6-2.5H11v1.3s.1 1.6-1.5 1.6H6.8s-1.5 0-1.5 1.5v2.8S5 14 8 14z" stroke={Y} /></S>
);
export const ShellIcon = () => <S><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M4.5 6l2.5 2-2.5 2M8.5 10.5h3" /></S>;
export const TestsIcon = () => <S><path d="M6 2.5h4M6.8 2.5v4L3.2 12.2a1 1 0 0 0 .9 1.5h7.8a1 1 0 0 0 .9-1.5L9.2 6.5v-4" stroke={G} /></S>;
export const JumpIcon = () => <S><path d="M6.5 3.5H4a1 1 0 0 0-1 1V12a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V9.5M9 3h4v4M13 3L7.5 8.5" /></S>;
