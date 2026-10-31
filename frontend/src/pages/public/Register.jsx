import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useNavigate } from 'react-router';
import { api } from '../../api/client.js';
import { dashboardPath, useAuth } from '../../auth/AuthProvider.jsx';
import { Alert, Button, Field, Input } from '../../components/ui.jsx';
import { registerSchema } from '../../lib/validation.js';
import { AuthLayout } from './AuthLayout.jsx';

export function Register() {
  const { status, user, applySession } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(registerSchema),
    defaultValues: { fullName: '', email: '', password: '', role: 'student', instructorCode: '' },
  });

  const role = watch('role');

  if (status === 'authenticated') return <Navigate to={dashboardPath(user.role)} replace />;

  const onSubmit = async (values) => {
    setError(null);
    try {
      // Registration returns the same session payload as login and has
      // already set the cookies, so no second request is needed.
      const data = await api.post('/auth/register', values);
      await applySession(data);
      navigate(dashboardPath(data.user.role), { replace: true });
    } catch (failure) {
      setError(failure);
    }
  };

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Students join a course with a code. Instructors need the signup code from their admin."
      footer={
        <>
          Already registered?{' '}
          <Link to="/login" className="font-medium text-brand hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
        {error ? <Alert tone="danger">{error.message}</Alert> : null}

        <Field label="Full name" htmlFor="fullName" error={errors.fullName?.message}>
          <Input id="fullName" autoComplete="name" placeholder="Ada Lovelace" invalid={!!errors.fullName} {...register('fullName')} />
        </Field>

        <Field label="Email" htmlFor="email" error={errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" placeholder="you@example.edu" invalid={!!errors.email} {...register('email')} />
        </Field>

        <Field label="Password" htmlFor="password" error={errors.password?.message} hint="At least 10 characters.">
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            placeholder="Choose a password"
            invalid={!!errors.password}
            {...register('password')}
          />
        </Field>

        <fieldset>
          <legend className="label">I am a</legend>
          <div className="grid grid-cols-2 gap-2">
            {[
              { value: 'student', label: 'Student', hint: 'Join courses, submit code' },
              { value: 'instructor', label: 'Instructor', hint: 'Run courses, set grading rules' },
            ].map((option) => (
              <label
                key={option.value}
                className={`cursor-pointer rounded-lg border p-2.5 text-xs transition ${
                  role === option.value ? 'border-brand bg-brand/10 text-fg' : 'border-line text-muted hover:border-muted/50'
                }`}
              >
                <input type="radio" value={option.value} className="sr-only" {...register('role')} />
                <span className="block text-sm font-semibold">{option.label}</span>
                <span className="mt-0.5 block leading-snug">{option.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {role === 'instructor' ? (
          <Field label="Instructor signup code" htmlFor="instructorCode" error={errors.instructorCode?.message}>
            <Input id="instructorCode" placeholder="Provided by your admin" {...register('instructorCode')} />
          </Field>
        ) : null}

        <Button type="submit" className="w-full" loading={isSubmitting}>
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}
