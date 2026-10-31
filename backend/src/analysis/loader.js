import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

let cached;

const CANDIDATE_PATHS = (require) => {
  const candidates = [];
  try {
    const wasmsPkg = require.resolve('tree-sitter-wasms/package.json');
    candidates.push(path.join(path.dirname(wasmsPkg), 'out', 'tree-sitter-c.wasm'));
  } catch {
    // Package not installed: fall through to the vendored location.
  }
  candidates.push(path.resolve(process.cwd(), 'vendor', 'tree-sitter-c.wasm'));
  return candidates;
};

/**
 * Loads a C grammar for web-tree-sitter.
 *
 * The wasm ABI must match the runtime, and the exact pairing that works is
 * recorded in docs/decisions.md (ADR-002) because it is a real constraint, not
 * a detail. When it cannot load, callers get `{ ok: false, reason }` and the
 * static metrics degrade to "unavailable" instead of pretending to grade.
 */
export async function loadCParser() {
  if (cached) return cached;

  try {
    const mod = await import('web-tree-sitter');
    const Parser = mod.Parser ?? mod.default?.Parser ?? mod.default;
    const Language = mod.Language ?? mod.default?.Language;

    if (!Parser || typeof Parser.init !== 'function') {
      cached = { ok: false, reason: 'web-tree-sitter did not export a Parser' };
      return cached;
    }

    await Parser.init();

    const require = createRequire(import.meta.url);
    const wasmPath = CANDIDATE_PATHS(require).find((candidate) => existsSync(candidate));
    if (!wasmPath) {
      cached = { ok: false, reason: 'tree-sitter-c.wasm not found (install dev dependency tree-sitter-wasms)' };
      return cached;
    }

    // 0.24 exposes Language.load; older builds hang it off Parser.
    const language = Language?.load
      ? await Language.load(wasmPath)
      : await Parser.Language.load(wasmPath);

    const parser = new Parser();
    parser.setLanguage(language);

    cached = { ok: true, parser, wasmPath };
    return cached;
  } catch (error) {
    cached = { ok: false, reason: `grammar load failed: ${error.message}` };
    return cached;
  }
}

export const __resetParserCache = () => {
  cached = undefined;
};
