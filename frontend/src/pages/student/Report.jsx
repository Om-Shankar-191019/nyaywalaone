import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download, FileJson, Printer, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { api } from '../../api/client.js';
import { useAuth } from '../../auth/AuthProvider.jsx';
import { LlmPanel } from '../../components/llm-panel.jsx';
import { CopyButton, DiffView, SuggestionList } from '../../components/report-parts.jsx';
import { ErrorState } from '../../components/states.jsx';
import { Alert, Badge, Button, Card, CardHeader, LinkButton, PageHeader } from '../../components/ui.jsx';

const statusTone = (status) =>
  status === 'ok' ? 'success' : status === 'partial' ? 'warning' : status === 'unavailable' ? 'neutral' : 'danger';

/** "unavailable" on an advisory metric means "did not run", not "failed". */
const statusLabel = (status) => (status === 'unavailable' ? 'not run' : status);

const gradeTone = (percent) => (percent >= 75 ? 'success' : percent >= 50 ? 'warning' : 'danger');

const verdict = (report) => {
  if (report.evaluation.status === 'FAILED') return { label: 'Not graded', tone: 'danger' };
  if (report.flags.suspected_infinite_loop) return { label: 'Does not finish', tone: 'danger' };
  if (report.grade.percent >= 75) return { label: 'Good', tone: 'success' };
  if (report.grade.percent >= 50) return { label: 'Needs work', tone: 'warning' };
  return { label: 'Review required', tone: 'danger' };
};

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

