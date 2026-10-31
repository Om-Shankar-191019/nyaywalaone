import { loadCParser } from './loader.js';

/**
 * Order-class inference from the parse tree, not from a stopwatch.
 *
 * Timing on a shared runner cannot separate O(1) from O(n) at n = 10, and the
 * same program can be three times slower on a busy host. A grade that moves
 * when the host is busy is not a grade, so the class comes from loop bounds and
 * recursion, and timing is at most corroboration.
 */
const LOOP_NODES = new Set(['for_statement', 'while_statement', 'do_statement']);

const RANK = {
  'O(1)': 0,
  'O(log n)': 1,
  'O(n)': 2,
  'O(n log n)': 3,
  'O(n^2)': 4,
  'O(n^3)': 5,
  'O(2^n)': 6,
  unknown: 7,
};

export const orderRank = (orderClass) => RANK[orderClass] ?? 7;

const childForField = (node, field) => node?.childForFieldName?.(field) ?? null;

function functionName(node) {
  let declarator = childForField(node, 'declarator') ?? node.namedChildren?.[0];
  while (declarator) {
    if (declarator.type === 'identifier') return declarator.text;
    const inner = childForField(declarator, 'declarator');
    if (!inner) break;
    declarator = inner;
  }
  return '(anonymous)';
}

/** `i /= 2`, `i *= 2`, `i <<= 1`, `n / 2` - a logarithmic or n-log-n factor. */
function looksLogarithmic(loop) {
  const text = [childForField(loop, 'update'), childForField(loop, 'condition')]
    .filter(Boolean)
    .map((node) => node.text)
    .join(' ');
  return /\/=\s*2|\*=\s*2|<<=\s*1|\/\s*2\b|\*\s*2\b/.test(text);
}

function countSelfCalls(node, name) {
  let calls = 0;
  const visit = (current) => {
    if (current.type === 'call_expression' && childForField(current, 'function')?.text === name) calls += 1;
    for (const child of current.namedChildren ?? []) visit(child);
  };
  visit(node);
  return calls;
}

function loopProfile(functionNode) {
  let maxDepth = 0;
  let loops = 0;
  let logLoop = false;

  const visit = (node, depth) => {
    if (LOOP_NODES.has(node.type)) {
      loops += 1;
      maxDepth = Math.max(maxDepth, depth + 1);
      if (looksLogarithmic(node)) logLoop = true;
      for (const child of node.namedChildren ?? []) visit(child, depth + 1);
      return;
    }
    for (const child of node.namedChildren ?? []) visit(child, depth);
  };

  for (const child of functionNode.namedChildren ?? []) visit(child, 0);
  return { maxDepth, loops, logLoop };
}

function classify({ maxDepth, logLoop, selfCalls }) {
  if (selfCalls >= 2) return 'O(2^n)';
  if (selfCalls === 1) return logLoop ? 'O(log n)' : 'O(n)';
  if (maxDepth === 0) return 'O(1)';
  if (logLoop && maxDepth === 1) return 'O(log n)';
  if (logLoop && maxDepth === 2) return 'O(n log n)';
  if (maxDepth === 1) return 'O(n)';
  if (maxDepth === 2) return 'O(n^2)';
  return 'O(n^3)';
}

export async function estimateComplexity(source) {
  const loaded = await loadCParser();
  if (!loaded.ok) return { available: false, reason: loaded.reason, orderClass: 'unknown', perFunction: [] };

  const tree = loaded.parser.parse(source);
  if (!tree) return { available: false, reason: 'parser returned no tree', orderClass: 'unknown', perFunction: [] };

  const perFunction = [];
  let maxNesting = 0;
  let parseErrors = 0;

  const visit = (node) => {
    if (node.type === 'ERROR') parseErrors += 1;
    if (node.type === 'function_definition') {
      const name = functionName(node);
      const profile = loopProfile(node);
      const selfCalls = name === '(anonymous)' ? 0 : countSelfCalls(node, name);
      const orderClass = classify({ ...profile, selfCalls });
      maxNesting = Math.max(maxNesting, profile.maxDepth);
      perFunction.push({
        name,
        line: node.startPosition.row + 1,
        loops: profile.loops,
        maxLoopDepth: profile.maxDepth,
        logLoop: profile.logLoop,
        selfCalls,
        orderClass,
      });
    }
    for (const child of node.namedChildren ?? []) visit(child);
  };

  visit(tree.rootNode);

  const orderClass = perFunction.reduce(
    (worst, fn) => (orderRank(fn.orderClass) > orderRank(worst) ? fn.orderClass : worst),
    'O(1)',
  );

  return {
    available: true,
    reason: null,
    orderClass: perFunction.length ? orderClass : 'unknown',
    maxNesting,
    parseErrors,
    perFunction,
  };
}
