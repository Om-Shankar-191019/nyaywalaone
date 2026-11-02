import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link, Navigate, useNavigate } from "react-router";
import { dashboardPath, useAuth } from "../../auth/AuthProvider.jsx";
import { Alert, Button, Field, Input } from "../../components/ui.jsx";
import { loginSchema } from "../../lib/validation.js";
import { AuthLayout } from "./AuthLayout.jsx";

/** Resource URLs may belong to a different user, so start each session at its dashboard. */
const safeDestination = (role) => dashboardPath(role);

export function Login() {
  const { status, user, login } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  if (status === "authenticated") {
    return <Navigate to={safeDestination(user.role)} replace />;
  }

  const onSubmit = async (values) => {
    setError(null);
    try {
      const signedIn = await login(values);
      navigate(safeDestination(signedIn.role), { replace: true });
    } catch (failure) {
      setError(failure);
    }
  };

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Use the account your instructor or admin set up for you."
      footer={
        <>
          No account yet?{" "}
          <Link
            to="/register"
            className="font-medium text-brand hover:underline"
          >
            Create one
          </Link>
        </>
      }
    >
      <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
        {error ? <Alert tone="danger">{error.message}</Alert> : null}

        <Field label="Email" htmlFor="email" error={errors.email?.message}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.edu"
            invalid={!!errors.email}
            {...register("email")}
          />
        </Field>

        <Field
          label="Password"
          htmlFor="password"
          error={errors.password?.message}
        >
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            placeholder="Your password"
            invalid={!!errors.password}
            {...register("password")}
          />
        </Field>

        <Button type="submit" className="w-full" loading={isSubmitting}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
