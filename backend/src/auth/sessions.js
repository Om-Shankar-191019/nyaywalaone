import { config } from '../config.js';
import { prisma } from '../db.js';
import { randomToken, sha256Hex } from '../lib/hash.js';
import { unauthenticated } from '../lib/http.js';
import { REFRESH_COOKIE, clearAuthCookies, setAuthCookies } from './cookies.js';
import { signAccessToken } from './jwt.js';

/**
 * Refresh tokens are 256-bit random strings. Only their SHA-256 is stored, so
 * a database dump does not hand an attacker live sessions.
 */
export async function issueSession(res, user, userAgent) {
  const refreshToken = randomToken(32);

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256Hex(refreshToken),
      expiresAt: new Date(Date.now() + config.refreshTokenTtlMs),
      userAgent: userAgent ? String(userAgent).slice(0, 255) : null,
    },
  });

  setAuthCookies(res, {
    accessToken: signAccessToken({ userId: user.id, role: user.role }),
    refreshToken,
  });
}

/** Revoke every live session for a user (used on replay detection). */
async function revokeAllSessions(userId) {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Rotate the refresh token: the presented token is revoked and a new one is
 * issued. Presenting an already-revoked token means it leaked, so every
 * session for that user is revoked and the caller gets 401.
 */
export async function rotateSession(req, res) {
  const raw = req.cookies?.[REFRESH_COOKIE];
  if (!raw) throw unauthenticated('No refresh session');

  const row = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256Hex(raw) },
    include: { user: true },
  });

  if (!row) throw unauthenticated('Invalid refresh session');

  if (row.revokedAt) {
    await revokeAllSessions(row.userId);
    clearAuthCookies(res);
    throw unauthenticated('Refresh token reuse detected; all sessions were revoked');
  }

  if (row.expiresAt.getTime() <= Date.now()) {
    clearAuthCookies(res);
    throw unauthenticated('Refresh session expired');
  }

  // Atomic: two tabs refreshing at once must not both succeed.
  const revoked = await prisma.refreshToken.updateMany({
    where: { id: row.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  if (revoked.count === 0) {
    await revokeAllSessions(row.userId);
    clearAuthCookies(res);
    throw unauthenticated('Refresh token reuse detected; all sessions were revoked');
  }

  await issueSession(res, row.user, req.headers['user-agent']);
  return row.user;
}

/** Revoke the presented refresh token, if any, and clear both cookies. */
export async function endSession(req, res) {
  const raw = req.cookies?.[REFRESH_COOKIE];
  if (raw) {
    await prisma.refreshToken.updateMany({
      where: { tokenHash: sha256Hex(raw), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  clearAuthCookies(res);
}

