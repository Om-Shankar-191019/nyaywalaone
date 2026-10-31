const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const active = LEVELS[process.env.LOG_LEVEL] ?? (process.env.NODE_ENV === 'production' ? LEVELS.warn : LEVELS.info);

const write = (level, message, meta) => {
  if (LEVELS[level] > active) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
  if (meta !== undefined) console[level === 'debug' ? 'log' : level](line, meta);
  else console[level === 'debug' ? 'log' : level](line);
};

export const logger = {
  error: (message, meta) => write('error', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  info: (message, meta) => write('info', message, meta),
  debug: (message, meta) => write('debug', message, meta),
};

/** One line per request in development; quiet in production. */
export function requestLogger(req, res, next) {
  if (active < LEVELS.info) return next();
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.info(`${req.method} ${req.originalUrl} -> ${res.statusCode} ${ms.toFixed(0)}ms`);
  });
  next();
}
