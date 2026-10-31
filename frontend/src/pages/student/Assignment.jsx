import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, FileCode2, RefreshCw, Send, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../../api/client.js';
import { CodeEditor } from '../../components/CodeEditor.jsx';
import { ErrorState } from '../../components/states.jsx';
import { Alert, Badge, Button, Card, CardHeader, Field, LinkButton, PageHeader, Spinner } from '../../components/ui.jsx';
import { MAX_SOURCE_BYTES, STAGE_DETAIL, STAGE_LABEL, STAGE_ORDER, useGradingPoll, validateSubmission } from '../../lib/grading.js';

const STARTER = `#include <stdio.h>

int main(void) {
    /* Read the input described above and print the answer. */
    return 0;
}
`;

const formatDate = (value) =>
  value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;

const statusTone = (status) =>
  status === 'SUCCEEDED' ? 'success' : status === 'PARTIAL' ? 'warning' : status === 'FAILED' ? 'danger' : 'neutral';

const TERMINAL = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED']);

/**
 * Named steps, not a percentage. A grade is not predictable, so the honest
 * progress signal is *which* stage the run is in - the plan bans an optimistic
 * UI here for exactly that reason.
 */
function StageTracker({ stage, status }) {
  const finished = TERMINAL.has(status);
  const currentIndex = finished ? STAGE_ORDER.length : Math.max(0, STAGE_ORDER.indexOf(stage ?? 'queued'));
  const failed = status === 'FAILED';

  return (
    <div className="space-y-3">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-2" aria-label="Grading progress">
        {STAGE_ORDER.map((step, index) => {
          const done = index < currentIndex || finished;
          const active = index === currentIndex && !finished;
          return (
            <li key={step} className="flex items-center gap-2">
              <span
                className={[
                  'grid size-6 shrink-0 place-items-center rounded-full border text-[0.625rem] font-semibold',
                  done
                    ? 'border-brand bg-brand text-on-brand'
                    : active
                      ? 'border-brand text-brand'
                      : 'border-line text-muted',
                ].join(' ')}
                aria-hidden="true"
              >
                {done ? <Check size={12} /> : index + 1}
              </span>
              <span
                className={[
                  'text-xs',
                  active ? 'font-semibold text-fg' : done ? 'text-fg' : 'text-muted',
                ].join(' ')}
              >
                {STAGE_LABEL[step]}
                {active ? <span className="sr-only"> (in progress)</span> : null}
              </span>
              {index < STAGE_ORDER.length - 1 ? <span aria-hidden="true" className="text-line">·</span> : null}
            </li>
          );
        })}
      </ol>

      <p className="text-xs text-muted" aria-live="polite">
        {failed ? STAGE_DETAIL.failed : STAGE_DETAIL[finished ? 'done' : (stage ?? 'queued')]}
      </p>
    </div>
  );
}

