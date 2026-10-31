import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, GraduationCap, Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { api } from '../../api/client.js';
import { useAuth } from '../../auth/AuthProvider.jsx';
import { EmptyState, ErrorState } from '../../components/states.jsx';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, LinkButton, PageHeader } from '../../components/ui.jsx';
import { createCourseSchema } from '../../lib/validation.js';
import { Sandbox } from './Sandbox.jsx';

function JoinCode({ code }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard can be blocked; the code is visible anyway */
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <code className="rounded border border-line bg-surface-2 px-2 py-0.5 font-mono text-xs tracking-[0.16em] text-fg">{code}</code>
      <Button variant="ghost" size="sm" onClick={copy} aria-label={`Copy join code ${code}`}>
        {copied ? <Check aria-hidden="true" size={13} /> : <Copy aria-hidden="true" size={13} />}
      </Button>
    </div>
  );
}

export function InstructorDashboard() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const coursesQuery = useQuery({ queryKey: ['courses'], queryFn: () => api.get('/courses') });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm({ resolver: zodResolver(createCourseSchema), defaultValues: { name: '' } });

  const createCourse = useMutation({
    mutationFn: (values) => api.post('/courses', values),
    onSuccess: async () => {
      reset();
      await queryClient.invalidateQueries({ queryKey: ['courses'] });
    },
  });

  const onSubmit = async (values) => {
    await createCourse.mutateAsync(values).catch(() => null);
  };

  const courses = coursesQuery.data?.courses ?? [];

  return (
    <>
      <PageHeader
        eyebrow={`Welcome, ${user.fullName}`}
        title="Instructor dashboard"
        description="Create a course, hand out its join code, then open it to build tests, publish a weighted rule set and grade the cohort."
      />

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr] lg:items-start">
        <Card>
          <CardHeader
            title="Your courses"
            description={courses.length ? `${courses.length} active` : 'Nothing yet'}
            action={<Badge tone="brand">Instructor</Badge>}
          />

          {coursesQuery.isLoading ? (
            <p className="px-5 py-8 text-sm text-muted">Loading your courses...</p>
          ) : coursesQuery.isError ? (
            <div className="p-5">
              <ErrorState error={coursesQuery.error} onRetry={coursesQuery.refetch} />
            </div>
          ) : courses.length === 0 ? (
            <EmptyState
              icon={GraduationCap}
              title="Create your first course"
              description="A course owns its assignments and its roster. Students join with the generated 8-character code."
            />
          ) : (
            <ul className="divide-y divide-line">
              {courses.map((course) => (
                <li key={course.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">{course.name}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {course._count?.enrollments ?? 0} student{course._count?.enrollments === 1 ? '' : 's'} ·{' '}
                      {course._count?.assignments ?? 0} assignment{course._count?.assignments === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <JoinCode code={course.joinCode} />
                    <LinkButton to={`/instructor/courses/${course.id}`} size="sm" variant="secondary">
                      Open
                    </LinkButton>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="New course" description="Students join with the generated code." />
          <form className="space-y-3 p-5" onSubmit={handleSubmit(onSubmit)} noValidate>
            <Field label="Course name" htmlFor="name" error={errors.name?.message}>
              <Input id="name" placeholder="CS 101 - Programming in C" invalid={!!errors.name} {...register('name')} />
            </Field>

            {createCourse.error ? <Alert tone="danger">{createCourse.error.message}</Alert> : null}

            <Button type="submit" className="w-full" loading={isSubmitting || createCourse.isPending}>
              <Plus aria-hidden="true" size={15} />
              Create course
            </Button>
          </form>
        </Card>
      </div>

      <div className="mt-6">
        <Sandbox />
      </div>
    </>
  );
}
