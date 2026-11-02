/**
 * Icons for the Next redesign: the project's own set from components/icons,
 * plus the few glyphs it lacks, drawn with the same 24px grid and 1.5 stroke
 * so both sets read as one family.
 */
import type { SVGProps } from 'react'

export {
  IAgents, IBoard, ICalendar, IChat, IClip, IClock, IConvene, IDoc, IExit, IFile, IMail,
  IMore, IObserve, IPin, IPlus, IRepeat, ISearch, IShip, ISmile, ITrash, IWhisper, IAt,
} from '@/components/icons'

type P = SVGProps<SVGSVGElement>

const base: P = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  viewBox: '0 0 24 24',
  'aria-hidden': true,
}

export const IHash = (p: P) => <svg {...base} {...p}><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" /></svg>
export const IX = (p: P) => <svg {...base} {...p}><path d="M18 6 6 18M6 6l12 12" /></svg>
export const ICheck = (p: P) => <svg {...base} {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
export const IArrowUp = (p: P) => <svg {...base} {...p}><path d="M12 19V5M6 11l6-6 6 6" /></svg>
export const IArrowDown = (p: P) => <svg {...base} {...p}><path d="M12 5v14M6 13l6 6 6-6" /></svg>
export const IArrowLeft = (p: P) => <svg {...base} {...p}><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
export const IArrowRight = (p: P) => <svg {...base} {...p}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
export const IEye = (p: P) => <svg {...base} {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12" /><circle cx="12" cy="12" r="3" /></svg>
export const IEyeOff = (p: P) => <svg {...base} {...p}><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" /></svg>
export const IChecks = (p: P) => <svg {...base} {...p}><path d="m2 12.5 4.5 4.5L16 7.5M12.5 16.5l.5.5L22 7.5" /></svg>
export const IChevronLeft = (p: P) => <svg {...base} {...p}><path d="m15 18-6-6 6-6" /></svg>
export const IChevronRight = (p: P) => <svg {...base} {...p}><path d="m9 18 6-6-6-6" /></svg>
export const IChevronDown = (p: P) => <svg {...base} {...p}><path d="m6 9 6 6 6-6" /></svg>
export const IPanelRight = (p: P) => <svg {...base} {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></svg>
export const IReply = (p: P) => <svg {...base} {...p}><path d="M9 17 4 12l5-5" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></svg>
export const IThread = (p: P) => <svg {...base} {...p}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12Z" /><path d="M8 11h8M8 14.5h5" /></svg>
export const ICopy = (p: P) => <svg {...base} {...p}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></svg>
export const IBellOff = (p: P) => <svg {...base} {...p}><path d="M13.7 21a2 2 0 0 1-3.4 0M18.6 13A17.9 17.9 0 0 1 18 8M6.3 6.3A6 6 0 0 0 6 8c0 7-3 9-3 9h14M18 8a6 6 0 0 0-9.3-5M2 2l20 20" /></svg>
export const IBell = (p: P) => <svg {...base} {...p}><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M13.7 21a2 2 0 0 1-3.4 0" /></svg>
export const IUsers = (p: P) => <svg {...base} {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5M16 4.6a3.5 3.5 0 0 1 0 6.8M21.5 20a6.5 6.5 0 0 0-4-6" /></svg>
export const IInfo = (p: P) => <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
export const IAlert = (p: P) => <svg {...base} {...p}><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3ZM12 9v4M12 17h.01" /></svg>
export const IActivity = (p: P) => <svg {...base} {...p}><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>
export const IFolder = (p: P) => <svg {...base} {...p}><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z" /></svg>
export const ILibrary = (p: P) => <svg {...base} {...p}><path d="M4 19.5V5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2Zm0 0A2 2 0 0 0 6 22h13M8 7h7" /></svg>
export const ISun = (p: P) => <svg {...base} {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
export const IMoon = (p: P) => <svg {...base} {...p}><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></svg>
export const IMonitor = (p: P) => <svg {...base} {...p}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>
export const IPencil = (p: P) => <svg {...base} {...p}><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16Z" /><path d="m13.5 6.5 4 4" /></svg>
export const IExternal = (p: P) => <svg {...base} {...p}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
export const IExpand = (p: P) => <svg {...base} {...p}><path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5" /></svg>
export const IDownload = (p: P) => <svg {...base} {...p}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
export const IImage = (p: P) => <svg {...base} {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5L5 20" /></svg>
export const ISettings = (p: P) => <svg {...base} {...p}><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
export const ISpark = (p: P) => <svg {...base} {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5" /></svg>
export const IStop = (p: P) => <svg {...base} {...p}><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
export const ILink = (p: P) => <svg {...base} {...p}><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" /></svg>
export const ICompose = (p: P) => <svg {...base} {...p}><path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" /><path d="M18.4 3.6a2 2 0 0 1 2.8 2.8L13 14.6 9.5 15.5l.9-3.5Z" /></svg>
export const IComputer = (p: P) => <svg {...base} {...p}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M7 20h10M9 16l-1 4M15 16l1 4" /></svg>
export const ICode = (p: P) => <svg {...base} {...p}><path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" /></svg>
export const IGrid = (p: P) => <svg {...base} {...p}><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></svg>
export const IPoll = (p: P) => <svg {...base} {...p}><path d="M5 20V11M12 20V4M19 20v-6" /></svg>
export const ILock = (p: P) => <svg {...base} {...p}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
