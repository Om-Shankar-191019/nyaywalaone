const BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function raw(path, { method = 'GET', body, headers } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(
      response.status,
      error.code ?? 'HTTP_ERROR',
      error.message ?? `Request failed with status ${response.status}`,
      error.details,
    );
  }

  return payload?.data ?? null;
}

/**
 * One in-flight refresh at a time. Three components hitting a 401 together
 * must not rotate the refresh token three times - only one of those can win,
 * and the losers would look like token theft.
 */
let refreshInFlight = null;

function refreshSession() {
  refreshInFlight ??= fetch(`${BASE_URL}/auth/refresh`, { method: 'POST', credentials: 'include' })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

export async function request(path, options = {}) {
  try {
    return await raw(path, options);
  } catch (error) {
    const isAuthRoute = path.startsWith('/auth/');
    if (error instanceof ApiError && error.status === 401 && options.retryAuth !== false && !isAuthRoute) {
      if (await refreshSession()) return raw(path, options);
    }
    throw error;
  }
}

export const api = {
  get: (path, options) => request(path, options),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
  del: (path, options) => request(path, { ...options, method: 'DELETE' }),
};
