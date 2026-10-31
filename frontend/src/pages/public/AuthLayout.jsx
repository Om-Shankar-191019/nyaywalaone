import { Brand } from '../../components/AppShell.jsx';
import { ThemeToggle } from '../../components/ThemeToggle.jsx';

export function AuthLayout({ title, subtitle, children, footer }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between px-5 py-5 sm:px-8">
        <Brand />
        <ThemeToggle />
      </header>

      <main className="flex flex-1 items-start justify-center px-4 pb-16 pt-4 sm:items-center sm:pt-0">
        <div className="w-full max-w-sm">
          <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
          {subtitle ? <p className="mt-1.5 text-sm text-muted">{subtitle}</p> : null}

          <div className="card mt-6 p-5">{children}</div>

          {footer ? <div className="mt-5 text-center text-sm text-muted">{footer}</div> : null}
        </div>
      </main>
    </div>
  );
}
