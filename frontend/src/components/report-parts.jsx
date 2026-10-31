import { Check, Copy } from 'lucide-react';
import { useMemo, useState } from 'react';
import { diffChars, diffSummary, visibleWhitespace } from '../lib/diff.js';

/**
 * Expected vs actual, character by character.
 *
 * Colour is never the only signal: removed characters carry a "-" and added
 * ones a "+", the summary is plain text, and each pane is a focusable scroll
 * region with a label, so the comparison works with a screen reader or a
 * monochrome printout.
 */
export function DiffView({ expected, actual }) {
  const segments = useMemo(() => diffChars(expected, actual), [expected, actual]);
  const summary = useMemo(() => diffSummary(segments), [segments]);

  const expectedSpans = segments.filter((segment) => segment.type !== 'ins');
  const actualSpans = segments.filter((segment) => segment.type !== 'del');
  const identical = !segments.some((segment) => segment.type !== 'same');

  const pane = (spans, side) => (
    <div className="min-w-0">
      <p className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted">{side === 'expected' ? 'Expected' : 'Your output'}</p>
      <pre
        tabIndex={0}
        role="group"
        aria-label={`${side === 'expected' ? 'Expected' : 'Your'} output${spans.length ? '' : ': empty'}`}
        className="max-h-56 overflow-auto rounded-lg border border-line bg-surface-2 p-2.5 font-mono text-[0.6875rem] leading-relaxed text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        {spans.length === 0 ? (
          <span className="text-muted">(empty)</span>
        ) : (
          spans.map((span, index) => (
            <span
              key={`${span.type}-${index}`}
              className={
                span.type === 'same'
                  ? undefined
                  : side === 'expected'
                    ? 'rounded bg-danger/20 text-danger decoration-danger/70 line-through'
                    : 'rounded bg-success/20 text-success'
              }
            >
              {visibleWhitespace(span.text)}
            </span>
          ))
        )}
      </pre>
    </div>
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-[0.6875rem] text-muted">
        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true" className="font-mono font-bold text-danger">
            −
          </span>
          expected only
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true" className="font-mono font-bold text-success">
            +
          </span>
          produced only
        </span>
        {identical ? <span className="text-success">Input and output are identical.</span> : null}
      </div>
      <p className="text-[0.6875rem] text-muted">{summary}</p>
      <div className={identical ? 'grid gap-3' : 'grid gap-3 sm:grid-cols-2'}>
        {pane(expectedSpans, 'expected')}
        {identical ? null : pane(actualSpans, 'actual')}
      </div>
    </div>
  );
}

/** Copy-to-clipboard with a confirmation that does not shift the layout. */
export function CopyButton({ value, label = 'Copy', copiedLabel = 'Copied' }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(String(value ?? ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be denied (insecure origin, permissions). Saying so
      // is better than a button that silently does nothing.
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex h-6 items-center gap-1 rounded border border-line bg-surface px-1.5 text-[0.6875rem] font-medium text-muted transition hover:border-brand/60 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      title={`${label}: ${value}`}
    >
      {copied ? <Check aria-hidden="true" size={11} /> : <Copy aria-hidden="true" size={11} />}
      {copied ? copiedLabel : label}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied to the clipboard' : ''}
      </span>
    </button>
  );
}

/**
 * One actionable line per metric, de-duplicated.
 *
 * Two metrics often say the same thing ("compile with -Wall", "compile cleanly"),
 * and repeating it wastes the student's attention. The metric name stays attached
 * so the advice can be traced back to the rule that produced it.
 */
export function SuggestionList({ metrics }) {
  const suggestions = useMemo(() => {
    const seen = new Map();
    for (const metric of metrics ?? []) {
      const text = String(metric.feedback ?? '').trim();
      if (!text) continue;
      if (metric.status === 'ok' && metric.score >= 0.99) continue;
      if (!seen.has(text)) seen.set(text, { text, metrics: [metric.name] });
      else seen.get(text).metrics.push(metric.name);
    }
    return [...seen.values()];
  }, [metrics]);

  if (!suggestions.length) {
    return <p className="px-5 py-4 text-sm text-muted">Nothing to fix: every metric scored full marks.</p>;
  }

  return (
    <ul className="divide-y divide-line">
      {suggestions.map((suggestion) => (
        <li key={suggestion.text} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-5 py-3 text-sm">
          <span className="text-fg">{suggestion.text}</span>
          <span className="font-mono text-[0.6875rem] text-muted">{suggestion.metrics.join(', ')}</span>
        </li>
      ))}
    </ul>
  );
}
