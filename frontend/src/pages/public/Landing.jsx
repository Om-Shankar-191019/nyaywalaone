import { Braces, Fingerprint, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router';
import { dashboardPath, useAuth } from '../../auth/AuthProvider.jsx';
import { Brand } from '../../components/AppShell.jsx';
import { BrandMark } from '../../components/BrandMark.jsx';
import { ThemeToggle } from '../../components/ThemeToggle.jsx';
import { Badge, LinkButton } from '../../components/ui.jsx';

const FEATURES = [
  {
    icon: ShieldCheck,
    tone: 'text-brand',
    title: 'Sandboxed C execution',
    body: 'Every program is compiled and run with CPU, wall-clock, memory and process limits - never on the API host.',
  },
  {
    icon: Braces,
    tone: 'text-brand-2',
    title: 'Rules, not opinions',
    body: 'Instructors weight correctness, structure, readability and originality. The report shows the contribution of each.',
  },
  {
    icon: Fingerprint,
    tone: 'text-success',
    title: 'One grade, twice',
    body: 'Source, rules and test set are hashed into an evaluation key, so the same submission always earns the same mark.',
  },
];

const READY = [
  'Ten analyzers behind one contract, run in the rule set’s order',
  'Correctness on trusted tests, with the first failing case shown in full',
  'Structure and modularity from a real C parse tree, not regex guesses',
  'Boundary cases checked against the instructor’s reference solution',
  'Memory audit and complexity class, scored without wall-clock flakiness',
  'Hash-keyed reports: the same submission returns the stored result',
];

export function Landing() {
  const { status, user } = useAuth();

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <Brand />
        <div className="flex items-center gap-2">
          <ThemeToggle />
          {status === 'authenticated' ? (
            <LinkButton to={dashboardPath(user.role)} size="sm">
              Dashboard
            </LinkButton>
          ) : (
            <>
              <Link to="/login" className="rounded-lg px-3 py-2 text-sm font-medium text-muted transition hover:text-fg">
                Sign in
              </Link>
              <LinkButton to="/register" size="sm">
                Get started
              </LinkButton>
            </>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5">
        <section className="grid items-center gap-12 py-12 sm:py-16 lg:grid-cols-[1.5fr_1fr]">
          <div>
            <Badge tone="brand">Rule-driven grading engine</Badge>
            <h1 className="mt-4 max-w-2xl text-3xl font-semibold leading-[1.08] tracking-tight text-fg sm:text-5xl">
              Fair marks for C assignments, <span className="brand-gradient-text">the same way twice.</span>
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted sm:text-base">
              Nyaywala compiles real student code in a locked-down sandbox, applies the instructor&apos;s weighted rules, and
              produces a report that explains every mark - the failing input, the expected output, the evidence behind each
              metric, and the hash that proves the run.
            </p>

            <div className="mt-7 flex flex-wrap items-center gap-3">
              <LinkButton to={status === 'authenticated' ? dashboardPath(user.role) : '/login'} size="lg">
                {status === 'authenticated' ? 'Open dashboard' : 'Sign in'}
              </LinkButton>
              <LinkButton to="/register" variant="secondary" size="lg">
                Create an account
              </LinkButton>
            </div>

            <p className="mt-3 text-xs text-muted">
              Demo accounts are printed by <span className="code">npm run db:seed</span> in the backend.
            </p>
          </div>

          <div className="relative hidden lg:block">
            <div className="paper-grid absolute -inset-6 -z-10 rounded-[2.5rem] opacity-70" aria-hidden="true" />
            <div className="card overflow-hidden p-5">
              <div className="flex items-center gap-1.5" aria-hidden="true">
                <span className="size-2 rounded-full bg-brand" />
                <span className="size-2 rounded-full bg-brand-2" />
                <span className="size-2 rounded-full bg-success" />
              </div>
              <div className="mt-5 grid place-items-center rounded-xl border border-line bg-surface-2 py-12 text-brand">
                <BrandMark size={112} strokeWidth={0.9} title="Nyaywala - the balance" />
              </div>
              <p className="mt-5 text-[0.6875rem] font-semibold uppercase tracking-[0.22em] text-muted">
                Nyaya · the fair mark
              </p>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                A scale is only honest if it is consistent. Source, rules, tests and toolchain are hashed into one key, so a
                regrade returns the stored result instead of a second opinion.
              </p>
            </div>
          </div>
        </section>

        <section className="grid gap-4 pb-12 sm:grid-cols-3">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="card p-5">
              <span className={`grid size-9 place-items-center rounded-lg border border-line bg-surface-2 ${feature.tone}`}>
                <feature.icon aria-hidden="true" size={17} />
              </span>
              <h2 className="mt-3 text-sm font-semibold text-fg">{feature.title}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{feature.body}</p>
            </div>
          ))}
        </section>

        <section className="card mb-14 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-fg">What works in this build</h2>
            <Badge tone="success">report hash verified</Badge>
          </div>
          <ul className="mt-3 grid gap-2 text-sm text-muted sm:grid-cols-2">
            {READY.map((item) => (
              <li key={item} className="flex gap-2">
                <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand-2" />
                {item}
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="border-t border-line px-5 py-6 text-center text-xs text-muted">
        Nyaywala · nyaya, &ldquo;justice&rdquo; · reproducible grading for C programming courses
      </footer>
    </div>
  );
}
