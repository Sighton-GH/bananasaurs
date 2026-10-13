import { useId, type ReactElement, type ReactNode } from 'react';
import { Link as RouterLink } from 'wouter';
import { Icon, IconExternal } from './icons.js';
const CLASS =
  'text-accent underline underline-offset-2 hover:no-underline focus-visible:outline-accent';
/** Internal paths route in-app; http(s) opens a new tab. Other schemes are plain text. */
export function Link({
  href,
  children,
  className = '',
}: {
  readonly href: string;
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement {
  const labelId = useId();
  const noticeId = `${labelId}-notice`;
  // Browsers normalize tabs, CR and LF; reject all controls and backslashes
  // so internal-looking paths cannot become protocol-relative URLs.
  if (
    /^\/(?!\/)/.test(href) &&
    !href.includes('\\') &&
    !Array.from(href).some((char) => char.charCodeAt(0) < 32)
  )
    return (
      <RouterLink href={href} className={`${CLASS} ${className}`}>
        {children}
      </RouterLink>
    );
  if (/^https?:\/\//i.test(href))
    return (
      <a
        href={href}
        aria-labelledby={`${labelId} ${noticeId}`}
        target="_blank"
        rel="noreferrer"
        className={`${CLASS} inline-flex items-center gap-0.5 ${className}`}
      >
        <span id={labelId}>{children}</span>
        <Icon icon={IconExternal} className="size-3.5" />
        <span id={noticeId} className="sr-only">
          {' '}
          (opens in a new tab)
        </span>
      </a>
    );
  return <span className={className}>{children}</span>;
}
