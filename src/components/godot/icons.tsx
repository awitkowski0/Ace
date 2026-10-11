import type { ReactNode } from "react";
const I = ({ children, size = 16 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
/** Simplified engine head: rounded face with two eyes and ears. */
export const GodotIcon = ({ size = 16 }: { size?: number }) => (
  <I size={size}><path d="M2.5 4.500l2 1.500h7l2-1.500v6.500c0 1.400-1.200 2.500-2.600 2.500H5.100c-1.400 0-2.600-1.100-2.600-2.500z" /><circle cx="5.800" cy="9" r="1.100" /><circle cx="10.200" cy="9" r="1.100" /><path d="M7.200 11.500h1.600" /></I>
);
export const SceneIcon = ({ size = 14 }: { size?: number }) => <I size={size}><path d="M2.500 3.500h11v9h-11zM2.500 6.500h11M6 3.500v9" /></I>;
export const ScriptIcon = ({ size = 14 }: { size?: number }) => <I size={size}><path d="M3.500 2.500h6l3 3v8h-9zM9.500 2.500v3h3M6 8.500l-1 1 1 1M9 8.500l1 1-1 1" /></I>;
export const PresetIcon = ({ size = 14 }: { size?: number }) => <I size={size}><path d="M2.500 3.500h11v9h-11zM5 7l2 1.500L5 10M8.500 10h2.500" /></I>;
export const ReloadIcon = () => <I><path d="M13 8a5 5 0 1 1-1.500-3.600M13 2.500v2.800h-2.800" /></I>;
export const EditorIcon = () => <I><path d="M9.500 2.500h4v4M13.500 2.500L7.500 8.500M11.500 9v3.500h-8v-8H7" /></I>;
export const ImportIcon = () => <I><path d="M8 2.500v7.500M5 7l3 3 3-3M3 12.500h10" /></I>;
export const HotIcon = () => <I><path d="M9 2L4 9h3.500L7 14l5-7H8.500z" /></I>;
