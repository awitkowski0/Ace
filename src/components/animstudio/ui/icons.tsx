import type { ReactNode } from "react";

const I = ({ children, size = 16 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
export const MoveIcon = () => <I><path d="M8 1.5v13M1.5 8h13M8 1.5L6 3.5M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2" /></I>;
export const ResizeIcon = () => <I><rect x="2" y="6" width="8" height="8" rx="1" /><path d="M10 6l4-4M10.5 2H14v3.5" /></I>;
export const RotateIcon = () => <I><path d="M13.5 8a5.5 5.5 0 1 1-1.8-4.1" /><path d="M12.5 1.5v3h-3" /></I>;
export const PivotIcon = () => <I><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" /></I>;
export const WireIcon = () => <I><path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z" /><path d="M2.5 4.8L8 7.8l5.5-3M8 7.8v6.4" /></I>;
export const XrayIcon = () => <I><path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z" strokeDasharray="2 1.6" /><circle cx="8" cy="8" r="1.4" /></I>;
export const OnionIcon = () => <I><rect x="1.8" y="4.5" width="7" height="8.5" rx="1" opacity=".5" /><rect x="5.2" y="3" width="7" height="8.5" rx="1" /></I>;
export const PersonIcon = () => <I><circle cx="8" cy="3.6" r="1.8" /><path d="M8 5.6v5M4.5 7.2L8 6l3.5 1.2M6 14.2L8 10.6l2 3.6" /></I>;
export const MagnetIcon = () => <I><path d="M3 9V4.5a5 5 0 0 1 10 0V9M3 9h3V4.5M13 9h-3V4.5" /><path d="M3 11.5h3M10 11.5h3" /></I>;
export const GridIcon = () => <I><path d="M2 5.5h12M2 10.5h12M5.5 2v12M10.5 2v12" /></I>;
export const FrameIcon = () => <I><path d="M2 5.5V2h3.5M14 5.5V2h-3.5M2 10.5V14h3.5M14 10.5V14h-3.5" /><rect x="6" y="6" width="4" height="4" rx=".6" /></I>;
export const BoneIcon = ({ size = 14 }: { size?: number }) => <I size={size}><circle cx="4" cy="12" r="1.8" /><circle cx="12" cy="4" r="1.8" /><path d="M5.3 10.7l5.4-5.4" /></I>;
export const CubeIcon = ({ size = 14 }: { size?: number }) => <I size={size}><path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z" /><path d="M2.5 4.8L8 7.8l5.5-3M8 7.8v6.4" /></I>;
export const EyeIcon = ({ off = false }: { off?: boolean }) => (
  <I size={14}>{off ? <path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4zM3 13L13 3" opacity=".55" /> : <><path d="M1.8 8S4 4 8 4s6.2 4 6.2 4-2.2 4-6.2 4S1.8 8 1.8 8z" /><circle cx="8" cy="8" r="1.7" /></>}</I>
);
export const LockIcon = ({ on = false }: { on?: boolean }) => (
  <I size={14}><rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />{on ? <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /> : <path d="M5.5 7V5a2.5 2.5 0 0 1 4.8-1" />}</I>
);
export const PlusIcon = () => <I><path d="M8 3v10M3 8h10" /></I>;
export const TrashIcon = () => <I><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" /></I>;
export const CopyIcon = () => <I><rect x="5.5" y="5.5" width="8" height="8" rx="1" /><path d="M10.5 5.5V3a.5.5 0 0 0-.5-.5H3a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h2.5" /></I>;
export const ChevronR = () => <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3l5 5-5 5" /></svg>;
export const ChevronD = () => <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5l5 5 5-5" /></svg>;
export const SearchI = () => <I size={13}><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></I>;
export const PlayI = () => <I size={14}><path d="M5 3l8 5-8 5z" fill="currentColor" /></I>;
export const PauseI = () => <I size={14}><path d="M5 3v10M11 3v10" strokeWidth="2" /></I>;
export const CodeI = () => <I size={14}><path d="M5.5 4L2 8l3.5 4M10.5 4L14 8l-3.5 4" /></I>;
// ---- UV editor / textures
export const MirrorXI = () => <I><path d="M8 2v12" strokeDasharray="1.6 1.6" /><path d="M6.5 4.5L2.5 8l4 3.5zM9.5 4.5l4 3.5-4 3.5z" /></I>;
export const MirrorYI = () => <I><path d="M2 8h12" strokeDasharray="1.6 1.6" /><path d="M4.5 6.5L8 2.5l3.5 4zM4.5 9.5L8 13.5l3.5-4z" /></I>;
export const RotateUvI = () => <I><rect x="3.5" y="5" width="6.5" height="6.5" rx=".8" /><path d="M12.5 7.5a4 4 0 0 0-3-3.5M12.5 3.5V6H10" /></I>;
export const BoxUvI = () => <I><path d="M6 2h4v4h4v4h-4v4H6v-4H2V6h4z" /></I>;
export const FitI = () => <I><rect x="2.5" y="2.5" width="11" height="11" rx="1" /><path d="M5 8h6M8 5v6" opacity=".5" /></I>;
export const ImageI = () => <I><rect x="2" y="3" width="12" height="10" rx="1.2" /><circle cx="5.5" cy="6.5" r="1.1" /><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" /></I>;
export const UpI = () => <I><path d="M8 13V3M4 7l4-4 4 4" /></I>;
export const DownI = () => <I><path d="M8 3v10M4 9l4 4 4-4" /></I>;
