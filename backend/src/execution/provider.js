import { config } from '../config.js';
import { AppError } from '../lib/http.js';
import { createJudge0Provider } from './judge0.js';
import { createWandboxProvider } from './wandbox.js';

const instances = new Map();

/**
 * Everything that executes C goes through this seam. Moving to another
 * provider is an environment change (`EXECUTION_PROVIDER`), not a rewrite.
 */
export function getProvider(name = config.EXECUTION_PROVIDER) {
  if (!instances.has(name)) {
    if (name === 'judge0') instances.set(name, createJudge0Provider());
    else if (name === 'wandbox') instances.set(name, createWandboxProvider());
    else throw new AppError(500, 'PROVIDER_UNKNOWN', `Unknown EXECUTION_PROVIDER: ${name}`);
  }
  return instances.get(name);
}

export const availableProviders = () => ['judge0', 'wandbox'];
