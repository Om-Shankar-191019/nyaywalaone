import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { hashPassword, burnPasswordTime, verifyPassword } from '../auth/password.js';
import { publicUser, requireAuth } from '../auth/middleware.js';
import { endSession, issueSession, rotateSession } from '../auth/sessions.js';
import { AppError, asyncHandler, conflict, forbidden, send, unauthenticated } from '../lib/http.js';
import { createRateLimiter } from '../lib/rateLimit.js';

export const authRouter = Router();

const emailField = z
  .string({ required_error: 'Email is required' })
  .trim()
  .toLowerCase()
  .email('Enter a valid email address')
  .max(254);

const registerSchema = z.object({
  fullName: z.string({ required_error: 'Full name is required' }).trim().min(2, 'Use at least 2 characters').max(120),
  email: emailField,
  password: z.string().min(10, 'Use at least 10 characters').max(200),
  role: z.enum(['student', 'instructor']).default('student'),
  instructorCode: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, 'Email is required'),
  password: z.string().min(1, 'Password is required'),
});

/**
 * Credential endpoints are limited per IP+email. 5 attempts a minute stops a
 * script while leaving room for a human who mistyped twice.
 */
const credentialLimiter = () =>
  createRateLimiter({
    windowMs: 60_000,
    max: 5,
    keyFn: (req) =>
      `${req.ip}:${String(req.body?.email ?? '')
        .trim()
        .toLowerCase()}`,
  });

const loginLimiter = credentialLimiter();
const registerLimiter = credentialLimiter();

authRouter.post(
  '/register',
  registerLimiter,
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);

    if (body.role === 'instructor' && config.INSTRUCTOR_SIGNUP_CODE) {
      if (body.instructorCode !== config.INSTRUCTOR_SIGNUP_CODE) {
        throw forbidden('The instructor signup code is missing or incorrect');
      }
    }

    const existing = await prisma.user.findUnique({ where: { email: body.email }, select: { id: true } });
    if (existing) throw conflict('EMAIL_TAKEN', 'An account with that email already exists');

    const user = await prisma.user.create({
      data: {
        email: body.email,
        fullName: body.fullName,
        passwordHash: await hashPassword(body.password),
        role: body.role === 'instructor' ? 'INSTRUCTOR' : 'STUDENT',
      },
    });

    await issueSession(res, user, req.headers['user-agent']);
    return send(res, { user: publicUser(user), enrollments: [] }, 201);
  }),
);

authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { email: body.email } });

    if (!user) {
      // Same cost as a real comparison, same message as a wrong password.
      await burnPasswordTime(body.password);
      throw unauthenticated('Invalid email or password');
    }

    const valid = await verifyPassword(body.password, user.passwordHash);
    if (!valid) throw unauthenticated('Invalid email or password');

    await issueSession(res, user, req.headers['user-agent']);

    const enrollments = await prisma.enrollment.findMany({
      where: { studentId: user.id },
      include: { course: { select: { id: true, name: true, joinCode: true } } },
    });

    return send(res, {
      user: publicUser(user),
      enrollments: enrollments.map((row) => row.course),
    });
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const user = await rotateSession(req, res);
    return send(res, { user: publicUser(user) });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await endSession(req, res);
    return send(res, { loggedOut: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'Account no longer exists');

    const enrollments = await prisma.enrollment.findMany({
      where: { studentId: user.id },
      include: { course: { select: { id: true, name: true, joinCode: true } } },
      orderBy: { enrolledAt: 'asc' },
    });

    const taughtCount = user.role === 'INSTRUCTOR' ? await prisma.course.count({ where: { instructorId: user.id } }) : 0;

    return send(res, {
      user: publicUser(user),
      enrollments: enrollments.map((row) => row.course),
      taughtCount,
    });
  }),
);
