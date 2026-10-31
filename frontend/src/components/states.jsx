import { AlertTriangle, Inbox } from 'lucide-react';
import { Alert, Button, Spinner } from './ui.jsx';

export function FullPageLoader({ label = 'Loading your session' }) {
  return (
    <div className="flex min-h-screen items-center justify-center" role="status" aria-live="polite">
      <div className="flex items-center gap-3 text-sm text-muted">
        <Spinner className="text-brand" />
        {label}
      </div>
    </div>
  );
}

export function EmptyState({ title, description, action, icon: Icon = Inbox }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <span className="mb-4 grid size-11 place-items-center rounded-full border border-line bg-surface-2 text-muted">
        <Icon aria-hidden="true" size={20} />
      </span>
      <p className="text-sm font-semibold text-fg">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  const message = error?.message ?? 'Something went wrong.';

  return (
    <div className="space-y-3">
      <Alert tone="danger" title="That did not work">
        {message}
        {Array.isArray(error?.details) ? (
          <ul className="mt-2 list-disc space-y-1 pl-4">
            {error.details.map((detail) => (
              <li key={`${detail.path}-${detail.message}`}>
                {detail.path ? <span className="font-medium">{detail.path}: </span> : null}
                {detail.message}
              </li>
            ))}
          </ul>
        ) : null}
      </Alert>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <AlertTriangle aria-hidden="true" size={14} />
          Try again
        </Button>
      ) : null}
    </div>
  );
}
