import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './src/config.js';
import { errorHandler, notFoundHandler } from './src/lib/http.js';
import { requestLogger } from './src/lib/logger.js';
import { originCheck } from './src/lib/origin.js';
import { courseAssignmentsRouter, assignmentsRouter } from './src/routes/assignments.js';
import { authRouter } from './src/routes/auth.js';
import { coursesRouter } from './src/routes/courses.js';
import { execRouter } from './src/routes/exec.js';
import { submissionsRouter } from './src/routes/submissions.js';
import { systemRouter } from './src/routes/system.js';

export function createApp() {
  const app = express();

  // Vercel terminates TLS in front of us, so trust exactly one proxy hop for
  // req.ip (rate limiting) without trusting arbitrary X-Forwarded-For values.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header (curl, server-to-server) is not a CORS request.
        if (!origin) return callback(null, true);
        return callback(null, config.allowedOrigins.includes(origin));
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use(originCheck);
  app.use(requestLogger);

  app.use('/api/courses/:courseId/assignments', courseAssignmentsRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/courses', coursesRouter);
  app.use('/api/assignments', assignmentsRouter);
  app.use('/api', submissionsRouter);
  app.use('/api/exec', execRouter);
  app.use('/api', systemRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp();