/** The JSON the API would return, saved without a round trip that could fail. */
function downloadJson(report, submissionId) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `report-${submissionId}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function StudentReport() {
  const { submissionId } = useParams();
  const { user } = useAuth();
  const backTo = (id) => (user?.role === 'INSTRUCTOR' ? `/instructor/assignments/${id}` : `/student/assignments/${id}`);

  const submissionQuery = useQuery({
    queryKey: ['submission', submissionId],
    queryFn: () => api.get(`/submissions/${submissionId}`),
  });

  const reportQuery = useQuery({
    queryKey: ['report', submissionId],
    queryFn: () => api.get(`/submissions/${submissionId}/report`),
    retry: false,
  });

  const payload = reportQuery.data;
  const report = payload?.json;
  const submission = submissionQuery.data?.submission;
  const assignment = submissionQuery.data?.assignment;
  const reportError = reportQuery.error;

  const ioMetric = report?.metrics.find((metric) => metric.analyzer === 'io_tests');
  const failing = ioMetric?.evidence?.failing ?? [];
  const edgeMetric = report?.metrics.find((metric) => metric.analyzer === 'edge_case_runner');
  const edgeCases = edgeMetric?.evidence?.cases ?? [];
  const badge = report ? verdict(report) : null;

  return (
    <>
      <div className="print:hidden">
        <PageHeader
          eyebrow={assignment?.title ?? 'Report'}
          title={report ? `${report.grade.percent.toFixed(2)} / 100` : 'Evaluation report'}
          description={
            report
              ? `Attempt ${report.submission.attempt} · rule set v${report.rule_set.version} · ${report.metrics.length} metrics`
              : 'Per-metric evidence, not just a number.'
          }
          action={
            <div className="flex flex-wrap items-center gap-2">
              {report ? (
                <>
                  <Button variant="secondary" size="sm" onClick={() => downloadJson(report, submissionId)}>
                    <FileJson aria-hidden="true" size={14} />
                    JSON
                  </Button>
                  <a
                    href={`${API_BASE}/submissions/${submissionId}/report.txt`}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-xs font-medium text-fg transition hover:border-brand/60"
                  >
                    <Download aria-hidden="true" size={14} />
                    Text
                  </a>
                  <Button variant="secondary" size="sm" onClick={() => window.print()}>
                    <Printer aria-hidden="true" size={14} />
                    Print
                  </Button>
                </>
              ) : null}
              <LinkButton to={backTo(assignment?.id ?? '')} variant="secondary" size="sm">
                <ArrowLeft aria-hidden="true" size={14} />
                Assignment
              </LinkButton>
            </div>
          }
        />
      </div>

      {submissionQuery.isError ? <ErrorState error={submissionQuery.error} onRetry={submissionQuery.refetch} /> : null}

      {reportError ? (
        <Alert tone={reportError.code === 'REPORT_NOT_RELEASED' ? 'info' : 'warning'} title="Report not available">
          {reportError.message}
        </Alert>
      ) : null}

      {report ? (
        <div className="grid gap-5 print:block lg:grid-cols-[1.4fr_1fr] lg:items-start">
          <div className="space-y-5">
            <Card>
              <CardHeader
                title="Metric breakdown"
                description="Weights come from the rule set; contribution is score × weight, in hundredths of a mark."
                action={badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
              />

              <div className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand" tabIndex={0} role="region" aria-label="Metric breakdown table">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">
                    Score per metric, its weight in the rule set and the marks it contributed, in rule-set order.
                  </caption>
                  <thead className="border-b border-line bg-surface-2 text-[0.6875rem] uppercase tracking-wide text-muted">
                    <tr>
                      <th scope="col" className="px-4 py-2 font-semibold">Metric</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Score</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Weight</th>
                      <th scope="col" className="px-4 py-2 font-semibold">Marks</th>
                      <th scope="col" className="px-4 py-2 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {report.metrics.map((metric) => (
                      <tr key={metric.name} className="align-top">
                        <td className="px-4 py-2.5">
                          <p className="font-medium text-fg">{metric.name}</p>
                          <p className="text-[0.6875rem] text-muted">{metric.analyzer}</p>
                          {metric.feedback ? <p className="mt-1 max-w-prose text-xs text-muted">{metric.feedback}</p> : null}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs text-fg">{metric.score.toFixed(2)}</td>
                        <td className="px-3 py-2.5 font-mono text-xs text-muted">{(metric.weight * 100).toFixed(1)}%</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-fg">{(metric.contribution / 100).toFixed(2)}</td>
                        <td className="px-4 py-2.5">
                          <Badge tone={statusTone(metric.status)}>{statusLabel(metric.status)}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t border-line bg-surface-2">
                    <tr>
                      <th scope="row" className="px-4 py-2 text-xs font-semibold text-fg">Total</th>
                      <td className="px-3 py-2" />
                      <td className="px-3 py-2" />
                      <td className="px-4 py-2 font-mono text-xs font-semibold text-fg">{report.grade.percent.toFixed(2)}</td>
                      <td className="px-4 py-2" />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Card>

            <Card>
              <CardHeader title="What to fix" description="One line per distinct issue, tied to the metric that raised it." />
              <SuggestionList metrics={report.metrics} />
            </Card>

            <LlmPanel llm={report.llm} recovery={report.recovery} />

            {failing.length ? (
              <Card>
                <CardHeader
                  title="Failing cases"
                  description="Character-level comparison. − is expected only, + is output only."
                  action={<Badge tone="danger">{failing.length}</Badge>}
                />
                <ul className="divide-y divide-line">
                  {failing.map((failure, index) => (
                    <li key={`${failure.name}-${index}`} className="space-y-2 px-5 py-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-fg">{failure.name}</p>
                        <Badge tone="danger">{failure.status}</Badge>
                      </div>
                      <div>
                        <p className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted">Input</p>
                        <pre
                          tabIndex={0}
                          role="group"
                          aria-label={`Input for ${failure.name}`}
                          className="max-h-32 overflow-auto rounded-lg border border-line bg-surface-2 p-2 font-mono text-[0.6875rem] text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                        >
                          {failure.input || '(empty)'}
                        </pre>
                      </div>
                      <DiffView expected={failure.expected ?? ''} actual={failure.got ?? ''} />
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}

            {edgeCases.length ? (
              <Card>
                <CardHeader title="Generated edge cases" description="Boundary values and crashes, checked against the reference solution." />
                <details className="px-5 py-4">
                  <summary className="cursor-pointer text-xs font-semibold text-fg">
                    Show {edgeCases.length} generated case{edgeCases.length === 1 ? '' : 's'}
                  </summary>
                  <ul className="mt-3 space-y-2">
                    {edgeCases.map((item, index) => (
                      <li key={`${item.label ?? item.case ?? index}`} className="rounded-lg border border-line bg-surface-2 p-2.5 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-fg">{item.label ?? item.case ?? `case ${index + 1}`}</span>
                          <Badge tone={item.detected ? 'danger' : 'success'}>{item.detected ? 'failed' : 'passed'}</Badge>
                          {item.oracle === false ? <Badge tone="warning">no oracle</Badge> : null}
                        </div>
                        <p className="mt-1 font-mono text-[0.6875rem] text-muted">
                          input {JSON.stringify(item.input ?? '')} · expected {JSON.stringify(item.expected ?? '')} · got{' '}
                          {JSON.stringify(item.got ?? '')}
                        </p>
                        {item.note ? <p className="mt-1 text-[0.6875rem] text-muted">{item.note}</p> : null}
                      </li>
                    ))}
                  </ul>
                </details>
              </Card>
            ) : null}
          </div>

          <div className="space-y-5">
            <Card>
              <CardHeader
                title="Reproducibility"
                description="The report hash covers stable fields only - never timings."
              />
              <div className="space-y-3 px-5 py-4 text-xs">
                <div className="flex items-start gap-2">
                  {payload?.verified === true ? (
                    <ShieldCheck aria-hidden="true" size={16} className="mt-0.5 text-success" />
                  ) : (
                    <ShieldAlert aria-hidden="true" size={16} className="mt-0.5 text-warning" />
                  )}
                  <p className="text-muted">
                    {payload?.verified === true
                      ? 'Hash verified: recomputing the report from stored evidence gives the stored hash.'
                      : (payload?.verification_note ?? 'Hash could not be verified against the stored value.')}
                  </p>
                </div>

                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-fg">Report hash</p>
                    <CopyButton value={payload?.hash ?? ''} label="Copy" />
                    <span
                      className="cursor-help text-muted underline decoration-dotted"
                      title="A SHA-256 over the grade, every metric score and every piece of evidence, in rule-set order. Two runs of the same submission with the same rule set and compiler produce this identical value, which is how a grade can be checked months later."
                    >
                      what is this?
                    </span>
                  </div>
                  <p className="break-all font-mono text-[0.6875rem] text-muted">{payload?.hash}</p>
                </div>

                <dl className="space-y-2">
                  <div>
                    <dt className="font-semibold text-fg">Evaluation key</dt>
                    <dd className="break-all font-mono text-[0.6875rem] text-muted">{report.evaluation.key}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-fg">Rules hash</dt>
                    <dd className="break-all font-mono text-[0.6875rem] text-muted">{report.rule_set.rules_hash}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-fg">Test set hash</dt>
                    <dd className="break-all font-mono text-[0.6875rem] text-muted">{report.testset.hash}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-fg">Toolchain</dt>
                    <dd className="text-muted">
                      {report.toolchain.provider} · gcc {report.toolchain.compiler_version} · {report.toolchain.pointer_bits}-bit
                    </dd>
                  </div>
                </dl>
              </div>
            </Card>

            <Card>
              <CardHeader title="Flags" description="Signals for a human, never automatic punishment." />
              <div className="flex flex-wrap gap-2 px-5 py-4">
                <Badge tone={report.flags.suspected_infinite_loop ? 'danger' : 'neutral'}>
                  infinite loop: {String(report.flags.suspected_infinite_loop)}
                </Badge>
                <Badge tone={report.flags.identical_copy ? 'danger' : 'neutral'}>
                  identical copy: {String(report.flags.identical_copy)}
                </Badge>
                <Badge tone={report.flags.no_oracle ? 'warning' : 'neutral'}>no oracle: {String(report.flags.no_oracle)}</Badge>
              </div>
              {report.flags.review_recommended.length ? (
                <p className="border-t border-line px-5 py-3 text-xs text-muted">
                  Review recommended: {report.flags.review_recommended.join(', ')}
                </p>
              ) : null}
            </Card>

            {report.limitations.length ? (
              <Card>
                <CardHeader title="Limitations" description="What this grade does not measure." />
                <ul className="list-disc space-y-1 px-9 py-4 text-xs text-muted">
                  {report.limitations.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </div>
        </div>
      ) : null}

      {submission ? (
        <p className="mt-4 text-xs text-muted print:mt-2">
          Submitted {new Date(submission.submittedAt).toLocaleString()} · {submission.filename} ·{' '}
          <Link to={`/student/submissions/${submissionId}`} className="underline decoration-dotted print:hidden">
            refresh
          </Link>
        </p>
      ) : null}
    </>
  );
}
