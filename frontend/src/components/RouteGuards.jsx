import { ShieldAlert } from 'lucide-react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { dashboardPath, useAuth } from '../auth/AuthProvider.jsx';
import { FullPageLoader } from './states.jsx';
import { Card, LinkButton } from './ui.jsx';

export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <FullPageLoader />;
  if (status === 'anonymous') {
    // Remember where they were going, so login can send them back there.
    return <Navigate to="/login" state={{ from: `${location.pathname}${location.search}` }} replace />;
  }

  return <Outlet />;
}

/**
 * A student typing /instructor gets an explanation, not a redirect loop and
 * not a blank 403. The page tells them where they can go instead.
 */
export function RequireRole({ allow }) {
  const { user } = useAuth();
  if (!user) return null; // RequireAuth owns the anonymous case

  if (user.role !== allow) {
    return (
      <Card className="mx-auto max-w-lg p-8 text-center">
        <span className="mx-auto mb-4 grid size-12 place-items-center rounded-full border border-warning/40 bg-warning/10 text-warning">
          <ShieldAlert aria-hidden="true" size={22} />
        </span>
        <h1 className="text-lg font-semibold text-fg">This area is for {allow === 'INSTRUCTOR' ? 'instructors' : 'students'}</h1>
        <p className="mt-2 text-sm text-muted">
          You are signed in as a {user.role === 'INSTRUCTOR' ? 'instructor' : 'student'}. Your own dashboard is one click away.
        </p>
        <div className="mt-6 flex justify-center">
          <LinkButton to={dashboardPath(user.role)}>Go to my dashboard</LinkButton>
        </div>
      </Card>
    );
  }

  return <Outlet />;
}
