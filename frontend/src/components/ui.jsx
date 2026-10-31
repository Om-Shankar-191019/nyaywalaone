import { forwardRef } from 'react';
import { Link } from 'react-router';

export const cx = (...parts) => parts.filter(Boolean).join(' ');

const BUTTON_VARIANTS = {
  primary: 'bg-brand text-brand-fg hover:opacity-90',
  secondary: 'border border-line bg-surface text-fg hover:border-brand/60 hover:text-fg',
  ghost: 'text-muted hover:bg-surface-2 hover:text-fg',
  danger: 'bg-danger text-white hover:opacity-90',
};

const BUTTON_SIZES = {
  sm: 'h-8 gap-1.5 px-3 text-xs',
  md: 'h-10 gap-2 px-4 text-sm',
  lg: 'h-11 gap-2 px-5 text-sm',
};

export function Spinner({ className }) {
  return (
    <span
      aria-hidden="true"
      className={cx('inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent', className)}
    />
  );
}

export const Button = forwardRef(function Button(
  { variant = 'primary', size = 'md', loading = false, className, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={props.type ?? 'button'}
      disabled={disabled || loading}
      className={cx(
        'inline-flex select-none items-center justify-center rounded-lg font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-55',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
});

/** A link that looks like a button, without nesting <button> inside <a>. */
export function LinkButton({ to, variant = 'primary', size = 'md', className, children, ...props }) {
  return (
    <Link
      to={to}
      className={cx(
        'inline-flex select-none items-center justify-center rounded-lg font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    >
      {children}
    </Link>
  );
}

export const Input = forwardRef(function Input({ className, invalid = false, ...props }, ref) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cx(
        'h-10 w-full rounded-lg border bg-surface px-3 text-sm text-fg placeholder:text-muted/70 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-0',
        invalid ? 'border-danger' : 'border-line hover:border-muted/50',
        className,
      )}
      {...props}
    />
  );
});

export function Field({ label, htmlFor, error, hint, children }) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1.5 text-xs font-medium text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="hint">{hint}</p>
      ) : null}
    </div>
  );
}

export function Card({ className, children, ...props }) {
  return (
    <div className={cx('card', className)} {...props}>
      {children}
    </div>
  );
}

export function CardHeader({ title, description, action }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
      <div>
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

const BADGE_TONES = {
  neutral: 'border-line bg-surface-2 text-muted',
  brand: 'border-brand/30 bg-brand/10 text-brand',
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  danger: 'border-danger/30 bg-danger/10 text-danger',
};

export function Badge({ tone = 'neutral', className, children }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-wide',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function RoleBadge({ role }) {
  return <Badge tone={role === 'INSTRUCTOR' ? 'brand' : 'neutral'}>{role === 'INSTRUCTOR' ? 'Instructor' : 'Student'}</Badge>;
}

export function Alert({ tone = 'danger', title, children }) {
  const tones = {
    danger: 'border-danger/40 bg-danger/10 text-danger',
    warning: 'border-warning/40 bg-warning/10 text-warning',
    info: 'border-line bg-surface-2 text-muted',
    success: 'border-success/30 bg-success/10 text-success',
  };

  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cx('rounded-lg border px-3 py-2.5 text-sm', tones[tone])}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={cx(title && 'mt-1', 'text-[0.8125rem] leading-relaxed')}>{children}</div> : null}
    </div>
  );
}

export function PageHeader({ eyebrow, title, description, action }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow ? <p className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted">{eyebrow}</p> : null}
        <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
        {description ? <p className="mt-1.5 max-w-2xl text-sm text-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
