import { BookOpen, LayoutDashboard, LogOut } from 'lucide-react';
import { Link, NavLink, Outlet } from 'react-router';
import { useAuth } from '../auth/AuthProvider.jsx';
import { BrandMark } from './BrandMark.jsx';
import { ThemeToggle } from './ThemeToggle.jsx';
import { Badge, Button, RoleBadge } from './ui.jsx';

export function Brand({ to = '/', compact = false }) {
  return (
    <Link
      to={to}
      className="flex items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      aria-label="Nyaywala home"
    >
      <span className="relative grid size-9 place-items-center rounded-xl bg-gradient-to-br from-brand to-brand-2 text-brand-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]">
        <BrandMark size={19} strokeWidth={1.8} />
      </span>
      <span className="flex flex-col leading-none">
        <span className="text-[0.9375rem] font-semibold tracking-tight text-fg">Nyaywala</span>
        {compact ? null : (
          <span className="mt-1 text-[0.5625rem] font-semibold uppercase tracking-[0.22em] text-muted">Fair grading</span>
        )}
      </span>
    </Link>
  );
}

const navItems = (role) =>
  role === 'INSTRUCTOR'
    ? [{ to: '/instructor', label: 'Dashboard', icon: LayoutDashboard }]
    : [{ to: '/student', label: 'My courses', icon: BookOpen }];

export function AppShell() {
  const { user, logout, isLoggingOut } = useAuth();
  const items = navItems(user.role);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[16rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-brand focus:px-3 focus:py-2 focus:text-sm focus:text-brand-fg"
      >
        Skip to content
      </a>

      <aside className="hidden border-r border-line bg-surface lg:flex lg:flex-col lg:px-4 lg:py-5">
        <Brand to={user.role === 'INSTRUCTOR' ? '/instructor' : '/student'} />

        <nav aria-label="Main" className="mt-7 space-y-1">
          {items.map((item) => (
            <NavLink key={`${item.to}-${item.label}`} to={item.to} className="nav-link" end>
              <item.icon aria-hidden="true" size={16} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto rounded-xl border border-line bg-surface-2 p-3">
          <Badge tone="brand">Grading engine</Badge>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            Weighted rules, per-metric evidence and a hashed report you can reproduce.
          </p>
        </div>
      </aside>

      <div className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-10 border-b border-line bg-bg/85 backdrop-blur">
          <div className="flex items-center gap-3 px-4 py-3 lg:px-8">
            <div className="lg:hidden">
              <Brand to={user.role === 'INSTRUCTOR' ? '/instructor' : '/student'} compact />
            </div>

            <div className="ml-auto flex items-center gap-2">
              <ThemeToggle />
              <div className="hidden items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 sm:flex">
                <span className="max-w-[9rem] truncate text-xs font-medium text-fg">{user.fullName}</span>
                <RoleBadge role={user.role} />
              </div>
              <Button variant="ghost" size="sm" onClick={logout} loading={isLoggingOut} aria-label="Sign out">
                <LogOut aria-hidden="true" size={15} />
                <span className="hidden sm:inline">Sign out</span>
              </Button>
            </div>
          </div>

          <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-3 pb-2 lg:hidden">
            {items.map((item) => (
              <NavLink key={`${item.to}-${item.label}-mobile`} to={item.to} className="nav-link shrink-0 py-1.5 text-xs" end>
                <item.icon aria-hidden="true" size={14} />
                {item.label}
              </NavLink>
            ))}
          </nav>
        </header>

        <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-7 lg:px-8 lg:py-10">
          <Outlet />
        </main>

        <footer className="border-t border-line px-4 py-4 text-xs text-muted lg:px-8">
          Nyaywala v0.2.0 · grading engine · signed in as {user.email}
        </footer>
      </div>
    </div>
  );
}
