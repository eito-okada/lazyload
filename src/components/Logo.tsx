interface LogoProps {
  size?: number;
  withWordmark?: boolean;
}

/**
 * LazyLoad brand mark: a rounded gradient tile with a stacked "layers + bolt"
 * glyph. Pass `withWordmark` to render the name alongside it.
 */
export default function Logo({ size = 32, withWordmark = false }: LogoProps) {
  const gradId = 'lazyload-logo-grad';
  const sheenId = 'lazyload-logo-sheen';
  return (
    <span className="logo">
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className="logo-mark"
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
            <stop stopColor="var(--accent)" />
            <stop offset="0.5" stopColor="var(--accent)" />
            <stop offset="1" stopColor="var(--good)" />
          </linearGradient>
          <linearGradient id={sheenId} x1="16" y1="0" x2="16" y2="20" gradientUnits="userSpaceOnUse">
            <stop stopColor="#fff" stopOpacity="0.25" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="9.5" fill={`url(#${gradId})`} />
        <rect width="32" height="32" rx="9.5" fill={`url(#${sheenId})`} />
        {/* "Ease check": short left arm, long lifting right arm — effortlessly done. */}
        <path
          d="M8.5 16.4 13.1 21 24 9"
          fill="none"
          stroke="#fff"
          strokeWidth="3.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {withWordmark && <span className="logo-wordmark">LazyLoad</span>}
    </span>
  );
}
