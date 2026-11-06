import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, FlaskConical, ListChecks, Scale, ScrollText, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { api } from '../../api/client.js';
import { ErrorState } from '../../components/states.jsx';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, LinkButton, PageHeader } from '../../components/ui.jsx';
import { parseBulkTests } from '../../lib/rules.js';
import { RulesPanel } from './RulesPanel.jsx';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

const formatDate = (value) =>
  value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

const statusTone = (status) =>
  status === 'SUCCEEDED' ? 'success' : status === 'PARTIAL' ? 'warning' : status === 'FAILED' ? 'danger' : 'neutral';

const TABS = [
  { id: 'tests', label: 'Tests', icon: ListChecks },
  { id: 'rules', label: 'Rule set', icon: Scale },
  { id: 'cohort', label: 'Cohort', icon: ScrollText },
  { id: 'similarity', label: 'Similarity', icon: FlaskConical },
];

export function InstructorAssignment() {
  const { assignmentId } = useParams();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('tests');
  const [notice, setNotice] = useState(null);

  const assignmentQuery = useQuery({ queryKey: ['assignment', assignmentId], queryFn: () => api.get(`/assignments/${assignmentId}`) });
  const assignment = assignmentQuery.data?.assignment;

  const invalidateAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['assignment', assignmentId] }),
      queryClient.invalidateQueries({ queryKey: ['rules', assignmentId] }),
      queryClient.invalidateQueries({ queryKey: ['tests', assignmentId] }),
      queryClient.invalidateQueries({ queryKey: ['cohort', assignmentId] }),
      queryClient.invalidateQueries({ queryKey: ['similarity', assignmentId] }),
    ]);
  };

  const publishAssignment = useMutation({
    mutationFn: () => api.post(`/assignments/${assignmentId}/publish`),
    onSuccess: async () => {
      setNotice({ tone: 'success', text: 'Assignment published. Students can now submit.' });
      await invalidateAll();
    },
    onError: (error) => setNotice({ tone: 'danger', text: error.message }),
  });

  return (
    <>
      <PageHeader
        eyebrow={assignment?.course?.name ?? 'Assignment'}
        title={assignment?.title ?? 'Loading...'}
        description={
          assignment
            ? `${assignment.tests?.length ?? 0} tests · ${assignment.ruleSet ? `rule set v${assignment.ruleSet.version}` : 'no active rule set'}${
                assignment.publishedAt ? ` · published ${formatDate(assignment.publishedAt)}` : ' · not published'
              }`
            : ''
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            <LinkButton to={`/instructor/courses/${assignment?.courseId ?? ''}`} variant="secondary" size="sm">
              <ArrowLeft aria-hidden="true" size={14} />
              Assignments
            </LinkButton>
            <Button size="sm" loading={publishAssignment.isPending} onClick={() => publishAssignment.mutate()}>
              Publish assignment
            </Button>
          </div>
        }
      />

      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      {assignmentQuery.isError ? <ErrorState error={assignmentQuery.error} onRetry={assignmentQuery.refetch} /> : null}

      <div role="tablist" aria-label="Assignment workspace" className="mb-5 flex flex-wrap gap-1 rounded-xl border border-line bg-surface p-1">
        {TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${
              tab === item.id ? 'bg-brand text-brand-fg' : 'text-muted hover:bg-surface-2 hover:text-fg'
            }`}
          >
            <item.icon aria-hidden="true" size={15} />
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'tests' ? <TestsPanel assignmentId={assignmentId} assignment={assignment} onChanged={invalidateAll} /> : null}
      {tab === 'rules' ? <RulesPanel assignmentId={assignmentId} assignment={assignment} onChanged={invalidateAll} /> : null}
      {tab === 'cohort' ? (
        <div className="space-y-5">
          <CohortPanel assignmentId={assignmentId} onChanged={invalidateAll} />
          <ActivityPanel assignmentId={assignmentId} />
        </div>
      ) : null}
      {tab === 'similarity' ? <SimilarityPanel assignmentId={assignmentId} /> : null}
    </>
  );
}

function TestsPanel({ assignmentId, assignment, onChanged }) {
  const [form, setForm] = useState({ name: '', stdin: '', expectedStdout: '', isHidden: false });
  const [bulk, setBulk] = useState('');
  const [bulkProblems, setBulkProblems] = useState([]);
  const [bulkNotice, setBulkNotice] = useState(null);

  const testsQuery = useQuery({ queryKey: ['tests', assignmentId], queryFn: () => api.get(`/assignments/${assignmentId}/tests`) });

  const create = useMutation({
    mutationFn: () => api.post(`/assignments/${assignmentId}/tests`, { ...form, ordinal: testsQuery.data?.tests?.length ?? 0 }),
    onSuccess: async () => {
      setForm({ name: '', stdin: '', expectedStdout: '', isHidden: false });
      await onChanged();
    },
  });

  const remove = useMutation({
    mutationFn: (testId) => api.del(`/assignments/${assignmentId}/tests/${testId}`),
    onSuccess: onChanged,
  });

  const toggleHidden = useMutation({
    mutationFn: (test) => api.patch(`/assignments/${assignmentId}/tests/${test.id}`, { isHidden: !test.isHidden }),
    onSuccess: onChanged,
  });

  const bulkCreate = useMutation({
    mutationFn: async (rows) => {
      let added = 0;
      for (const row of rows) {
        try {
          await api.post(`/assignments/${assignmentId}/tests`, row);
          added += 1;
        } catch (error) {
          setBulkProblems((current) => [...current, `${row.name}: ${error.message}`]);
        }
      }
      return added;
    },
    onSuccess: async (added) => {
      setBulk('');
      setBulkNotice({ tone: 'success', text: `${added} test case${added === 1 ? '' : 's'} added as hidden.` });
      await onChanged();
    },
  });

  const tests = testsQuery.data?.tests ?? [];

  return (
    <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr] lg:items-start">
      <Card>
        <CardHeader title="Test cases" description="Hidden tests are never sent to the student's browser." />
        {testsQuery.isError ? (
          <div className="p-5">
            <ErrorState error={testsQuery.error} onRetry={testsQuery.refetch} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line bg-surface-2 text-[0.6875rem] uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2 font-semibold">Name</th>
                  <th className="px-3 py-2 font-semibold">stdin</th>
                  <th className="px-3 py-2 font-semibold">expected</th>
                  <th className="px-3 py-2 font-semibold">Visibility</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {tests.map((test) => (
                  <tr key={test.id}>
                    <td className="px-4 py-2 font-medium text-fg">{test.name}</td>
                    <td className="max-w-[10rem] truncate px-3 py-2 font-mono text-xs text-muted">{JSON.stringify(test.stdin)}</td>
                    <td className="max-w-[10rem] truncate px-3 py-2 font-mono text-xs text-muted">{JSON.stringify(test.expectedStdout)}</td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => toggleHidden.mutate(test)}
                        className="text-xs text-brand underline decoration-dotted"
                      >
                        <Badge tone={test.isHidden ? 'warning' : 'neutral'}>{test.isHidden ? 'Hidden' : 'Visible'}</Badge>
                      </button>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button variant="ghost" size="sm" aria-label={`Delete ${test.name}`} onClick={() => remove.mutate(test.id)}>
                        <Trash2 aria-hidden="true" size={14} />
                      </Button>
                    </td>
                  </tr>
                ))}
                {tests.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted">
                      No tests yet. Correctness stays unmeasured until you add one.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
        {assignment?.publishedAt ? (
          <p className="border-t border-line px-4 py-3 text-xs text-muted">
            The assignment is published. Editing tests changes the test-set hash, so older reports remain explainable against their own hash.
          </p>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="Add a test" description="Exact expected stdout after trailing whitespace normalisation." />
        <form
          className="space-y-3 p-5"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Name" htmlFor="test-name">
            <Input id="test-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="negatives" />
          </Field>
          <Field label="stdin" htmlFor="test-stdin">
            <textarea
              id="test-stdin"
              rows={3}
              value={form.stdin}
              onChange={(event) => setForm({ ...form, stdin: event.target.value })}
              className="w-full rounded-lg border border-line bg-surface p-2 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              placeholder={'-7 4\n'}
            />
          </Field>
          <Field label="Expected stdout" htmlFor="test-expected">
            <textarea
              id="test-expected"
              rows={3}
              value={form.expectedStdout}
              onChange={(event) => setForm({ ...form, expectedStdout: event.target.value })}
              className="w-full rounded-lg border border-line bg-surface p-2 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              placeholder={'-3\n'}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={form.isHidden}
              onChange={(event) => setForm({ ...form, isHidden: event.target.checked })}
              className="size-4 rounded border-line"
            />
            Hidden from students
          </label>
          {create.error ? <Alert tone="danger">{create.error.message}</Alert> : null}
          <Button type="submit" className="w-full" loading={create.isPending} disabled={!form.name.trim()}>
            Add test
          </Button>
        </form>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader
          title="Bulk paste"
          description="One case per line: input|||expected. Use \\n for a newline; lines starting with # are ignored."
        />
        <div className="space-y-3 p-5">
          <textarea
            rows={6}
            value={bulk}
            onChange={(event) => setBulk(event.target.value)}
            spellCheck={false}
            aria-label="Bulk test cases"
            placeholder={'# two integers, one per line\n40 2|||42\\n\n# negatives\n-7 4|||-3\\n'}
            className="w-full rounded-lg border border-line bg-surface p-3 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          />
          {bulkProblems.length ? (
            <Alert tone="warning" title="Some lines were skipped">
              <ul className="list-disc space-y-1 pl-4">
                {bulkProblems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {bulkNotice ? <Alert tone={bulkNotice.tone}>{bulkNotice.text}</Alert> : null}
          <Button
            variant="secondary"
            loading={bulkCreate.isPending}
            disabled={!bulk.trim()}
            onClick={() => {
              const { rows, problems } = parseBulkTests(bulk);
              setBulkProblems(problems);
              if (!rows.length) {
                setBulkNotice({ tone: 'warning', text: 'Nothing to add: no line had an input|||expected pair.' });
                return;
              }
              // Duplicate names are the server's 409; a suffix keeps a second
              // paste of the same block from failing halfway through.
              const taken = new Set(tests.map((test) => test.name));
              const prepared = rows.map((row, index) => {
                let name = row.name;
                let suffix = index + 1;
                while (taken.has(name)) {
                  suffix += 1;
                  name = `${row.name} (${suffix})`;
                }
                taken.add(name);
                return { ...row, name, ordinal: tests.length + index };
              });
              bulkCreate.mutate(prepared);
            }}
          >
            Add {parseBulkTests(bulk).rows.length || ''} case{parseBulkTests(bulk).rows.length === 1 ? '' : 's'}
          </Button>
        </div>
      </Card>
    </div>
  );
}

const cohortQueryKey = (assignmentId, filters) => ['cohort', assignmentId, filters];
const emptyFilters = {
  q: '',
  status: 'ANY',
  sort: 'name',
  direction: 'asc',
  page: 1,
  pageSize: 25,
  minGrade: '',
  maxGrade: '',
  flaggedOnly: 'false',
};

function CohortPanel({ assignmentId, onChanged }) {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState(emptyFilters);
  const [message, setMessage] = useState(null);

  const params = new URLSearchParams(
    Object.entries(filters).filter(([, value]) => value !== '' && value !== undefined),
  ).toString();

  const cohortQuery = useQuery({ queryKey: cohortQueryKey(assignmentId, params), queryFn: () => api.get(`/assignments/${assignmentId}/submissions?${params}`) });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['cohort', assignmentId] });
    await onChanged();
  };

  const release = useMutation({
    mutationFn: ({ submissionId, released }) => api.patch(`/submissions/${submissionId}/release`, { released }),
    onSuccess: refresh,
  });

  const regrade = useMutation({
    mutationFn: ({ submissionId, reason }) => api.post(`/submissions/${submissionId}/regrade`, { reason }),
    onSuccess: async (data) => {
      setMessage(`Re-graded: ${((data.submission.evaluation.gradeHundredths ?? 0) / 100).toFixed(2)}%`);
      await refresh();
    },
    onError: (error) => setMessage(error.message),
  });

  // Day 23: batch grading is a queue, not a request. This panel only enqueues,
  // then watches the counters move; polling stops the moment nothing is left.
  const progressQuery = useQuery({
    queryKey: ['grading-progress', assignmentId],
    queryFn: () => api.get(`/assignments/${assignmentId}/grading-progress`),
    refetchInterval: (query) => {
      const counts = query.state.data?.counts;
      return counts && counts.queued + counts.running > 0 ? 3000 : false;
    },
  });

  const progress = progressQuery.data;

  // Day 24: the cohort view also advances the queue. A per-minute cron is a
  // Pro-only plan feature, so the poll that watches these counters is what keeps
  // them moving - one row per tick, and the claim is atomic on the server.
  const advancing = useRef(false);
  useEffect(() => {
    if (!progress?.counts.queued || advancing.current) return;
    advancing.current = true;
    api
      .post('/grading/advance', { limit: 1 })
      .catch(() => {})
      .finally(() => {
        advancing.current = false;
      });
  }, [progress]);

  const gradeAll = useMutation({
    mutationFn: () => api.post(`/assignments/${assignmentId}/grade-all`, { includeFailed: true, start: true }),
    onSuccess: async (data) => {
      setMessage(
        data.queued === 0
          ? 'Nothing to grade: every submission in this cohort already has a result.'
          : `Queued ${data.queued} of ${data.total} evaluations. The queue drains in the background at the provider's rate.`,
      );
      await queryClient.invalidateQueries({ queryKey: ['grading-progress', assignmentId] });
      await refresh();
    },
    onError: (error) => setMessage(error.message),
  });

  const data = cohortQuery.data;
  const rows = data?.submissions ?? [];

  return (
    <Card>
      <CardHeader
        title="Cohort"
        description={data ? `${data.total} rows · ${data.counts.graded} graded · ${data.counts.missing} missing · ${data.counts.unreleased} unreleased` : 'Loading...'}
        action={
          <a
            href={`${API_BASE}/assignments/${assignmentId}/export.csv`}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-xs font-medium text-fg transition hover:border-brand/60"
          >
            <Download aria-hidden="true" size={14} />
            CSV
          </a>
        }
      />

      {/* Day 23: batch grading is a queue, not a request. These counters are the
          only honest answer to "is the cohort marked yet", so they sit above the
          table instead of behind a spinner. Polling stops when nothing is moving. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface-2/60 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <span className="font-medium text-fg">
            {progress
              ? `${progress.counts.done} of ${progress.counts.total} evaluated (${progress.percent}%)`
              : 'Loading queue...'}
          </span>
          <span>queued {progress?.counts.queued ?? 0}</span>
          <span>running {progress?.counts.running ?? 0}</span>
          <span>failed {progress?.counts.failed ?? 0}</span>
          {progress?.queue?.queued ? <span>queue depth {progress.queue.queued}</span> : null}
        </div>
        <Button size="sm" variant="secondary" loading={gradeAll.isPending} onClick={() => gradeAll.mutate()}>
          Grade all
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3">
        <Field label="Search" htmlFor="cohort-q">
          <Input
            id="cohort-q"
            value={filters.q}
            onChange={(event) => setFilters({ ...filters, q: event.target.value, page: 1 })}
            placeholder="name or email"
            className="h-8 w-44 text-xs"
          />
        </Field>
        <Field label="Status" htmlFor="cohort-status">
          <select
            id="cohort-status"
            value={filters.status}
            onChange={(event) => setFilters({ ...filters, status: event.target.value, page: 1 })}
            className="h-8 rounded-lg border border-line bg-surface px-2 text-xs text-fg"
          >
            {['ANY', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'QUEUED', 'NO_SUBMISSION'].map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Min %" htmlFor="cohort-min">
          <Input
            id="cohort-min"
            type="number"
            min="0"
            max="100"
            value={filters.minGrade}
            onChange={(event) => setFilters({ ...filters, minGrade: event.target.value, page: 1 })}
            className="h-8 w-20 text-xs"
          />
        </Field>
        <Field label="Max %" htmlFor="cohort-max">
          <Input
            id="cohort-max"
            type="number"
            min="0"
            max="100"
            value={filters.maxGrade}
            onChange={(event) => setFilters({ ...filters, maxGrade: event.target.value, page: 1 })}
            className="h-8 w-20 text-xs"
          />
        </Field>
        <label className="flex h-8 items-center gap-2 text-xs text-fg">
          <input
            type="checkbox"
            checked={filters.flaggedOnly === 'true'}
            onChange={(event) => setFilters({ ...filters, flaggedOnly: event.target.checked ? 'true' : 'false', page: 1 })}
            className="size-3.5 rounded border-line text-brand focus-visible:ring-2 focus-visible:ring-brand"
          />
          Flagged only
        </label>
        <Field label="Sort" htmlFor="cohort-sort">
          <select
            id="cohort-sort"
            value={filters.sort}
            onChange={(event) => setFilters({ ...filters, sort: event.target.value })}
            className="h-8 rounded-lg border border-line bg-surface px-2 text-xs text-fg"
          >
            <option value="name">name</option>
            <option value="grade">grade</option>
            <option value="submitted">submitted</option>
          </select>
        </Field>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            setFilters({ ...filters, direction: filters.direction === 'asc' ? 'desc' : 'asc' })
          }
        >
          {filters.direction === 'asc' ? 'Ascending' : 'Descending'}
        </Button>
      </div>

      {message ? (
        <div className="px-4 pt-3">
          <Alert tone="info">{message}</Alert>
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-surface-2 text-[0.6875rem] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2 font-semibold">Student</th>
              <th className="px-3 py-2 font-semibold">Attempt</th>
              <th className="px-3 py-2 font-semibold">Grade</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">Released</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => (
              <tr key={row.student.id}>
                <td className="px-4 py-2.5">
                  <p className="font-medium text-fg">{row.student.fullName}</p>
                  <p className="text-[0.6875rem] text-muted">{row.student.email}</p>
                </td>
                <td className="px-3 py-2.5 text-xs text-muted">{row.attempt ?? '—'}</td>
                <td className="px-3 py-2.5 font-mono text-xs text-fg">{row.percent != null ? `${row.percent.toFixed(2)}%` : '—'}</td>
                <td className="px-3 py-2.5">
                  <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                </td>
                <td className="px-3 py-2.5 text-xs text-muted">{row.releasedAt ? formatDate(row.releasedAt) : '—'}</td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {row.submissionId ? (
                      <>
                        <LinkButton to={`/instructor/submissions/${row.submissionId}`} size="sm" variant="ghost">
                          Report
                        </LinkButton>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => release.mutate({ submissionId: row.submissionId, released: !row.releasedAt })}
                        >
                          {row.releasedAt ? 'Unrelease' : 'Release'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            const reason = window.prompt('Why re-grade this submission?', 'Provider rerun requested by instructor');
                            if (reason && reason.trim().length >= 3) regrade.mutate({ submissionId: row.submissionId, reason: reason.trim() });
                          }}
                        >
                          Re-grade
                        </Button>
                      </>
                    ) : (
                      <span className="text-xs text-muted">No submission</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted">
                  Nothing matches these filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {data && data.total > data.pageSize ? (
        <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-xs text-muted">
          <span>
            Page {data.page} of {Math.max(1, Math.ceil(data.total / data.pageSize))}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={data.page <= 1} onClick={() => setFilters({ ...filters, page: filters.page - 1 })}>
              Previous
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={data.page >= Math.ceil(data.total / data.pageSize)}
              onClick={() => setFilters({ ...filters, page: filters.page + 1 })}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function SimilarityPanel({ assignmentId }) {
  const queryClient = useQueryClient();
  const [threshold, setThreshold] = useState(0.6);
  const [summary, setSummary] = useState(null);
  const [reviewing, setReviewing] = useState(null);
  const [note, setNote] = useState('');

  const query = useQuery({
    queryKey: ['similarity', assignmentId, threshold],
    queryFn: () => api.get(`/assignments/${assignmentId}/similarity?threshold=${threshold}`),
  });

  const scan = useMutation({
    mutationFn: () => api.post(`/assignments/${assignmentId}/similarity/scan`, {}),
    onSuccess: async (data) => {
      setSummary(data);
      await queryClient.invalidateQueries({ queryKey: ['similarity', assignmentId] });
    },
  });

  const review = useMutation({
    mutationFn: ({ matchId, reviewed, note: text }) => api.patch(`/similarity/${matchId}/review`, { reviewed, note: text }),
    onSuccess: async () => {
      setReviewing(null);
      setNote('');
      await queryClient.invalidateQueries({ queryKey: ['similarity', assignmentId] });
    },
  });

  const matches = query.data?.matches ?? [];

  return (
    <Card>
      <CardHeader
        title="Similarity"
        description="Identical canonical solutions and high shingle overlap. A flag is a reason to look, not a finding of misconduct."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="sim-threshold" className="text-xs text-muted">
              Threshold
            </label>
            <select
              id="sim-threshold"
              value={threshold}
              onChange={(event) => setThreshold(Number(event.target.value))}
              className="h-8 rounded-lg border border-line bg-surface px-2 text-xs text-fg"
            >
              {[0.5, 0.6, 0.75, 0.85, 0.95].map((value) => (
                <option key={value} value={value}>
                  {(value * 100).toFixed(0)}%
                </option>
              ))}
            </select>
            <Button size="sm" variant="secondary" loading={scan.isPending} onClick={() => scan.mutate()}>
              Scan cohort
            </Button>
          </div>
        }
      />

      {summary ? (
        <div className="px-5 pt-4">
          <Alert tone="info">
            Compared {summary.compared} pair{summary.compared === 1 ? '' : 's'} across {summary.submissions} submission
            {summary.submissions === 1 ? '' : 's'}: {summary.pairs} above 50%, {summary.flagged} at or above the{' '}
            {(summary.params.flag_threshold * 100).toFixed(0)}% review threshold.
          </Alert>
        </div>
      ) : null}

      {scan.error ? (
        <div className="px-5 pt-4">
          <Alert tone="danger">{scan.error.message}</Alert>
        </div>
      ) : null}

      {query.isError ? (
        <div className="p-5">
          <ErrorState error={query.error} onRetry={query.refetch} />
        </div>
      ) : matches.length === 0 ? (
        <p className="px-5 py-8 text-sm text-muted">
          No pairs at this threshold. Run a scan, or lower the threshold - two independent solutions to a small problem can share
          a lot of structure.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {matches.map((match) => (
            <li key={match.id} className="space-y-2 px-5 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm text-fg">
                  <p>
                    {match.a?.student?.fullName ?? 'unknown'} (attempt {match.a?.attempt ?? '—'}) ↔{' '}
                    {match.b?.student?.fullName ?? 'unknown'} (attempt {match.b?.attempt ?? '—'})
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {match.method} · {formatDate(match.createdAt)}
                    {match.matchedSpan?.identical ? ' · byte-identical' : ''}
                    {match.reviewedAt ? ' \u00b7 reviewed' : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={match.similarity >= 0.9 ? 'danger' : 'warning'}>{(match.similarity * 100).toFixed(1)}%</Badge>
                  {match.reviewedAt ? (
                    <Button size="sm" variant="ghost" onClick={() => review.mutate({ matchId: match.id, reviewed: false })}>
                      Reopen
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => setReviewing(match.id)}>
                      Mark reviewed
                    </Button>
                  )}
                </div>
              </div>

              {match.reviewNote ? <p className="text-xs text-muted">Note: {match.reviewNote}</p> : null}

              {reviewing === match.id ? (
                <div className="rounded-lg border border-line bg-surface-2 p-3">
                  <label htmlFor={`note-${match.id}`} className="text-xs font-medium text-fg">
                    What did you decide?
                  </label>
                  <textarea
                    id={`note-${match.id}`}
                    rows={2}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Shared starter file; explained together in class."
                    className="mt-1 w-full rounded-lg border border-line bg-surface p-2 text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  />
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" loading={review.isPending} onClick={() => review.mutate({ matchId: match.id, reviewed: true, note })}>
                      Save review
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setReviewing(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * Day 18: who changed what.
 *
 * A release, a regrade and a rule-set publish all move a grade after the fact.
 * Without a feed, "why is my mark different?" is answered from `psql`, which is
 * not a product surface.
 */
function ActivityPanel({ assignmentId }) {
  const activityQuery = useQuery({
    queryKey: ['activity', assignmentId],
    queryFn: () => api.get(`/assignments/${assignmentId}/activity?limit=15`),
    refetchInterval: 30_000,
  });

  const entries = activityQuery.data?.entries ?? [];

  const label = (entry) => {
    switch (entry.action) {
      case 'grade.release':
        return 'released a grade';
      case 'grade.unrelease':
        return 'withdrew a release';
      case 'evaluation.regrade':
        return 're-graded a submission';
      case 'ruleset.publish':
        return `published rule set v${entry.metadata?.version ?? '?'}`;
      case 'cohort.export':
        return 'exported the cohort CSV';
      case 'roster.remove':
        return 'removed a student from the course';
      default:
        return entry.action;
    }
  };

  return (
    <Card>
      <CardHeader
        title="Activity"
        description="Releases, regrades and rule-set publishes on this assignment."
        action={
          <Button variant="ghost" size="sm" onClick={() => activityQuery.refetch()} loading={activityQuery.isFetching}>
            Refresh
          </Button>
        }
      />
      {activityQuery.isError ? (
        <div className="p-5">
          <ErrorState error={activityQuery.error} onRetry={activityQuery.refetch} />
        </div>
      ) : entries.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">Nothing recorded yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-2.5 text-xs">
              <span className="text-fg">
                <span className="font-medium">{entry.actor?.fullName ?? 'System'}</span> {label(entry)}
                {entry.metadata?.reason ? <span className="text-muted"> — {entry.metadata.reason}</span> : null}
              </span>
              <time className="text-muted" dateTime={entry.createdAt}>
                {new Date(entry.createdAt).toLocaleString()}
              </time>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
