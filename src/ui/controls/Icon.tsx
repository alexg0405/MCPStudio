import type { SVGProps } from 'react';

// Original, minimal icon set (16×16 viewBox). Stroke icons inherit currentColor.
const PATHS = {
  play: <path d="M4 2.5v11l9-5.5z" fill="currentColor" stroke="none" />,
  pause: (
    <g fill="currentColor" stroke="none">
      <rect x="3.5" y="2.5" width="3" height="11" rx="0.5" />
      <rect x="9.5" y="2.5" width="3" height="11" rx="0.5" />
    </g>
  ),
  stop: <rect x="3" y="3" width="10" height="10" rx="1" fill="currentColor" stroke="none" />,
  record: <circle cx="8" cy="8" r="5" fill="currentColor" stroke="none" />,
  playlist: (
    <g>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path d="M1.5 6h13M1.5 9.5h13" />
      <rect x="4" y="3.5" width="4" height="1.6" fill="currentColor" stroke="none" />
      <rect x="7" y="7" width="5" height="1.6" fill="currentColor" stroke="none" />
      <rect x="3" y="10.6" width="6" height="1.6" fill="currentColor" stroke="none" />
    </g>
  ),
  channelRack: (
    <g fill="currentColor" stroke="none">
      {[0, 1, 2].map((r) =>
        [0, 1, 2, 3].map((c) => (
          <rect
            key={`${r}${c}`}
            x={2 + c * 3.2}
            y={3 + r * 3.6}
            width="2.4"
            height="2.6"
            rx="0.4"
            opacity={(r + c) % 2 ? 0.45 : 1}
          />
        )),
      )}
    </g>
  ),
  pianoRoll: (
    <g>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path d="M4.5 2.5v11" />
      <rect x="6" y="4.5" width="4" height="1.6" fill="currentColor" stroke="none" />
      <rect x="9" y="7.5" width="4" height="1.6" fill="currentColor" stroke="none" />
      <rect x="6.5" y="10.5" width="3" height="1.6" fill="currentColor" stroke="none" />
    </g>
  ),
  mixer: (
    <g>
      <path d="M4 2.5v11M8 2.5v11M12 2.5v11" />
      <rect x="2.5" y="8" width="3" height="2" rx="0.5" fill="currentColor" stroke="none" />
      <rect x="6.5" y="4.5" width="3" height="2" rx="0.5" fill="currentColor" stroke="none" />
      <rect x="10.5" y="10" width="3" height="2" rx="0.5" fill="currentColor" stroke="none" />
    </g>
  ),
  browser: (
    <g>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path d="M5.5 2.5v11" />
      <path d="M2.8 5h1.6M2.8 7.5h1.6M2.8 10h1.6" />
    </g>
  ),
  undo: <path d="M5 4L2 7l3 3M2.5 7H10a3.5 3.5 0 010 7H7" />,
  redo: <path d="M11 4l3 3-3 3M13.5 7H6a3.5 3.5 0 000 7h3" />,
  maximize: <rect x="3" y="3" width="10" height="10" rx="1" />,
  restore: (
    <g>
      <rect x="2.5" y="5" width="8.5" height="8.5" rx="1" />
      <path d="M5 5V3h8.5v8.5h-2.5" />
    </g>
  ),
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  plus: <path d="M8 3v10M3 8h10" />,
  sparkle: <path d="M8 1.8l1.5 4.7 4.7 1.5-4.7 1.5L8 14.2l-1.5-4.7L1.8 8l4.7-1.5z" />,
  mic: (
    <path d="M8 1.8a2 2 0 012 2V8a2 2 0 01-4 0V3.8a2 2 0 012-2zM4.2 7.5a3.8 3.8 0 007.6 0M8 11.3v2.9M5.6 14.2h4.8" />
  ),
  send: <path d="M2 8l11.5-5.5L10 14l-2.2-4.6z M7.8 9.4L13.5 2.5" />,
  folder: <path d="M1.5 4.5v8h13v-6.5H7.5l-1.5-1.5z" />,
  chevronRight: <path d="M6 4l4 4-4 4" />,
  chevronDown: <path d="M4 6l4 4 4-4" />,
  wave: <path d="M1.5 8c1.2-4 2.2-4 3.2 0s2 4 3.2 0 2-4 3.2 0 2 4 3.4 0" />,
  plug: <path d="M6 1.5v3M10 1.5v3M4.5 4.5h7v3a3.5 3.5 0 01-7 0zM8 11v3.5" />,
  metronome: <path d="M5 14.5h6l-1.8-12h-2.4zM8 10l3.5-6" />,
  note: <path d="M6 12.5V3.5l7-1.5v9M6 12.5a2 2 0 11-4 0 2 2 0 014 0zM13 11a2 2 0 11-4 0 2 2 0 014 0z" />,
  keyboard: (
    <g>
      <rect x="1.5" y="3.5" width="13" height="9" rx="1" />
      <path d="M4.5 3.5v5M8 3.5v5M11.5 3.5v5M3 8.5h2.5M6.8 8.5h2.4M10.5 8.5h2.5" />
    </g>
  ),
  midi: (
    <g>
      <circle cx="8" cy="8" r="6" />
      <circle cx="5" cy="8" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="11" cy="8" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="6" cy="5.3" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="10" cy="5.3" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="8" cy="4.4" r="0.8" fill="currentColor" stroke="none" />
    </g>
  ),
  cpu: (
    <g>
      <rect x="4" y="4" width="8" height="8" rx="1" />
      <path d="M6 1.5v2.5M10 1.5v2.5M6 12v2.5M10 12v2.5M1.5 6h2.5M1.5 10h2.5M12 6h2.5M12 10h2.5" />
    </g>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
