import jwt from 'jsonwebtoken';
import { config } from '../config.js';

const ISSUER = 'nyaywala';
const AUDIENCE = 'nyaywala-web';

/**
 * Access tokens are short-lived (15 min) and carry only the identity and role.
 * Anything else belongs in the database, because a token cannot be revoked.
 */
export function signAccessToken({ userId, role }, { expiresIn = config.ACCESS_TOKEN_TTL } = {}) {
  return jwt.sign({ role }, config.ACCESS_TOKEN_SECRET, {
    subject: userId,
    expiresIn,
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithm: 'HS256',
  });
}

/** Returns the decoded payload, or null if the token is missing/invalid/expired. */
export function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, config.ACCESS_TOKEN_SECRET, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    if (typeof payload !== 'object' || !payload.sub || !payload.role) return null;
    return { userId: payload.sub, role: payload.role };
  } catch {
    return null;
  }
}
