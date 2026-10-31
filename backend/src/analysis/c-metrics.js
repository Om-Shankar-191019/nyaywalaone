import { loadCParser } from './loader.js';

/**
 * Deterministic structural metrics from a real parse tree.
 *
 * tree-sitter gives nodes, not regex guesses, which is what makes these
 * numbers stable enough to grade. Nothing here reads the clock, a random
 * source, or the filesystem, so the same source always yields the same object.
 */

const CONTROL_NODES = new Set([
  'if_statement',
  'for_statement',
  'while_statement',
  'do_statement',
  'case_statement',
  'conditional_expression',
]);

const LOOP_NODES = new Set(['for_statement', 'while_statement', 'do_statement']);

const childForField = (node, field) => {
  const child = node.childForFieldName?.(field);
  return child ?? null;
};

/** Function name from `int add(int a, int b) { ... }`. */
function functionName(node) {
  let declarator = childForField(node, 'declarator') ?? node.namedChildren?.[0];
  while (declarator) {
    if (declarator.type === 'identifier') return declarator.text;
    const inner = declarator.type === 'pointer_declarator' ? declarator.childForFieldName?.('declarator') : declarator.childForFieldName?.('declarator');
    if (!inner) break;
    declarator = inner;
  }
  return '(anonymous)';
}

function parameterCount(node) {
  const declarator = childForField(node, 'declarator');
  const params = declarator?.childForFieldName?.('parameters');
  if (!params) return 0;
  return params.namedChildren.filter((child) => child.type === 'parameter_declaration').length;
}

/** Depth-first walk with control-flow nesting depth. */
function walk(node, visit, depth = 0) {
  visit(node, depth);
  const nextDepth = CONTROL_NODES.has(node.type) || LOOP_NODES.has(node.type) ? depth + 1 : depth;
  for (const child of node.namedChildren ?? []) walk(child, visit, nextDepth);
}

function functionMetrics(node) {
  let cyclomatic = 1;
  let loops = 0;
  let branches = 0;
  let maxNesting = 0;

  walk(node, (child, depth) => {
    if (CONTROL_NODES.has(child.type)) {
      cyclomatic += 1;
      branches += 1;
      maxNesting = Math.max(maxNesting, depth + 1);
    }
    if (child.type === 'binary_expression') {
      const operator = child.childForFieldName?.('operator')?.text;
      if (operator === '&&' || operator === '||') {
        cyclomatic += 1;
        branches += 1;
      }
    }
    if (LOOP_NODES.has(child.type)) loops += 1;
  });

  const lines = node.endPosition.row - node.startPosition.row + 1;

  return {
    name: functionName(node),
    startLine: node.startPosition.row + 1,
    lines,
    params: parameterCount(node),
    cyclomatic,
    loops,
    branches,
    maxNesting,
  };
}

/**
 * @param {string} source C source text
 * @returns {Promise<{available: boolean, reason?: string, metrics: object|null}>}
 */
export async function analyzeC(source) {
  const loaded = await loadCParser();
  if (!loaded.ok) return { available: false, reason: loaded.reason, metrics: null };

  const tree = loaded.parser.parse(source);
  if (!tree) return { available: false, reason: 'parser returned no tree', metrics: null };

  const functions = [];
  let ifCount = 0;
  let loopCount = 0;
  let commentLines = 0;
  let parseErrors = 0;

  walk(tree.rootNode, (node) => {
    if (node.type === 'function_definition') functions.push(functionMetrics(node));
    if (node.type === 'if_statement') ifCount += 1;
    if (LOOP_NODES.has(node.type)) loopCount += 1;
    if (node.type === 'comment') commentLines += node.text.split('\n').length;
    if (node.type === 'ERROR') parseErrors += 1;
  });

  const totalLines = tree.rootNode.endPosition.row + 1;
  const cyclomaticValues = functions.map((fn) => fn.cyclomatic);

  return {
    available: true,
    reason: null,
    metrics: {
      parser: 'tree-sitter-c',
      totalLines,
      functions: functions.length,
      ifs: ifCount,
      loops: loopCount,
      commentLines,
      parseErrors,
      cyclomaticTotal: cyclomaticValues.reduce((sum, value) => sum + value, 0),
      cyclomaticMax: cyclomaticValues.length ? Math.max(...cyclomaticValues) : 0,
      maxNesting: functions.reduce((max, fn) => Math.max(max, fn.maxNesting), 0),
      longestFunction: functions.reduce((max, fn) => Math.max(max, fn.lines), 0),
      mainLines: functions.find((fn) => fn.name === 'main')?.lines ?? 0,
      perFunction: functions,
    },
  };
}
