import { Badge, Card, CardHeader } from './ui.jsx';

/**
 * The four optional language-model reviews, shown as advice.
 *
 * Every sentence on this panel is advisory: none of it moves a mark except the
 * compile-error recovery block, which says so in its own heading. Showing that
 * distinction is the point of the panel - a student should never have to guess
 * which paragraph changed their grade.
 */

const verdictTone = (verdict) =>
  verdict === 'likely_original' ? 'success' : verdict === 'inconclusive' ? 'neutral' : verdict === 'review_recommended' ? 'warning' : 'danger';

const verdictLabel = (verdict) =>
  ({
    likely_original: 'No signal',
    inconclusive: 'Inconclusive',
    review_recommended: 'Review recommended',
    strong_signal: 'Strong signal',
  })[verdict] ?? verdict;

const percent = (value) => `${Math.round(Number(value ?? 0) * 100)}%`;

const unavailableReason = (entry) => {
  const reason = entry?.evidence?.reason;
  if (!reason) return 'did not run';
  return (
    {
      not_configured: 'no API key configured',
      disabled: 'switched off on this server',
      rate_limited: 'free tier rate limit reached',
      auth_failed: 'the API key was rejected',
      model_missing: 'no model on this key was available',
      timeout: 'the provider timed out',
      network_error: 'the provider was unreachable',
      bad_json: 'the provider answered without JSON',
      compile_error: 'the program did not compile, so there were no marks to write about',
    }[reason] ?? String(reason)
  );
};

function Section({ title, children, aside }) {
  return (
    <div className="space-y-2 border-t border-line px-5 py-4 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
        {aside}
      </div>
      {children}
    </div>
  );
}

