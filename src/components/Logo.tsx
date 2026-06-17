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
            <stop offset="1" stopColor="var(--accent-strong)" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="9" fill={`url(#${gradId})`} />
        <path
          d="M17.2 6.5 9.5 17.2h5.1l-1.8 8.3 7.7-10.7h-5.1l1.8-8.3Z"
          fill="#fff"
          fillOpacity="0.95"
        />
      </svg>
      {withWordmark && <span className="logo-wordmark">LazyLoad</span>}
    </span>
  );
}
