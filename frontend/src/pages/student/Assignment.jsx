import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FileCode2, Send } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../../api/client.js';
import { CodeEditor } from '../../components/CodeEditor.jsx';
import { ErrorState } from '../../components/states.jsx';
import { Alert, Badge, Button, Card, CardHeader, Field, LinkButton, PageHeader } from '../../components/ui.jsx';

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

export function StudentAssignment() {
  const { assignmentId } = useParams();
  const queryClient = useQueryClient();
  const [source, setSource] = useState(STARTER);
  const [filename, setFilename] = useState('main.c');
  const [submitted, setSubmitted] = useState(null);
  const fileInput = useRef(null);

  const assignmentQuery = useQuery({
    queryKey: ['assignment', assignmentId],
    queryFn: () => api.get(`/assignments/${assignmentId}`),
  });

  const assignment = assignmentQuery.data?.assignment;

  const submit = useMutation({
    mutationFn: () => api.post(`/assignments/${assignmentId}/submissions`, { filename, source }),
    onSuccess: async (data) => {
      setSubmitted(data);
      await queryClient.invalidateQueries({ queryKey: ['assignment', assignmentId] });
    },
  });

  const onFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 64 * 1024) {
      setFilename(file.name);
      return;
    }
    setFilename(file.name);
    setSource(await file.text());
  };

  const open = Boolean(assignment?.publishedAt);
  const attempts = assignment?.mySubmissions ?? [];

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
                      className="h-9 w-52 rounded-lg border border-line bg-surface px-3 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    />
                  </Field>
                  <input ref={fileInput} type="file" accept=".c" className="hidden" onChange={onFile} />
                  <Button variant="secondary" size="sm" onClick={() => fileInput.current?.click()}>
                    <FileCode2 aria-hidden="true" size={14} />
                    Load .c file
                  </Button>
                </div>

                <CodeEditor value={source} onChange={setSource} height="20rem" label="C source editor" />

                {submit.error ? <Alert tone="danger">{submit.error.message}</Alert> : null}
                {submitted ? (
                  <Alert tone={submitted.reportAvailable ? 'success' : 'info'}>
                    {submitted.reportAvailable
                      ? 'Graded. Open the report to see the per-metric breakdown.'
                      : 'Submitted. Your grade appears once your instructor releases it.'}
                  </Alert>
                ) : null}

                <div className="flex flex-wrap items-center gap-3">
                  <Button onClick={() => submit.mutate()} loading={submit.isPending} disabled={!open}>
                    <Send aria-hidden="true" size={15} />
                    {submit.isPending ? 'Grading...' : 'Submit and grade'}
                  </Button>
                  <p className="text-xs text-muted">Grading runs in the sandbox; a run can take a few seconds.</p>
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
              Your source is stored against your account only. Reports are reproducible from an evaluation key that does not include wall-clock timings.
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