function List({ items }) {
  if (!items?.length) return <p className="text-xs text-muted">Nothing recorded.</p>;
  return (
    <ul className="space-y-1 text-sm text-fg">
      {items.map((item, index) => (
        <li key={`${item}-${index}`} className="flex gap-2">
          <span aria-hidden="true" className="mt-1.5 size-1 shrink-0 rounded-full bg-brand" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

const CRITERIA = [
  ['naming', 'Naming'],
  ['formatting', 'Formatting'],
  ['comments', 'Comments'],
  ['structure', 'Structure'],
  ['error_handling', 'Error handling'],
];

export function LlmPanel({ llm, recovery }) {
  if (!llm && !recovery) return null;

  const feedback = llm?.feedback;
  const readability = llm?.readability;
  const originality = llm?.originality;
  const recoveryMetric = llm?.recovery;
  const review = recovery ?? null;

  const noneRan = llm && !llm.available;

  return (
    <Card>
      <CardHeader
        title="AI review"
        description="Advice from a language model, on top of the measured metrics. Excluded from the report hash."
        action={<Badge tone={noneRan ? 'neutral' : 'success'}>{noneRan ? 'not run' : 'advisory'}</Badge>}
      />

      {llm?.provider ? (
        <p className="px-5 pt-3 text-[0.6875rem] text-muted">
          Answered by {llm.provider} · {llm.model}
        </p>
      ) : null}

      {noneRan ? (
        <p className="px-5 py-4 text-sm text-muted">
          The language-model checks did not run ({unavailableReason(feedback ?? readability ?? originality)}). Nothing is missing from the grade: these
          metrics carry no weight. Run <code className="font-mono text-[0.6875rem]">npm run llm:check</code> in the backend to see which provider is reachable.
        </p>
      ) : null}

      {feedback?.status === 'ok' ? (
        <Section title="Written feedback">
          <p className="text-sm text-fg">{feedback.evidence?.summary ?? feedback.feedback}</p>
          {feedback.evidence?.strengths?.length ? (
            <div className="pt-1">
              <p className="mb-1 text-[0.6875rem] font-semibold text-success">What works</p>
              <List items={feedback.evidence.strengths} />
            </div>
          ) : null}
          {feedback.evidence?.improvements?.length ? (
            <div className="pt-1">
              <p className="mb-1 text-[0.6875rem] font-semibold text-warning">What to improve</p>
              <List items={feedback.evidence.improvements} />
            </div>
          ) : null}
          {feedback.evidence?.next_steps?.length ? (
            <div className="pt-1">
              <p className="mb-1 text-[0.6875rem] font-semibold text-fg">Next</p>
              <List items={feedback.evidence.next_steps} />
            </div>
          ) : null}
        </Section>
      ) : null}

      {readability?.status === 'ok' ? (
        <Section
          title="Readability"
          aside={<Badge tone="neutral">{readability.evidence?.score_out_of_10 ?? '?'} / 10</Badge>}
        >
          <dl className="grid gap-2 sm:grid-cols-2">
            {CRITERIA.map(([key, label]) => {
              const entry = readability.evidence?.criteria?.[key];
              if (!entry) return null;
              return (
                <div key={key} className="rounded-lg border border-line bg-surface-2 p-2.5">
                  <dt className="flex items-baseline justify-between gap-2 text-xs font-semibold text-fg">
                    {label}
                    <span className="font-mono text-[0.6875rem] text-muted">{entry.score ?? '-'}/10</span>
                  </dt>
                  {entry.note ? <dd className="mt-1 text-xs text-muted">{entry.note}</dd> : null}
                </div>
              );
            })}
          </dl>
          {readability.evidence?.top_issues?.length ? <List items={readability.evidence.top_issues} /> : null}
        </Section>
      ) : null}

      {originality ? (
        <Section
          title="Originality"
          aside={
            <Badge tone={verdictTone(originality.evidence?.verdict)}>
              {verdictLabel(originality.evidence?.verdict)} · {percent(originality.evidence?.combined)}
            </Badge>
          }
        >
          <div className="grid gap-2 text-xs text-muted sm:grid-cols-3">
            <p>
              Looks generated: <span className="font-mono text-fg">{percent(originality.evidence?.ai_likelihood)}</span>
            </p>
            <p>
              Looks copied from a tutorial: <span className="font-mono text-fg">{percent(originality.evidence?.copy_likelihood)}</span>
            </p>
            <p>
              Most similar classmate: <span className="font-mono text-fg">{percent(originality.evidence?.peer_similarity)}</span>
            </p>
          </div>
          {originality.evidence?.indicators?.length ? <List items={originality.evidence.indicators} /> : null}
          <p className="text-[0.6875rem] text-muted">
            {originality.evidence?.note ??
              'A signal is a reason to look, not a finding of misconduct. No live internet search was performed.'}
            {originality.status === 'partial' ? ' This result used the deterministic checks only.' : ''}
          </p>
        </Section>
      ) : null}

      {review ? (
        <Section
          title="Compile-error recovery"
          aside={
            <Badge tone={review.awarded_hundredths > 0 ? 'warning' : 'neutral'}>
              {review.awarded_hundredths > 0 ? `+${(review.awarded_hundredths / 100).toFixed(2)} marks` : 'no marks awarded'}
            </Badge>
          }
        >
          <p className="text-sm text-fg">{review.explanation}</p>
          <p className="text-[0.6875rem] text-muted">
            Logic judged {review.logic_sound ? 'sound' : 'incomplete'} with {percent(review.confidence)} confidence. Up to{' '}
            {Math.round(review.max_credit * 100)} marks can be recovered from a program that never compiled; these marks come from a reading of the code, not
            from a test run.
          </p>
          {review.errors?.length ? (
            <ul className="space-y-2">
              {review.errors.map((error, index) => (
                <li key={`${error.message}-${index}`} className="rounded-lg border border-line bg-surface-2 p-2.5 text-xs">
                  {error.message ? <p className="font-mono text-[0.6875rem] text-danger">{error.message}</p> : null}
                  {error.explanation ? <p className="mt-1 text-muted">{error.explanation}</p> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {review.corrected_source ? (
            <details className="text-xs">
              <summary className="cursor-pointer font-semibold text-fg">Show a version that compiles</summary>
              <pre
                tabIndex={0}
                aria-label="Corrected source suggested by the language model"
                className="mt-2 max-h-72 overflow-auto rounded-lg border border-line bg-surface-2 p-2.5 font-mono text-[0.6875rem] leading-relaxed text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                {review.corrected_source}
              </pre>
              <p className="mt-1 text-[0.6875rem] text-muted">
                Suggested by {'a language model'} - not stored as your submission. Copy it, compile it yourself, then resubmit.
              </p>
            </details>
          ) : null}
          {recoveryMetric && recoveryMetric.status !== 'ok' ? (
            <p className="text-[0.6875rem] text-muted">The recovery review itself did not run ({unavailableReason(recoveryMetric)}).</p>
          ) : null}
        </Section>
      ) : null}
    </Card>
  );
}
