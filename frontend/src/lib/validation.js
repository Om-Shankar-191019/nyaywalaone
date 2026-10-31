import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().trim().min(1, 'Enter your email').email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});

export const registerSchema = z.object({
  fullName: z.string().trim().min(2, 'Use at least 2 characters').max(120),
  email: z.string().trim().min(1, 'Enter your email').email('Enter a valid email address'),
  password: z.string().min(10, 'Use at least 10 characters').max(200),
  role: z.enum(['student', 'instructor']),
  instructorCode: z.string().optional(),
});

export const joinCourseSchema = z.object({
  code: z.string().trim().min(6, 'Join codes are 8 characters').max(12),
});

export const createCourseSchema = z.object({
  name: z.string().trim().min(3, 'Use at least 3 characters').max(120),
});
