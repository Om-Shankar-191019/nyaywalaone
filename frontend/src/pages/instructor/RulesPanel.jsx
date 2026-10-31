import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Scale, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client.js';
import { SchemaFields } from '../../components/schema-fields.jsx';
import { Alert, Badge, Button, Card, CardHeader } from '../../components/ui.jsx';
import { diffRules, weightProblem, weightTotal } from '../../lib/rules.js';

const TABS = [
  { id: 'form', label: 'Form' },
  { id: 'json', label: 'JSON' },
  { id: 'changes', label: 'Changes' },
];

const round6 = (value) => Math.round(value * 1e6) / 1e6;

/**
 * The rules editor.
 *
 * Two things here are deliberate departures from "just edit the JSON":
 *  - the parameters are generated from each analyzer's own schema, so the form
 *    cannot offer a field the grader will reject;
 *  - publishing shows what changed, because "regrade and explain the difference"
 *    is the Week 3 exit criterion and an instructor cannot explain a v2 they
 *    cannot see the diff of.
 */
export function RulesPanel({ assignmentId, assignment, onChanged }) {
  const queryClient = useQueryClient();
  const rulesQuery = useQuery({ queryKey: ['rules', assignmentId], queryFn: () => api.get(`/assignments/${assignmentId}/rules`) });
  const analyzersQuery = useQuery({ queryKey: ['analyzers'], queryFn: () => api.get('/meta/analyzers'), staleTime: 5 * 60 * 1000 });

  const loaded = rulesQuery.data?.draft?.rules ?? rulesQuery.data?.defaults ?? null;
  const active = rulesQuery.data?.active ?? null;
  const versions = rulesQuery.data?.versions ?? [];

  const [draft, setDraft] = useState(null);
  const [tab, setTab] = useState('form');
  const [errors, setErrors] = useState([]);
  const [notice, setNotice] = useState(null);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState(null);
  const [confirming, setConfirming] = useState(false);

  // Adopt the server's copy once, then let the form own it.
  useEffect(() => {
    if (loaded && draft === null) setDraft(loaded);
  }, [loaded, draft]);

  useEffect(() => {
    if (draft) setJsonText(JSON.stringify(draft, null, 2));
  }, [draft]);

  const analyzers = analyzersQuery.data?.analyzers ?? [];
  const analyzerMap = useMemo(() => new Map(analyzers.map((analyzer) => [analyzer.name, analyzer])), [analyzers]);

  const weight = weightProblem(draft?.metrics ?? []);
  const changes = useMemo(() => diffRules(active?.rules ?? null, draft), [active, draft]);
  const dirty = Boolean(draft && active && JSON.stringify(active.rules) !== JSON.stringify(draft));

  const save = useMutation({
    mutationFn: (rules) => api.put(`/assignments/${assignmentId}/rules`, { rules }),
    onSuccess: async (data) => {
      setErrors(data.errors ?? []);
      if (data.version) setNotice({ tone: 'success', text: `Saved version ${data.version}.` });
      await queryClient.invalidateQueries({ queryKey: ['rules', assignmentId] });
      await onChanged();
    },
    onError: (error) => {
      setErrors(Array.isArray(error.details) ? error.details : []);
      setNotice({ tone: 'danger', text: error.message });
    },
  });

  const publishRules = useMutation({
    mutationFn: async () => {
      // Publish acts on the stored draft, so an unsaved edit has to be saved
      // first - otherwise the instructor confirms a diff that is not what ships.
      if (dirty) {
        const saved = await api.put(`/assignments/${assignmentId}/rules`, { rules: draft });
        if (saved.errors?.length) {
          const failure = new Error('The rule set is not valid, so it was not published.');
          failure.details = saved.errors;
          throw failure;
        }
      }
      return api.post(`/assignments/${assignmentId}/rules/publish`);
    },
    onSuccess: async (data) => {
      setConfirming(false);
      setNotice({
        tone: 'success',
        text: `Published v${data.version ?? '?'} as the active rule set. Regrade existing submissions to apply it.`,
      });
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: ['rules', assignmentId] });
      await onChanged();
    },
    onError: (error) => {
      setConfirming(false);
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

  const patchMetric = (index, patch) => {
    setDraft((current) => {
      const metrics = [...(current?.metrics ?? [])];
      metrics[index] = { ...metrics[index], ...patch };
      return { ...current, metrics };
    });
  };

  const removeMetric = (index) => {
    setDraft((current) => ({ ...current, metrics: (current?.metrics ?? []).filter((_, at) => at !== index) }));
  };

  const applyJson = () => {
    try {
      const parsed = JSON.parse(jsonText);
      setJsonError(null);
      setDraft(parsed);
    } catch (error) {
      setJsonError(`That is not valid JSON: ${error.message}`);
    }
  };

  if (rulesQuery.isError) {
    return <Alert tone="danger">{rulesQuery.error.message}</Alert>;
  }
  if (!draft) {
    return <p className="text-sm text-muted">Loading the rule set...</p>;
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Rule set"
          description="Weights must sum to 1.00. Publishing v(n+1) never rewrites an older report."
          action={
            <div className="flex items-center gap-2">
              <Badge tone={weight ? 'danger' : 'success'}>total {weightTotal(draft.metrics).toFixed(2)}</Badge>
              {active ? <Badge tone="brand">active v{active.version}</Badge> : <Badge tone="warning">none active</Badge>}
            </div>
          }
        />

        <div className="border-b border-line px-4 pt-3">
          <div className="flex gap-1" role="tablist" aria-label="Rule set editor views">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={tab === entry.id}
                onClick={() => setTab(entry.id)}
                className={[
                  'rounded-t-lg px-3 py-2 text-xs font-medium transition',
                  tab === entry.id ? 'border-b-2 border-brand text-fg' : 'border-b-2 border-transparent text-muted hover:text-fg',
                ].join(' ')}
              >
                {entry.label}
                {entry.id === 'changes' && changes.length ? (
                  <span className="ml-1.5 rounded bg-surface-2 px-1 font-mono text-[0.625rem]">{changes.length}</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-4 p-4">
          {weight ? <Alert tone="danger" title="Weights do not add up">{weight.message}</Alert> : null}
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

          {tab === 'form' ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label htmlFor="rules-problem" className="text-xs font-medium text-fg">
                    Problem name
                  </label>
                  <input
                    id="rules-problem"
                    value={draft.problem ?? ''}
                    onChange={(event) => setDraft((current) => ({ ...current, problem: event.target.value }))}
                    className="mt-1 h-8 w-full rounded-lg border border-line bg-surface-2 px-2 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  />
                </div>
                <div>
                  <label htmlFor="rules-time" className="text-xs font-medium text-fg">
                    Time limit (s)
                  </label>
                  <input
                    id="rules-time"
                    type="number"
                    step="0.5"
                    min="0.1"
                    max="10"
                    value={draft.limits?.time_limit_s ?? 1}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        limits: { ...current.limits, time_limit_s: Number(event.target.value) },
                      }))
                    }
                    className="mt-1 h-8 w-full rounded-lg border border-line bg-surface-2 px-2 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  />
                </div>
                <div>
                  <label htmlFor="rules-unavailable" className="text-xs font-medium text-fg">
                    When a metric is unavailable
                  </label>
                  <select
                    id="rules-unavailable"
                    value={draft.on_unavailable ?? 'renormalize'}
                    onChange={(event) => setDraft((current) => ({ ...current, on_unavailable: event.target.value }))}
                    className="mt-1 h-8 w-full rounded-lg border border-line bg-surface-2 px-2 text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    <option value="renormalize">renormalize (share the weight out)</option>
                    <option value="zero">zero (missing evidence costs marks)</option>
                  </select>
                </div>
              </div>

              <ul className="space-y-3">
                {(draft.metrics ?? []).map((metric, index) => {
                  const analyzer = analyzerMap.get(metric.analyzer);
                  return (
                    <li key={`${metric.name}-${index}`} className="rounded-xl border border-line bg-surface-2/60 p-3">
                      <div className="grid gap-2 sm:grid-cols-[1.2fr_1.2fr_0.6fr_auto] sm:items-end">
                        <div>
                          <label htmlFor={`metric-name-${index}`} className="text-xs font-medium text-fg">
                            Metric
                          </label>
                          <input
                            id={`metric-name-${index}`}
                            value={metric.name}
                            onChange={(event) => patchMetric(index, { name: event.target.value })}
                            className="mt-1 h-8 w-full rounded-lg border border-line bg-surface px-2 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                          />
                        </div>
                        <div>
                          <label htmlFor={`metric-analyzer-${index}`} className="text-xs font-medium text-fg">
                            Analyzer
                          </label>
                          <select
                            id={`metric-analyzer-${index}`}
                            value={metric.analyzer}
                            onChange={(event) => {
                              const next = analyzerMap.get(event.target.value);
                              patchMetric(index, {
                                analyzer: event.target.value,
                                params: next?.defaults ?? {},
                              });
                            }}
                            className="mt-1 h-8 w-full rounded-lg border border-line bg-surface px-2 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                          >
                            {analyzers.map((entry) => (
                              <option key={entry.name} value={entry.name}>
                                {entry.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label htmlFor={`metric-weight-${index}`} className="text-xs font-medium text-fg">
                            Weight %
                          </label>
                          <input
                            id={`metric-weight-${index}`}
                            type="number"
                            step="1"
                            min="0"
                            max="100"
                            value={Math.round((metric.weight ?? 0) * 100)}
                            onChange={(event) => patchMetric(index, { weight: round6(Number(event.target.value) / 100) })}
                            className="mt-1 h-8 w-full rounded-lg border border-line bg-surface px-2 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                          />
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeMetric(index)}
                          title={`Remove ${metric.name}`}
                          aria-label={`Remove metric ${metric.name}`}
                        >
                          <Trash2 aria-hidden="true" size={14} />
                        </Button>
                      </div>

                      <div className="mt-3 border-t border-line pt-3">
                        <SchemaFields
                          schema={analyzer?.params}
                          value={metric.params}
                          onChange={(params) => patchMetric(index, { params })}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>

              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const free = analyzers.find((entry) => !(draft.metrics ?? []).some((m) => m.analyzer === entry.name));
                  if (!free) return;
                  setDraft((current) => ({
                    ...current,
                    metrics: [
                      ...(current.metrics ?? []),
                      { name: free.name, analyzer: free.name, weight: 0, params: free.defaults ?? {} },
                    ],
                  }));
                }}
              >
                Add a metric
              </Button>
            </div>
          ) : null}

          {tab === 'json' ? (
            <div className="space-y-2">
              <textarea
                value={jsonText}
                onChange={(event) => setJsonText(event.target.value)}
                onBlur={applyJson}
                rows={22}
                spellCheck={false}
                aria-label="Rule set JSON"
                className="w-full rounded-lg border border-line bg-surface p-3 font-mono text-[0.6875rem] leading-relaxed text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              />
              {jsonError ? <Alert tone="danger">{jsonError}</Alert> : null}
              <Button size="sm" variant="secondary" onClick={applyJson}>
                Apply JSON
              </Button>
            </div>
          ) : null}

          {tab === 'changes' ? (
            <div>
              {!active ? (
                <p className="text-sm text-muted">Nothing is published yet, so this draft would be v1.</p>
              ) : changes.length === 0 ? (
                <p className="text-sm text-muted">The draft is identical to the published v{active.version}.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {changes.map((change) => (
                    <li key={change.label} className="flex flex-wrap items-baseline gap-2 py-2 text-xs">
                      <span className="font-medium text-fg">{change.label}</span>
                      <span className="font-mono text-muted line-through">{change.from ?? '—'}</span>
                      <span aria-hidden="true" className="text-muted">
                        →
                      </span>
                      <span className="font-mono text-fg">{change.to ?? '—'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={() => save.mutate(draft)} loading={save.isPending} disabled={Boolean(weight)}>
              <Scale aria-hidden="true" size={15} />
              Save draft
            </Button>
            <Button
              variant="secondary"
              onClick={() => setConfirming(true)}
              loading={publishRules.isPending}
              disabled={Boolean(weight)}
            >
              Publish v{(active?.version ?? 0) + 1}
            </Button>
            {dirty ? <span className="text-xs text-muted">Unsaved changes</span> : null}
          </div>

          {confirming ? (
            <div className="rounded-xl border border-brand/40 bg-surface-2 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-fg">
                <AlertTriangle aria-hidden="true" size={15} className="text-warning" />
                Publish v{(active?.version ?? 0) + 1}?
              </p>
              <p className="mt-1 text-xs text-muted">
                This becomes the active rule set for new submissions. Existing reports keep the version they were graded
                with; regrade to apply the new weights.
              </p>
              {changes.length ? (
                <ul className="mt-3 space-y-1 text-xs">
                  {changes.map((change) => (
                    <li key={change.label} className="text-muted">
                      <span className="font-medium text-fg">{change.label}</span>: {change.from ?? '—'} → {change.to ?? '—'}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-xs text-muted">No differences from the published version.</p>
              )}
              <div className="mt-3 flex gap-2">
                <Button size="sm" onClick={() => publishRules.mutate()} loading={publishRules.isPending}>
                  Confirm publish
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
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
              rows={10}
              spellCheck={false}
              aria-label="Reference solution"
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
