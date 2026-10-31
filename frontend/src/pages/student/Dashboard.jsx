import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, KeyRound, Users } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { api } from '../../api/client.js';
import { useAuth } from '../../auth/AuthProvider.jsx';
import { EmptyState, ErrorState } from '../../components/states.jsx';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, LinkButton, PageHeader } from '../../components/ui.jsx';
import { joinCourseSchema } from '../../lib/validation.js';

export function StudentDashboard() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const coursesQuery = useQuery({ queryKey: ['courses'], queryFn: () => api.get('/courses') });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm({ resolver: zodResolver(joinCourseSchema), defaultValues: { code: '' } });

  const joinMutation = useMutation({
    mutationFn: (values) => api.post('/courses/join', values),
    onSuccess: async () => {
      reset();
      await queryClient.invalidateQueries({ queryKey: ['courses'] });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });

  const onSubmit = async (values) => {
    await joinMutation.mutateAsync(values).catch(() => null);
  };

  const courses = coursesQuery.data?.courses ?? [];

  return (
    <>
      <PageHeader
        eyebrow={`Welcome, ${user.fullName}`}
        title="My courses"
        description="Join a course with the code your instructor gave you, then open an assignment to submit your C file and read the graded report."
      />

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr] lg:items-start">
        <Card>
          <CardHeader
            title="Enrolled courses"
            description={courses.length ? `${courses.length} active` : 'Nothing yet'}
            action={<Badge tone="neutral">Student</Badge>}
          />

          {coursesQuery.isLoading ? (
            <p className="px-5 py-8 text-sm text-muted">Loading your courses...</p>
          ) : coursesQuery.isError ? (
            <div className="p-5">
              <ErrorState error={coursesQuery.error} onRetry={coursesQuery.refetch} />
            </div>
          ) : courses.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title="No courses yet"
              description="Ask your instructor for the 8-character join code, then enter it in the panel beside this card."
            />
          ) : (
            <ul className="divide-y divide-line">
              {courses.map((course) => (
                <li key={course.id} className="flex items-center justify-between gap-4 px-5 py-3.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">{course.name}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {course.instructor?.fullName ?? 'Instructor'} · {course._count?.assignments ?? 0} assignment
                      {course._count?.assignments === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Users aria-hidden="true" size={16} className="text-muted" />
                    <LinkButton to={`/student/courses/${course.id}`} size="sm" variant="secondary">
                      Open
                    </LinkButton>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Join a course" description="Enter the code shared by your instructor." />
          <form className="space-y-3 p-5" onSubmit={handleSubmit(onSubmit)} noValidate>
            <Field label="Join code" htmlFor="code" error={errors.code?.message} hint="8 characters, case-insensitive.">
              <Input
                id="code"
                placeholder="ADDC2026"
                autoComplete="off"
                autoCapitalize="characters"
                className="font-mono tracking-[0.18em] uppercase"
                invalid={!!errors.code}
                {...register('code')}
              />
            </Field>

            {joinMutation.error ? <Alert tone="danger">{joinMutation.error.message}</Alert> : null}
            {joinMutation.isSuccess ? <Alert tone="success">Joined. The course is now in your list.</Alert> : null}

            <Button type="submit" className="w-full" loading={isSubmitting || joinMutation.isPending}>
              <KeyRound aria-hidden="true" size={15} />
              Join course
            </Button>
          </form>
        </Card>
      </div>
    </>
  );
}
