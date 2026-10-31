import { config } from '../config.js';
import { AppError } from '../lib/http.js';
import { createJudge0Provider } from './judge0.js';
import { createOnlineCompilerProvider } from './onlinecompiler.js';
import { createWandboxProvider } from './wandbox.js';

const instances = new Map();

const FACTORIES = {
  onlinecompiler: createOnlineCompilerProvider,
  judge0: createJudge0Provider,
  wandbox: createWandboxProvider,
};

/**
 * Everything that executes C goes through this seam. Moving to another
 * provider is an environment change (`EXECUTION_PROVIDER`), not a rewrite.
 */
export function getProvider(name = config.EXECUTION_PROVIDER) {
  if (!instances.has(name)) {
    const factory = FACTORIES[name];
    if (!factory) throw new AppError(500, 'PROVIDER_UNKNOWN', `Unknown EXECUTION_PROVIDER: ${name}`);
    instances.set(name, factory());
  }
  return instances.get(name);
}

export const availableProviders = () => Object.keys(FACTORIES);

/**
 * Capabilities for a provider, with conservative defaults for the ones that do
 * not declare any. A provider that says nothing is assumed to honour flags,
 * because that is what Judge0 does.
 */
export function capabilitiesOf(name = config.EXECUTION_PROVIDER) {
  return (
    getProvider(name).capabilities ?? {
      compilerFlags: true,
      cpuTimeLimit: true,
      memoryLimit: true,
      processLimit: true,
      networkControl: true,
      perRunTimeLimit: true,
      maxTimeLimitSeconds: 20,
      synchronous: false,
    }
  );
}
