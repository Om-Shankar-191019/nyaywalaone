import { config } from '../config.js';
import { AppError } from './http.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The public origin the browser used to reach us, reconstructed from the
 * proxy headers Vercel/Cloudflare/nginx set. Only the first value of a
 * comma-separated list counts: the rest can be client-supplied.
 */
export function requestOrigin(req) {
  const first = (value) => String(value ?? '').split(',')[0].trim();

  const proto = first(req.get('x-forwarded-proto')) || req.protocol;
  const host = first(req.get('x-forwarded-host')) || first(req.get('host'));
  if (!proto || !host) return null;
  return `${proto}://${host}`;
}

/**
 * Is this browser origin allowed to mutate state?
 *
 * Two things qualify:
 *   1. It is listed in APP_ORIGIN / EXTRA_ALLOWED_ORIGINS (the dev server on
 *      :5173, a locally proxied frontend, an explicitly trusted domain).
 *   2. It is *our own* origin - the Origin the browser reports equals the host
 *      the request arrived on. This is the definition of same-origin, and it
 *      is what makes a Vercel deployment work: the frontend and the API share
 *      one public host, whose name nobody can know at build time. A preview
 *      deployment gets a new vercel.app subdomain on every push and therefore
 *      keeps working without touching environment variables.
 *
 * A cross-site attacker's page posts with Origin: https://evil.example to our
 * host, so (2) fails and (1) fails - and the browser only attaches our cookies
 * when the request really goes to our host, which a third-party page cannot do
 * with a forged Origin. SameSite=Lax on the cookies is the second layer.
 */
export function isAllowedOrigin(origin, req) {
  if (!origin) return true;
  if (config.allowedOrigins.includes(origin)) return true;
  return origin === requestOrigin(req);
}

/**
 * CSRF defence for cookie-authenticated mutations.
 *
 * A browser always sends Origin on a cross-site POST; a curl call or a test
 * sends none. So: no Origin means "not a browser" and is allowed, an allowed
 * Origin is accepted, and anything else is refused.
 */
export function originCheck(req, res, next) {
  if (!MUTATING.has(req.method)) return next();

  const origin = req.get('origin');
  if (isAllowedOrigin(origin, req)) return next();

  // Log the mismatch: on a fresh deployment this line answers "why is
  // registration 403" without a redeploy to print diagnostics.
  const hint = config.isProd
    ? ''
    : ` (allowed: ${config.allowedOrigins.join(', ')}, this host: ${requestOrigin(req) ?? 'unknown'})`;
  return next(new AppError(403, 'CSRF_ORIGIN', `Requests from ${origin} are not allowed${hint}`));
}
