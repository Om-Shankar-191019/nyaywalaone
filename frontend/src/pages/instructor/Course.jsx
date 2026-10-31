import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ClipboardList, Plus } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router';
import { api } from '../../api/client.js';
import { EmptyState, ErrorState } from '../../components/states.jsx';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, LinkButton, PageHeader } from '../../components/ui.jsx';

const formatDate = (value) =>
  value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;

export function InstructorCourse() {
  const { courseId } = useParams();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [statement, setStatement] = useState('');

  const query = useQuery({
    queryKey: ['course-assignments', courseId],
    queryFn: () => api.get(`/courses/${courseId}/assignments`),
  });

  const create = useMutation({
    mutationFn: () => api.post(`/courses/${courseId}/assignments`, { title, statement }),
    onSuccess: async () => {
      setTitle('');
      setStatement('');
      await queryClient.invalidateQueries({ queryKey: ['course-assignments', courseId] });
    },
  });

  const assignments = query.data?.assignments ?? [];
  const course = query.data?.course;

  return (
    <>
      <PageHeader
        eyebrow={course?.name ?? 'Course'}
        title="Assignments"
        description="Each assignment owns its test cases, its rule set and its submissions. A published rule set is frozen."
        action={
          <LinkButton to="/instructor" variant="secondary" size="sm">
            <ArrowLeft aria-hidden="true" size={14} />
            Dashboard
          </LinkButton>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr] lg:items-start">
        <Card>
          <CardHeader title="Assignments" description={`${assignments.length} total`} />
          {query.isLoading ? (
            <p className="px-5 py-8 text-sm text-muted">Loading assignments...</p>
          ) : query.isError ? (
            <div className="p-5">
              <ErrorState error={query.error} onRetry={query.refetch} />
            </div>
          ) : assignments.length === 0 ? (
            <EmptyState icon={ClipboardList} title="No assignments yet" description="Create one with the form beside this card." />
          ) : (
            <ul className="divide-y divide-line">
              {assignments.map((assignment) => (
                <li key={assignment.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium text-fg">{assignment.title}</p>
                      {assignment.publishedAt && assignment.activeRuleSetId ? (
                        <Badge tone="success">Published</Badge>
                      ) : (
                        <Badge tone="warning">Draft</Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted">
                      {assignment._count?.testCases ?? 0} tests · {assignment._count?.submissions ?? 0} submissions
                      {assignment.dueAt ? ` · due ${formatDate(assignment.dueAt)}` : ''}
                    </p>
                  </div>
                  <LinkButton to={`/instructor/assignments/${assignment.id}`} size="sm" variant="secondary">
                    Open workspace
                  </LinkButton>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="New assignment" description="Statement and reference solution can be edited later." />
          <form
            className="space-y-3 p-5"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <Field label="Title" htmlFor="title">
              <Input id="title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Sum of two integers" />
            </Field>
            <Field label="Statement" htmlFor="statement" hint="Markdown is not rendered; plain text keeps it honest.">
              <textarea
                id="statement"
                value={statement}
                onChange={(event) => setStatement(event.target.value)}
                rows={6}
                className="w-full rounded-lg border border-line bg-surface p-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                placeholder="Read two integers and print their sum."
              />
            </Field>
            {create.error ? <Alert tone="danger">{create.error.message}</Alert> : null}
            <Button type="submit" className="w-full" loading={create.isPending} disabled={title.trim().length < 3 || !statement.trim()}>
              <Plus aria-hidden="true" size={15} />
              Create assignment
            </Button>
          </form>
        </Card>
      </div>
    </>
  );
}
