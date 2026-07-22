import { ReactNode } from 'react';

/**
 * Shared page scaffolding. Server-component safe (CSS animations only) so both
 * server pages (course detail) and client pages can use it.
 */

export function PageShell({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`page-shell relative ${className}`}>
      {/* soft ambient glow */}
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 overflow-hidden">
        <div className="absolute -top-24 left-1/4 h-72 w-72 rounded-full bg-brand-500/10 blur-3xl" />
        <div className="absolute -top-10 right-1/5 h-56 w-56 rounded-full bg-brand-400/10 blur-3xl" />
      </div>
      {children}
    </div>
  );
}

export function PageHeader({
  badge,
  title,
  subtitle,
  actions,
}: {
  badge?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4 animate-fade-in-up">
      <div className="min-w-0">
        {badge && <div className="mb-3">{badge}</div>}
        <h1 className="text-3xl font-extrabold tracking-tight text-foreground md:text-4xl">{title}</h1>
        {subtitle && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-gray-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Consistent dark-mode-aware badge for entity lifecycle statuses. */
const STATUS_STYLE: Record<string, string> = {
  draft: 'badge-neutral',
  institution_review: 'badge-info',
  submitted: 'badge-warn',
  under_review: 'badge-warn',
  published: 'badge-success',
  flagged: 'badge-danger',
  unlisted: 'badge-neutral',
  archived: 'badge-neutral',
  active: 'badge-success',
  suspended: 'badge-warn',
  banned: 'badge-danger',
  confirmed: 'badge-success',
  pending: 'badge-warn',
  initiated: 'badge-warn',
  failed: 'badge-danger',
  refunded: 'badge-neutral',
  paid: 'badge-success',
  held: 'badge-warn',
  approved: 'badge-success',
  denied: 'badge-danger',
};

export function StatusBadge({ status, suffix }: { status: string; suffix?: string }) {
  return (
    <span className={STATUS_STYLE[status] ?? 'badge-neutral'}>
      {status.replace(/_/g, ' ')}
      {suffix ? ` · ${suffix}` : ''}
    </span>
  );
}

/** Centered narrow column for auth-style pages, with glow + brand mark. */
export function AuthShell({
  icon,
  title,
  subtitle,
  children,
  footer,
}: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="page-shell relative flex min-h-[80vh] flex-col items-center justify-center !pb-12">
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute left-1/2 top-24 h-72 w-72 -translate-x-1/2 rounded-full bg-brand-500/10 blur-3xl" />
        <div className="absolute bottom-10 right-1/4 h-56 w-56 rounded-full bg-brand-400/10 blur-3xl" />
      </div>

      <div className="w-full max-w-md animate-fade-in-up">
        <div className="mb-6 text-center">
          {icon && (
            <span className="gradient-bg-blue glow-blue relative mx-auto mb-4 flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl text-white shadow-floating">
              {icon}
              <span className="gradient-ethiopia absolute bottom-0 left-0 h-[3px] w-full opacity-90" />
            </span>
          )}
          <h1 className="text-2xl font-extrabold tracking-tight text-foreground md:text-3xl">{title}</h1>
          {subtitle && <p className="mt-2 text-sm leading-relaxed text-gray-500">{subtitle}</p>}
        </div>
        <div className="card !rounded-3xl !p-6 shadow-elevated sm:!p-8">{children}</div>
        {footer && <div className="mt-5 text-center text-sm text-gray-500">{footer}</div>}
      </div>
    </div>
  );
}
