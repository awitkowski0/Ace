import type { ReactNode } from "react";

const I = ({ children, size = 16 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
export const FolderIcon = () => <I><path d="M1.5 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.5h6.2c.7 0 1.2.5 1.2 1.2v6.3c0 .7-.5 1.2-1.2 1.2H2.7c-.7 0-1.2-.5-1.2-1.2z" /></I>;
export const FolderOpenIcon = FolderIcon;
export const FileIcon = () => <I><path d="M3.5 1.5h5l4 4v8.5a.5.5 0 0 1-.5.5h-8.5a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5z" /><path d="M8.5 1.5v4h4" /></I>;
export const ChevronRight = () => <I size={12}><path d="M5 3l5 5-5 5" /></I>;
export const ChevronDown = () => <I size={12}><path d="M3 5l5 5 5-5" /></I>;
export const TerminalIcon = () => <I><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M4.5 6l2.5 2-2.5 2M8.5 10.5h3" /></I>;
export const SearchIcon = () => <I><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></I>;
export const BranchIcon = () => <I><circle cx="4.5" cy="3.5" r="1.6" /><circle cx="4.5" cy="12.5" r="1.6" /><circle cx="11.5" cy="5.5" r="1.6" /><path d="M4.5 5.1v5.8M11.5 7.1c0 2.5-3 2-7 4" /></I>;
export const ProblemsIcon = () => <I><circle cx="8" cy="8" r="6.2" /><path d="M8 4.5V8.5M8 11v.2" /></I>;
export const CloudIcon = () => <I><path d="M4.5 12.5a3 3 0 0 1-.3-6 4 4 0 0 1 7.6 1 2.6 2.6 0 0 1-.3 5z" /></I>;
export const SparkIcon = () => <I><path d="M8 1.5l1.5 4.5 4.5 1.5-4.5 1.5L8 13.5 6.5 9 2 7.5 6.5 6z" /></I>;
export const CpuIcon = () => <I><rect x="4" y="4" width="8" height="8" rx="1" /><path d="M6.5 1.5v2.5M9.5 1.5v2.5M6.5 12v2.5M9.5 12v2.5M1.5 6.5H4M1.5 9.5H4M12 6.5h2.5M12 9.5h2.5" /></I>;
export const CloseIcon = ({ size = 12 }: { size?: number }) => <I size={size}><path d="M4 4l8 8M12 4l-8 8" /></I>;
export const MinusIcon = () => <I><path d="M3.5 8h9" /></I>;
export const DotsIcon = () => <I><circle cx="3.5" cy="8" r=".6" fill="currentColor" /><circle cx="8" cy="8" r=".6" fill="currentColor" /><circle cx="12.5" cy="8" r=".6" fill="currentColor" /></I>;
export const GearIcon = () => <I><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></I>;
export const PlayIcon = () => <I><path d="M5 3l8 5-8 5z" /></I>;
