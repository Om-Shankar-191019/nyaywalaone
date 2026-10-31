import { config } from '../config.js';
import { AppError } from './http.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defence for cookie-authenticated mutations.
 *
 * A browser always sends Origin on a cross-site POST; a curl call or a test
 * sends none. So: no Origin means "not a browser" and is allowed, a matching
 * Origin is allowed, and anything else is refused. SameSite=Lax on the cookies
 * is the second layer.
 */
export function originCheck(req, res, next) {
  if (!MUTATING.has(req.method)) return next();

  const origin = req.get('origin');
  if (!origin) return next();
  if (config.allowedOrigins.includes(origin)) return next();

  return next(new AppError(403, 'CSRF_ORIGIN', `Requests from ${origin} are not allowed`));
}
