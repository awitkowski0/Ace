import type { ReactNode } from "react";
const S = (p: { children: ReactNode }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">{p.children}</svg>
);
export const IcPlay = () => <S><path d="M4.5 3v10l8-5z" fill="currentColor" /></S>;
export const IcPause = () => <S><path d="M5 3.5v9M11 3.5v9" strokeWidth="2.2" /></S>;
export const IcLoop = () => <S><path d="M3 7V6a2 2 0 0 1 2-2h7M12 2l2 2-2 2M13 9v1a2 2 0 0 1-2 2H4M4 14l-2-2 2-2" /></S>;
export const IcKey = () => <S><path d="M8 2.5 13.5 8 8 13.5 2.5 8z" fill="currentColor" /></S>;
export const IcKeyAdd = () => <S><path d="M7 3 12 8 7 13 2 8z" /><path d="M13 2v4M11 4h4" /></S>;
export const IcSnap = () => <S><path d="M3 3v6a5 5 0 0 0 10 0V3M3 6h3M10 6h3" /></S>;
export const IcAnchor = () => <S><circle cx="8" cy="3.5" r="1.6" /><path d="M8 5v8M4 8.5c0 2.5 1.8 4.5 4 4.5s4-2 4-4.5M5.5 7.5h5" /></S>;
export const IcAuto = () => <S><circle cx="8" cy="8" r="5.2" /><circle cx="8" cy="8" r="2" fill="currentColor" /></S>;
export const IcGraph = () => <S><path d="M2 13V3M2 13h12M4 11c2-1 2-6 4-6s2 6 5 6" /></S>;
export const IcDope = () => <S><path d="M3 4.5 4.5 6 3 7.5 1.5 6zM9 8.5 10.5 10 9 11.5 7.5 10zM13 3.5l1.5 1.5-1.5 1.5-1.5-1.5z" fill="currentColor" stroke="none" /></S>;
export const IcFit = () => <S><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></S>;
export const IcPlus = () => <S><path d="M8 3v10M3 8h10" /></S>;
export const IcCopy = () => <S><rect x="5" y="5" width="8" height="8.5" rx="1.2" /><path d="M3 10.5V3.5A1 1 0 0 1 4 2.5h6" /></S>;
export const IcTrash = () => <S><path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" /></S>;
export const IcEdit = () => <S><path d="M3 13l.5-3L10.5 3l2.5 2.5-7 7z" /></S>;
export const IcWarn = () => <S><path d="M8 2.5 14 13H2z" /><path d="M8 6.5v3M8 11v.4" /></S>;
export const IcClose = () => <S><path d="M4 4l8 8M12 4l-8 8" /></S>;
export const IcChevron = ({ open }: { open: boolean }) => <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" style={{ transform: open ? "rotate(90deg)" : undefined }}><path d="M6 3.5 11 8l-5 4.5z" /></svg>;
export const IcPose = () => <S><path d="M2 12c3-8 9-8 12 0" /><circle cx="2.5" cy="11.5" r="1.3" fill="currentColor" /><circle cx="13.5" cy="11.5" r="1.3" fill="currentColor" /><circle cx="8" cy="5" r="1.3" fill="currentColor" /></S>;
export const IcNoise = () => <S><path d="M2 8h1.5l1-4 2 8 2-9 2 7 1-2H14" /></S>;
export const IcMarker = () => <S><path d="M4 2.5v11M4 3h8l-2 2.5L12 8H4" /></S>;
export const IcMirror = () => <S><path d="M8 2v12" strokeDasharray="1.6 1.6" /><path d="M6 4.5 2 8l4 3.5zM10 4.5 14 8l-4 3.5z" /></S>;
