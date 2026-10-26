/** Small inline SVG icons (stroke/fill use currentColor). 16px viewBox. */

type IconProps = { size?: number; className?: string };

function svg(path: React.ReactNode, vb = 16) {
  return ({ size = 14, className }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${vb} ${vb}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {path}
    </svg>
  );
}

export const CommentIcon = svg(
  <path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H6l-3 2.5V11.5a2 2 0 0 1-.5-1.3z" />,
);

export const SwapIcon = svg(
  <>
    <path d="M5 2.5 2.5 5 5 7.5" />
    <path d="M2.5 5h9" />
    <path d="m11 13.5 2.5-2.5L11 8.5" />
    <path d="M13.5 11h-9" />
  </>,
);

export const ResetIcon = svg(
  <>
    <path d="M3 8a5 5 0 1 1 1.6 3.7" />
    <path d="M3 11.5V8h3.5" />
  </>,
);

export const CloseIcon = svg(
  <>
    <path d="M4 4l8 8" />
    <path d="M12 4l-8 8" />
  </>,
);

export const CopyIcon = svg(
  <>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
  </>,
);

export const CheckIcon = svg(<path d="M3.5 8.5l3 3 6-7" />);

export const EyeIcon = svg(
  <>
    <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="2" />
  </>,
);

export const EyeOffIcon = svg(
  <>
    <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="2" />
    <path d="M2.5 13.5l11-11" />
  </>,
);

/** An arrow out of a box: opens in the browser. */
export const ExternalIcon = svg(
  <>
    <path d="M9.5 2.5h4v4" />
    <path d="M13.5 2.5 8 8" />
    <path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
  </>,
);

/** A pushpin, for pinned files in the sidebar. */
export const PinIcon = svg(
  <>
    <path d="M6 2h4M8 2v5" />
    <path d="M4.5 7.5h7L13 10H3z" />
    <path d="M8 10v4" />
  </>,
);
