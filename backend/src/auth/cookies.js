import { config } from '../config.js';

export const ACCESS_COOKIE = 'ag_at';
export const REFRESH_COOKIE = 'ag_rt';

/** Refresh cookie is scoped to the auth routes so it is not sent on every call. */
const REFRESH_PATH = '/api/auth';

const base = () => ({
  httpOnly: true,
  secure: config.isProd,
  sameSite: 'lax',
  ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {}),
});

export function setAuthCookies(res, { accessToken, refreshToken }) {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...base(),
    path: '/',
    maxAge: config.accessTokenTtlSeconds * 1000,
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...base(),
    path: REFRESH_PATH,
    maxAge: config.refreshTokenTtlMs,
  });
}

export function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { ...base(), path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base(), path: REFRESH_PATH });
}
