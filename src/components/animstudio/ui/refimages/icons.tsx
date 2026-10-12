import type { ReactNode } from "react";
const I = ({ children }: { children: ReactNode }) => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
export const ImageIcon = () => <I><rect x="2" y="3" width="12" height="10" rx="1.2" /><circle cx="5.6" cy="6.4" r="1.1" /><path d="M2.5 12l3.6-3.4 2.6 2.4 2-1.8 3.3 2.8" /></I>;
export const SunIcon = () => <I><circle cx="8" cy="8" r="2.6" /><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2" /></I>;
export const CheckerIcon = () => <I><rect x="2.5" y="2.5" width="11" height="11" rx="1" /><path d="M8 2.5v11M2.5 8h11" /><rect x="2.5" y="2.5" width="5.5" height="5.5" fill="currentColor" stroke="none" opacity=".5" /><rect x="8" y="8" width="5.5" height="5.5" fill="currentColor" stroke="none" opacity=".5" /></I>;
export const OrthoIcon = () => <I><path d="M2.5 5.5L8 2.5l5.5 3v5L8 13.5l-5.5-3z" /><path d="M2.5 5.5L8 8.5l5.5-3M8 8.5v5" strokeDasharray="1.6 1.4" /></I>;
