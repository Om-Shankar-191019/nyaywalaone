import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download, ShieldCheck, ShieldAlert } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { api } from '../../api/client.js';
import { useAuth } from '../../auth/AuthProvider.jsx';
import { ErrorState } from '../../components/states.jsx';
import { Alert, Badge, Card, CardHeader, LinkButton, PageHeader } from '../../components/ui.jsx';

const statusTone = (status) =>
  status === 'ok' ? 'success' : status === 'partial' ? 'warning' : status === 'unavailable' ? 'neutral' : 'danger';

const gradeTone = (percent) => (percent >= 75 ? 'success' : percent >= 50 ? 'warning' : 'danger');

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

  const report = reportQuery.data?.json;
  const submission = submissionQuery.data?.submission;
  const assignment = submissionQuery.data?.assignment;
  const reportError = reportQuery.error;

  return (
    <>
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
              <a
                href={`${(import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')}/submissions/${submissionId}/report.txt`}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-xs font-medium text-fg transition hover:border-brand/60"
              >
                <Download aria-hidden="true" size={14} />
                Download .txt
              </a>
            ) : null}
            <LinkButton to={backTo(assignment?.id ?? '')} variant="secondary" size="sm">
              <ArrowLeft aria-hidden="true" size={14} />
              Assignment
            </LinkButton>
          </div>
        }
      />

      {submissionQuery.isError ? <ErrorState error={submissionQuery.error} onRetry={submissionQuery.refetch} /> : null}

      {reportError ? (
        <Alert tone={reportError.code === 'REPORT_NOT_RELEASED' ? 'info' : 'warning'} title="Report not available">
          {reportError.message}
        </Alert>
      ) : null}

      {report ? (
        <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr] lg:items-start">
          <Card>
            <CardHeader
              title="Metric breakdown"
              description="Weights are the rule set's; contribution is score × weight."
              action={<Badge tone={gradeTone(report.grade.percent)}>{report.grade.percent.toFixed(2)}%</Badge>}
            />

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-line bg-surface-2 text-[0.6875rem] uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Metric</th>
                    <th className="px-3 py-2 font-semibold">Score</th>
                    <th className="px-3 py-2 font-semibold">Weight</th>
                    <th className="px-3 py-2 font-semibold">Contribution</th>
                    <th className="px-4 py-2 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {report.metrics.map((metric) => (
                    <tr key={metric.name} className="align-top">
                      <td className="px-4 py-2.5">
                        <p className="font-medium text-fg">{metric.name}</p>
                        <p className="text-[0.6875rem] text-muted">{metric.analyzer}</p>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs text-fg">{metric.score.toFixed(2)}</td>
                      <td className="px-3 py-2.5 font-mono text-xs text-muted">{(metric.weight * 100).toFixed(1)}%</td>
                      <td className="px-3 py-2.5 font-mono text-xs text-fg">{(metric.contribution / 100).toFixed(2)}</td>
                      <td className="px-4 py-2.5">
                        <Badge tone={statusTone(metric.status)}>{metric.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-2 border-t border-line p-4">
              {report.metrics
                .filter((metric) => metric.feedback)
                .map((metric) => (
                  <details key={metric.name} className="rounded-lg border border-line bg-surface-2 px-3 py-2">
                    <summary className="cursor-pointer text-xs font-semibold text-fg">
                      {metric.name}: {metric.feedback}
                    </summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded bg-surface p-2 font-mono text-[0.6875rem] leading-relaxed text-muted">
                      {JSON.stringify(metric.evidence, null, 2)}
                    </pre>
                  </details>
                ))}
            </div>
          </Card>

          <div className="space-y-5">
            <Card>
              <CardHeader title="Reproducibility" description="The report hash is over stable fields only." />
              <div className="space-y-3 px-5 py-4 text-xs">
                <div className="flex items-start gap-2">
                  {reportQuery.data?.verified ? (
                    <ShieldCheck aria-hidden="true" size={16} className="mt-0.5 text-success" />
                  ) : (
                    <ShieldAlert aria-hidden="true" size={16} className="mt-0.5 text-warning" />
                  )}
                  <p className="text-muted">
                    {reportQuery.data?.verified
                      ? 'Hash verified: recomputing the report from stored evidence gives the stored hash.'
                      : 'Hash could not be verified against the stored value.'}
                  </p>
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
                      gcc {report.toolchain.compiler_version} · {report.toolchain.provider} · {report.toolchain.pointer_bits}-bit
                    </dd>
                  </div>
                </dl>
              </div>
            </Card>

            {report.metrics
              .filter((metric) => metric.analyzer === 'io_tests')
              .map((metric) => {
                const failing = metric.evidence?.failing ?? [];
                if (!failing.length) return null;
                return (
                  <Card key="failing">
                    <CardHeader title="Failing cases" description="At least one complete case is always shown." />
                    <ul className="divide-y divide-line">
                      {failing.map((failure) => (
                        <li key={failure.name} className="px-5 py-3 text-xs">
                          <p className="font-semibold text-fg">
                            {failure.name} · <span className="font-normal text-danger">{failure.status}</span>
                          </p>
                          <pre className="mt-1.5 overflow-x-auto rounded bg-surface-2 p-2 font-mono text-[0.6875rem] text-muted">
                            input: {JSON.stringify(failure.input)}
                            {'\n'}expected: {JSON.stringify(failure.expected)}
                            {'\n'}got: {JSON.stringify(failure.got)}
                          </pre>
                        </li>
                      ))}
                    </ul>
                  </Card>
                );
              })}

            <Card>
              <CardHeader title="Flags" description="Signals for a human, never automatic punishment." />
              <div className="flex flex-wrap gap-2 px-5 py-4">
                <Badge tone={report.flags.suspected_infinite_loop ? 'danger' : 'neutral'}>
                  infinite loop: {String(report.flags.suspected_infinite_loop)}
                </Badge>
                <Badge tone={report.flags.identical_copy ? 'danger' : 'neutral'}>identical copy: {String(report.flags.identical_copy)}</Badge>
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
                <CardHeader title="Limitations" />
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
        <p className="mt-4 text-xs text-muted">
          Submitted {new Date(submission.submittedAt).toLocaleString()} · {submission.filename} ·{' '}
          <Link to={`/student/submissions/${submissionId}`} className="underline decoration-dotted">
            refresh
          </Link>
        </p>
      ) : null}
    </>
  );
}
