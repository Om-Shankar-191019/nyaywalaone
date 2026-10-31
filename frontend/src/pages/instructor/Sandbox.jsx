import { useMutation } from '@tanstack/react-query';
import { FlaskConical, Play, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../api/client.js';
import { CodeEditor } from '../../components/CodeEditor.jsx';
import { Alert, Badge, Button, Card, CardHeader, Field, Input } from '../../components/ui.jsx';

const SAMPLE_SOURCE = `#include <stdio.h>
#include <limits.h>

int add(int a, int b) {
    return a + b;
}

int main(void) {
    int a, b;
    if (scanf("%d %d", &a, &b) != 2) {
        return 1;
    }
    printf("%d\\n", add(a, b));
    return 0;
}
`;

const TONES = {
  ACCEPTED: 'success',
  COMPILATION_ERROR: 'warning',
  TIME_LIMIT_EXCEEDED: 'warning',
  WRONG_ANSWER: 'warning',
};

const toneFor = (code) => TONES[code] ?? (code?.startsWith('RUNTIME') ? 'danger' : 'neutral');

/**
 * Day 6, made visible: the instructor can prove the execution path from the
 * browser instead of trusting a curl command in a terminal.
 */
export function Sandbox() {
  const [source, setSource] = useState(SAMPLE_SOURCE);
  const [stdin, setStdin] = useState('2147483647 1\n');

  const smoke = useMutation({
    mutationFn: (payload) => api.post('/exec/smoke', payload, { retryAuth: true }),
  });

  const result = smoke.data;

  return (
    <Card id="sandbox">
      <CardHeader
        title="Execution sandbox"
        description="Compiles and runs C through the configured provider. Instructor only, and counted against the daily budget."
        action={<Badge tone="brand">Sandbox</Badge>}
      />

      <div className="space-y-3 p-5">
        <div>
          <p className="label">C source</p>
          <CodeEditor value={source} onChange={setSource} height="16rem" label="C source code" />
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <Field label="Standard input" htmlFor="stdin" hint="Sent to the program as stdin.">
            <Input id="stdin" value={stdin} onChange={(event) => setStdin(event.target.value)} className="font-mono" />
          </Field>
          <Button variant="secondary" onClick={() => setSource(SAMPLE_SOURCE)}>
            <RotateCcw aria-hidden="true" size={15} />
            Reset
          </Button>
          <Button
            onClick={() => smoke.mutate({ source, stdin })}
            loading={smoke.isPending}
            disabled={!source.trim()}
          >
            <Play aria-hidden="true" size={15} />
            Compile &amp; run
          </Button>
        </div>

        {smoke.error ? <Alert tone="danger" title="Execution failed">{smoke.error.message}</Alert> : null}

        {result ? (
          <div className="space-y-3 rounded-xl border border-line bg-surface-2 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={toneFor(result.execution.status.code)}>{result.execution.status.code.replaceAll('_', ' ')}</Badge>
              <span className="text-xs text-muted">{result.execution.status.description}</span>
              {result.execution.status.detail ? (
                <span className="font-mono text-[0.6875rem] text-muted">{result.execution.status.detail}</span>
              ) : null}
              <span className="ml-auto font-mono text-xs text-muted">
                {result.execution.timeMs ?? '?'} ms cpu · {result.execution.memoryKb ?? '?'} KB · {result.timings.totalMs} ms round trip
              </span>
            </div>

            {result.execution.compileOutput ? (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Compiler output</p>
                <pre className="max-h-40 overflow-auto rounded-lg bg-bg p-3 font-mono text-xs leading-relaxed text-warning">
                  {result.execution.compileOutput}
                </pre>
              </div>
            ) : null}

            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">stdout</p>
              <pre className="max-h-40 overflow-auto rounded-lg bg-bg p-3 font-mono text-xs leading-relaxed text-fg">
                {result.execution.stdout || '(empty)'}
              </pre>
            </div>

            {result.execution.stderr ? (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">stderr</p>
                <pre className="max-h-32 overflow-auto rounded-lg bg-bg p-3 font-mono text-xs leading-relaxed text-danger">
                  {result.execution.stderr}
                </pre>
              </div>
            ) : null}

            <div className="grid gap-2 text-xs sm:grid-cols-2">
              <div className="rounded-lg border border-line bg-surface p-3">
                <p className="mb-1.5 font-semibold uppercase tracking-wide text-muted">AST (tree-sitter)</p>
                {result.ast.available ? (
                  <dl className="grid grid-cols-2 gap-1 font-mono">
                    <dt className="text-muted">functions</dt>
                    <dd>{result.ast.metrics.functions}</dd>
                    <dt className="text-muted">ifs</dt>
                    <dd>{result.ast.metrics.ifs}</dd>
                    <dt className="text-muted">cyclomatic max</dt>
                    <dd>{result.ast.metrics.cyclomaticMax}</dd>
                    <dt className="text-muted">main lines</dt>
                    <dd>{result.ast.metrics.mainLines}</dd>
                  </dl>
                ) : (
                  <p className="text-muted">unavailable: {result.ast.reason}</p>
                )}
              </div>

              <div className="rounded-lg border border-line bg-surface p-3">
                <p className="mb-1.5 font-semibold uppercase tracking-wide text-muted">Provider budget</p>
                <p className="font-mono text-muted">
                  {result.budget.calls} / {result.budget.budget} calls today ({result.budget.day} UTC)
                </p>
                <p className="mt-1 font-mono text-muted">
                  {result.execution.provider} · {result.request.compilerOptions}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-xs text-muted">
            <FlaskConical aria-hidden="true" size={14} />
            The sample adds two integers and prints the sum, including an INT_MAX overflow case.
          </p>
        )}
      </div>
    </Card>
  );
}
