import { Link } from 'react-router';
import { Brand } from '../components/AppShell.jsx';
import { ThemeToggle } from '../components/ThemeToggle.jsx';
import { LinkButton } from '../components/ui.jsx';

export function NotFound() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between px-5 py-5">
        <Brand />
        <ThemeToggle />
      </header>
      <main className="flex flex-1 items-center justify-center px-5 pb-16">
        <div className="text-center">
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted">404</p>
          <h1 className="mt-2 text-2xl font-semibold text-fg">That page does not exist</h1>
          <p className="mt-2 text-sm text-muted">The link may be outdated, or the page may arrive in a later week.</p>
          <div className="mt-6 flex justify-center gap-2">
            <LinkButton to="/">Home</LinkButton>
            <Link to="/login" className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-fg">
              Sign in
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
