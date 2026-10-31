import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, BookOpen, ClipboardList } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { api } from '../../api/client.js';
import { EmptyState, ErrorState } from '../../components/states.jsx';
import { Badge, Card, CardHeader, LinkButton, PageHeader } from '../../components/ui.jsx';

const formatDate = (value) =>
  value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;

export function StudentCourse() {
  const { courseId } = useParams();
  const query = useQuery({
    queryKey: ['course-assignments', courseId],
    queryFn: () => api.get(`/courses/${courseId}/assignments`),
  });

  const assignments = query.data?.assignments ?? [];
  const course = query.data?.course;

  return (
    <>
      <PageHeader
        eyebrow={course?.name ?? 'Course'}
        title="Assignments"
        description="Open an assignment to read the statement, upload your C file, and see the graded report once it is released."
        action={
          <LinkButton to="/student" variant="secondary" size="sm">
            <ArrowLeft aria-hidden="true" size={14} />
            All courses
          </LinkButton>
        }
      />

      <Card>
        <CardHeader
          title="Published work"
          description={assignments.length ? `${assignments.length} assignment${assignments.length === 1 ? '' : 's'}` : 'Nothing yet'}
        />

        {query.isLoading ? (
          <p className="px-5 py-8 text-sm text-muted">Loading assignments...</p>
        ) : query.isError ? (
          <div className="p-5">
            <ErrorState error={query.error} onRetry={query.refetch} />
          </div>
        ) : assignments.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title="No assignments yet"
            description="Your instructor has not published an assignment for this course."
          />
        ) : (
          <ul className="divide-y divide-line">
            {assignments.map((assignment) => {
              const open = Boolean(assignment.publishedAt && assignment.activeRuleSetId);
              return (
                <li key={assignment.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium text-fg">{assignment.title}</p>
                      {open ? <Badge tone="success">Open</Badge> : <Badge tone="warning">Draft</Badge>}
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      {formatDate(assignment.dueAt) ? `Due ${formatDate(assignment.dueAt)}` : 'No due date'}
                      {' · '}
                      {assignment._count?.testCases ?? 0} test case{(assignment._count?.testCases ?? 0) === 1 ? '' : 's'}
                    </p>
                  </div>
                  <LinkButton to={`/student/assignments/${assignment.id}`} size="sm" variant={open ? 'primary' : 'secondary'}>
                    <ClipboardList aria-hidden="true" size={14} />
                    {open ? 'Open' : 'View'}
                  </LinkButton>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <p className="mt-4 text-xs text-muted">
        Hidden tests stay hidden until after grading. Correctness is always shown with at least one complete failing case, if there is one.
      </p>
      <Link to="/student" className="sr-only">
        Back to courses
      </Link>
    </>
  );
}
