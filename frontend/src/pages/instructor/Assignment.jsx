import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, FlaskConical, ListChecks, Scale, ScrollText, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { api } from '../../api/client.js';
import { ErrorState } from '../../components/states.jsx';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, LinkButton, PageHeader } from '../../components/ui.jsx';

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
      {tab === 'cohort' ? <CohortPanel assignmentId={assignmentId} onChanged={invalidateAll} /> : null}
      {tab === 'similarity' ? <SimilarityPanel assignmentId={assignmentId} /> : null}
    </>
  );
}

function TestsPanel({ assignmentId, assignment, onChanged }) {
  const [form, setForm] = useState({ name: '', stdin: '', expectedStdout: '', isHidden: false });

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
    </div>
  );
}

function RulesPanel({ assignmentId, assignment, onChanged }) {
  const queryClient = useQueryClient();
  const rulesQuery = useQuery({ queryKey: ['rules', assignmentId], queryFn: () => api.get(`/assignments/${assignmentId}/rules`) });

  const loaded = rulesQuery.data?.draft?.rules ?? rulesQuery.data?.defaults;
  const [draft, setDraft] = useState(null);
  const text = useMemo(() => JSON.stringify(draft ?? loaded ?? {}, null, 2), [draft, loaded]);
  const [errors, setErrors] = useState([]);
  const [notice, setNotice] = useState(null);

  const save = useMutation({
    mutationFn: (rules) => api.put(`/assignments/${assignmentId}/rules`, { rules }),
    onSuccess: async (data) => {
      setErrors(data.errors ?? []);
      setNotice({ tone: 'success', text: `Saved version ${data.version} as a draft.` });
      setDraft(null);
      await onChanged();
    },
    onError: (error) => {
      setErrors(Array.isArray(error.details) ? error.details : []);
      setNotice({ tone: 'danger', text: error.message });
    },
  });

  const publishRules = useMutation({
    mutationFn: () => api.post(`/assignments/${assignmentId}/rules/publish`),
    onSuccess: async () => {
      setNotice({ tone: 'success', text: 'Rule set published and activated. Later saves create a new version.' });
      await onChanged();
    },
    onError: (error) => {
      setErrors(Array.isArray(error.details) ? error.details : []);
      setNotice({ tone: 'danger', text: error.message });
    },
  });

  const referenceMutation = useMutation({
    mutationFn: (referenceSolution) => api.patch(`/assignments/${assignmentId}`, { referenceSolution }),
    onSuccess: async () => {
      setNotice({ tone: 'success', text: 'Reference solution saved; edge cases will be judged against it.' });
      await queryClient.invalidateQueries({ queryKey: ['assignment', assignmentId] });
    },
  });

  const [reference, setReference] = useState(assignment?.referenceSolution ?? '');

  const onSave = () => {
    try {
      save.mutate(JSON.parse(text));
    } catch (error) {
      setNotice({ tone: 'danger', text: `That is not valid JSON: ${error.message}` });
    }
  };

  const active = rulesQuery.data?.active;
  const versions = rulesQuery.data?.versions ?? [];

  return (
    <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr] lg:items-start">
      <Card>
        <CardHeader
          title="Rule set JSON"
          description="Weights must sum to 1.00. Saving a published version creates the next version."
          action={active ? <Badge tone="brand">active v{active.version}</Badge> : <Badge tone="warning">none active</Badge>}
        />
        <div className="space-y-3 p-4">
          <textarea
            value={text}
            onChange={(event) => setDraft(event.target.value)}
            rows={24}
            spellCheck={false}
            className="w-full rounded-lg border border-line bg-surface p-3 font-mono text-[0.6875rem] leading-relaxed text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          />
          {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
          {errors.length ? (
            <Alert tone="danger" title="Validation errors">
              <ul className="list-disc space-y-1 pl-4">
                {errors.map((error) => (
                  <li key={`${error.path}-${error.message}`}>
                    <span className="font-mono">{error.path}</span>: {error.message}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button onClick={onSave} loading={save.isPending}>
              <Scale aria-hidden="true" size={15} />
              Save draft
            </Button>
            <Button variant="secondary" onClick={() => publishRules.mutate()} loading={publishRules.isPending}>
              Publish rule set
            </Button>
          </div>
        </div>
      </Card>

      <div className="space-y-5">
        <Card>
          <CardHeader title="Versions" description="Older versions stay readable to old reports." />
          <ul className="divide-y divide-line">
            {versions.map((version) => (
              <li key={version.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-xs">
                <span className="font-mono text-fg">v{version.version}</span>
                <span className="text-muted">{version.isPublished ? 'published' : 'draft'}</span>
                <span className="font-mono text-[0.625rem] text-muted">{version.rulesHash.slice(0, 10)}</span>
              </li>
            ))}
            {versions.length === 0 ? <li className="px-5 py-4 text-sm text-muted">No versions saved yet.</li> : null}
          </ul>
        </Card>

        <Card>
          <CardHeader title="Reference solution" description="Used by the oracle for edge cases. Never shown to students." />
          <div className="space-y-3 p-4">
            <textarea
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              rows={12}
              spellCheck={false}
              className="w-full rounded-lg border border-line bg-surface p-3 font-mono text-[0.6875rem] leading-relaxed text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              placeholder="#include <stdio.h> ..."
            />
            {referenceMutation.error ? <Alert tone="danger">{referenceMutation.error.message}</Alert> : null}
            <Button
              size="sm"
              variant="secondary"
              loading={referenceMutation.isPending}
              onClick={() => referenceMutation.mutate(reference)}
            >
              Save reference
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

const cohortQueryKey = (assignmentId, filters) => ['cohort', assignmentId, filters];
const emptyFilters = { q: '', status: 'ANY', sort: 'name', direction: 'asc', page: 1, pageSize: 25 };

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
  const query = useQuery({ queryKey: ['similarity', assignmentId], queryFn: () => api.get(`/assignments/${assignmentId}/similarity`) });
  const matches = query.data?.matches ?? [];

  return (
    <Card>
      <CardHeader
        title="Similarity"
        description="Identical canonical solutions and high shingle overlap. A flag is a reason to look, not a finding of misconduct."
      />
      {query.isError ? (
        <div className="p-5">
          <ErrorState error={query.error} onRetry={query.refetch} />
        </div>
      ) : matches.length === 0 ? (
        <p className="px-5 py-8 text-sm text-muted">No flagged pairs at this threshold. Pairs appear once two students submit overlapping solutions.</p>
      ) : (
        <ul className="divide-y divide-line">
          {matches.map((match) => (
            <li key={match.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <div className="text-sm text-fg">
                <p>
                  {match.a?.student?.fullName ?? 'unknown'} (attempt {match.a?.attempt ?? '—'}) ↔ {match.b?.student?.fullName ?? 'unknown'} (attempt{' '}
                  {match.b?.attempt ?? '—'})
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {match.method} · {formatDate(match.createdAt)}
                </p>
              </div>
              <Badge tone={match.similarity >= 0.9 ? 'danger' : 'warning'}>{(match.similarity * 100).toFixed(1)}%</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
