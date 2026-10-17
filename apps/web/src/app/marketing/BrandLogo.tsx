/**
 * Truevine Voice logo mark.
 *
 * Inline SVG so the marketing pages ship no binary assets and the mark inherits
 * colour and sizing from CSS. Decorative only: the accessible name lives on the
 * surrounding link or heading, never here.
 */
export function BrandLogo({ className }: { readonly className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      width="36"
      height="36"
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient
          id="tv-logo-bg"
          x1="0"
          y1="0"
          x2="40"
          y2="40"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#177054" />
          <stop offset="1" stopColor="#0A3D2E" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="12" fill="url(#tv-logo-bg)" />
      <rect x="9.5" y="16.5" width="3.2" height="7" rx="1.6" fill="#FFFFFF" fillOpacity="0.85" />
      <rect x="15.4" y="12" width="3.2" height="16" rx="1.6" fill="#F6C445" />
      <rect x="21.3" y="9" width="3.2" height="22" rx="1.6" fill="#FFFFFF" />
      <rect x="27.2" y="14.5" width="3.2" height="11" rx="1.6" fill="#FFFFFF" fillOpacity="0.7" />
    </svg>
  );
}
