import { prisma } from '../db.js';
import { forbidden, unauthenticated } from '../lib/http.js';
import { ACCESS_COOKIE } from './cookies.js';
import { verifyAccessToken } from './jwt.js';

/**
 * Route-level authentication. The role is re-read from the database rather
 * than trusted from the token, so a role change takes effect immediately and
 * the client can never assert its own role.
 */
export function requireAuth(req, res, next) {
  const token = req.cookies?.[ACCESS_COOKIE];
  const payload = token ? verifyAccessToken(token) : null;
  if (!payload) return next(unauthenticated('Access token missing or expired'));

  return prisma.user
    .findUnique({ where: { id: payload.userId } })
    .then((user) => {
      if (!user) return next(unauthenticated('Account no longer exists'));
      req.user = { id: user.id, email: user.email, role: user.role, fullName: user.fullName };
      return next();
    })
    .catch(next);
}

/** Route-level authorisation, applied after requireAuth. */
export const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (!req.user) return next(unauthenticated());
    if (!roles.includes(req.user.role)) {
      return next(forbidden(`This action requires the ${roles.join(' or ').toLowerCase()} role`));
    }
    return next();
  };

export const publicUser = (user) => ({
  id: user.id,
  email: user.email,
  fullName: user.fullName,
  role: user.role,
  createdAt: user.createdAt,
});