export function StudentAssignment() {
  const { assignmentId } = useParams();
  const queryClient = useQueryClient();
  const [source, setSource] = useState(STARTER);
  const [filename, setFilename] = useState('main.c');
  const [submitted, setSubmitted] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [loadedFile, setLoadedFile] = useState(null);
  const fileInput = useRef(null);
  const poll = useGradingPoll();

  const assignmentQuery = useQuery({
    queryKey: ['assignment', assignmentId],
    queryFn: () => api.get(`/assignments/${assignmentId}`),
  });

  const assignment = assignmentQuery.data?.assignment;

  const validation = useMemo(() => validateSubmission({ filename, source }), [filename, source]);

  const submit = useMutation({
    mutationFn: () => api.post(`/assignments/${assignmentId}/submissions`, { filename, source }),
    onSuccess: (data) => {
      setSubmitted(data);
      poll.start(data.submission.id);
    },
  });

  // One invalidation when the grade lands, so the attempts list shows it.
  useEffect(() => {
    if (poll.status && TERMINAL.has(poll.status)) {
      queryClient.invalidateQueries({ queryKey: ['assignment', assignmentId] });
    }
  }, [poll.status, assignmentId, queryClient]);

  // Leaving the page stops the timer instead of letting it fire into nothing.
  useEffect(() => () => poll.cancel(), [poll.cancel]); // eslint-disable-line react-hooks/exhaustive-deps

  const onFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setFileError(null);
    // Read first, then validate the real content: the browser's `size` is not
    // the UTF-8 byte count the server will compute.
    let text;
    try {
      text = await file.text();
    } catch (error) {
      setFileError(`Could not read ${file.name}: ${error.message}`);
      return;
    }

    const check = validateSubmission({ filename: file.name, source: text });
    setFilename(file.name);
    setSource(text);
    setLoadedFile({ name: file.name, bytes: check.bytes });

    const sizeOnly = check.problems.filter((problem) => !problem.includes('limit is') && !problem.includes('end in .c'));
    setFileError(sizeOnly[0] ?? null);
  };

  const open = Boolean(assignment?.publishedAt);
  const attempts = assignment?.mySubmissions ?? [];
  const evaluation = poll.data?.submission?.evaluation ?? submitted?.submission?.evaluation ?? null;
  const finished = controlFinished(poll, submitted);
  const grade = evaluation?.gradeHundredths;

  return (
    <>
      <PageHeader
        eyebrow={assignment?.course?.name ?? 'Assignment'}
        title={assignment?.title ?? 'Loading...'}
        description={formatDate(assignment?.dueAt) ? `Due ${formatDate(assignment.dueAt)}` : 'No due date'}
        action={
          <LinkButton to={`/student/courses/${assignment?.courseId ?? ''}`} variant="secondary" size="sm">
            <ArrowLeft aria-hidden="true" size={14} />
            Assignments
          </LinkButton>
        }
      />

      {assignmentQuery.isError ? <ErrorState error={assignmentQuery.error} onRetry={assignmentQuery.refetch} /> : null}

      {assignment ? (
        <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr] lg:items-start">
          <div className="space-y-5">
            <Card>
              <CardHeader title="Statement" description={open ? 'Read this before uploading.' : 'Not published yet.'} />
              <div className="whitespace-pre-wrap px-5 py-4 text-sm leading-relaxed text-fg">{assignment.statement}</div>
            </Card>

            <Card>
              <CardHeader
                title="Your submission"
                description="One C file, at most 64 KB. Every upload is a new attempt and is kept."
                action={<Badge tone={open ? 'success' : 'warning'}>{open ? 'Open' : 'Draft'}</Badge>}
              />

              <div className="space-y-4 p-5">
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="File name" htmlFor="filename">
                    <input
                      id="filename"
                      value={filename}
                      onChange={(event) => setFilename(event.target.value)}
                      aria-invalid={validation.problems.some((problem) => problem.includes('name')) || undefined}
                      className="h-9 w-52 rounded-lg border border-line bg-surface px-3 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    />
                  </Field>
                  <input ref={fileInput} type="file" accept=".c,text/plain" className="hidden" onChange={onFile} />
                  <Button variant="secondary" size="sm" onClick={() => fileInput.current?.click()}>
                    <FileCode2 aria-hidden="true" size={14} />
                    Load .c file
                  </Button>
                  <span className="ml-auto font-mono text-xs text-muted">
                    {(validation.bytes / 1024).toFixed(1)} / {MAX_SOURCE_BYTES / 1024} KB
                  </span>
                </div>

                {loadedFile ? (
                  <p className="text-xs text-muted">
                    Loaded <span className="font-mono text-fg">{loadedFile.name}</span> into the editor - check it before you
                    submit.
                  </p>
                ) : null}

                <CodeEditor value={source} onChange={setSource} height="20rem" label="C source editor" />

                {fileError ? <Alert tone="danger">{fileError}</Alert> : null}

                {!validation.ok && validation.problems.length ? (
                  <Alert tone="warning" title="Fix this before submitting">
                    <ul className="list-disc space-y-1 pl-4">
                      {validation.problems.map((problem) => (
                        <li key={problem}>{problem}</li>
                      ))}
                    </ul>
                  </Alert>
                ) : null}

                {submit.error ? <Alert tone="danger">{submit.error.message}</Alert> : null}

                {poll.running ? (
                  <div className="space-y-4 rounded-xl border border-line bg-surface-2 p-4">
                    <StageTracker stage={poll.stage} status={poll.status} />
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="inline-flex items-center gap-2 text-xs text-muted">
                        <Spinner className="text-brand" />
                        {Math.round(poll.elapsedMs / 1000)}s elapsed
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={poll.cancel}
                        title="Stop watching. Grading continues on the server."
                      >
                        <X aria-hidden="true" size={14} />
                        Stop waiting
                      </Button>
                    </div>
                  </div>
                ) : null}

                {poll.timedOut && !TERMINAL.has(poll.status) ? (
                  <Alert tone="warning" title="Still grading">
                    This is taking longer than usual, so we stopped asking. Grading continues on the server - check again in a
                    moment.
                    <div className="mt-3">
                      <Button variant="secondary" size="sm" onClick={poll.refresh}>
                        <RefreshCw aria-hidden="true" size={14} />
                        Check again
                      </Button>
                    </div>
                  </Alert>
                ) : null}

                {finished ? (
                  <Alert tone={poll.status === 'FAILED' ? 'danger' : 'success'} title={poll.status === 'FAILED' ? 'Grading failed' : 'Report ready'}>
                    {poll.status === 'FAILED' ? (
                      <>The run stopped before a report was produced. Your file is saved; use Re-grade or ask your instructor.</>
                    ) : grade != null ? (
                      <>
                        Graded <strong>{(grade / 100).toFixed(2)} / 100</strong>.{' '}
                        <Link className="underline" to={`/student/submissions/${poll.submissionId ?? submitted?.submission?.id}`}>
                          Open the report
                        </Link>{' '}
                        to see the per-metric breakdown.
                      </>
                    ) : (
                      <>Submitted. Your grade appears once your instructor releases it.</>
                    )}
                  </Alert>
                ) : null}

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    onClick={() => submit.mutate()}
                    loading={submit.isPending}
                    disabled={!open || !validation.ok || poll.running}
                  >
                    <Send aria-hidden="true" size={15} />
                    {submit.isPending ? 'Sending...' : poll.running ? STAGE_LABEL[poll.stage] ?? 'Grading...' : 'Submit and grade'}
                  </Button>
                  <p className="text-xs text-muted">
                    {open ? 'Grading runs in the sandbox; a run usually takes a few seconds.' : 'This assignment is not published yet.'}
                  </p>
                </div>
              </div>
            </Card>
          </div>

          <div className="space-y-5">
            <Card>
              <CardHeader title="Attempts" description={`${attempts.length} so far`} />
              {attempts.length === 0 ? (
                <p className="px-5 py-6 text-sm text-muted">No attempts yet.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {attempts.map((attempt) => (
                    <li key={attempt.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                      <div>
                        <p className="text-sm font-medium text-fg">Attempt {attempt.attempt}</p>
                        <p className="mt-0.5 text-xs text-muted">
                          {formatDate(attempt.submittedAt)} · {attempt.filename}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {attempt.evaluation ? <Badge tone={statusTone(attempt.evaluation.status)}>{attempt.evaluation.status}</Badge> : null}
                        {attempt.released && attempt.evaluation?.gradeHundredths != null ? (
                          <Badge tone="brand">{(attempt.evaluation.gradeHundredths / 100).toFixed(2)}%</Badge>
                        ) : null}
                        {attempt.released ? (
                          <LinkButton to={`/student/submissions/${attempt.id}`} size="sm" variant="secondary">
                            Report
                          </LinkButton>
                        ) : (
                          <span className="text-xs text-muted">Not released</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <CardHeader title="Visible tests" description="Hidden tests are not shown." />
              {assignment.tests?.length ? (
                <ul className="divide-y divide-line">
                  {assignment.tests.map((test) => (
                    <li key={test.id} className="px-5 py-3">
                      <p className="text-xs font-semibold text-fg">{test.name}</p>
                      <pre className="mt-1 overflow-x-auto rounded bg-surface-2 p-2 font-mono text-[0.6875rem] text-muted">
                        stdin: {test.stdin || '(empty)'}
                        {'\n'}expected: {test.expectedStdout || '(empty)'}
                      </pre>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-5 py-6 text-sm text-muted">No visible tests.</p>
              )}
            </Card>

            {assignment.ruleSet ? (
              <Card>
                <CardHeader title={`Rule set v${assignment.ruleSet.version}`} description="How the grade is weighted." />
                <ul className="divide-y divide-line">
                  {assignment.ruleSet.metrics.map((metric) => (
                    <li key={metric.name} className="flex items-center justify-between gap-3 px-5 py-2.5">
                      <span className="text-sm text-fg">{metric.name}</span>
                      <span className="font-mono text-xs text-muted">{(metric.weight * 100).toFixed(0)}%</span>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}

            <p className="text-xs text-muted">
              Your source is stored against your account only. Reports are reproducible from an evaluation key that does not
              include wall-clock timings.
            </p>
            <Link to="/student" className="sr-only">
              My courses
            </Link>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * A terminal state can come from the poll or from a submit that finished before
 * polling started. One helper keeps the JSX from repeating the condition.
 */
function controlFinished(poll, submitted) {
  if (poll.status && TERMINAL.has(poll.status)) return true;
  const status = submitted?.submission?.evaluation?.status;
  return Boolean(status && TERMINAL.has(status));
}
