import { loadCParser } from './loader.js';

/**
 * Memory patterns from the AST.
 *
 * Everything here is a heuristic and says so: a `free` inside a branch that
 * never runs looks the same as a missing `free` from the syntax tree alone.
 * Findings are therefore labelled "possible" and a human can check the line.
 */
const ALLOCATORS = new Set(['malloc', 'calloc', 'realloc', 'strdup']);
const UNBOUNDED_SCAN = /%s/;

const childForField = (node, field) => node?.childForFieldName?.(field) ?? null;

function assignedName(callNode) {
  const parent = callNode.parent;
  if (!parent) return null;
  if (parent.type === 'init_declarator') return childForField(parent, 'declarator')?.text ?? null;
  if (parent.type === 'assignment_expression') return childForField(parent, 'left')?.text ?? null;
  return null;
}

function cleanIdentifier(text) {
  return String(text ?? '')
    .replace(/^[*&(\s]+/, '')
    .replace(/[)\s]+$/, '')
    .split('[')[0]
    .trim();
}

function functionNameNode(node) {
  let declarator = childForField(node, 'declarator') ?? node.namedChildren?.[0];
  while (declarator) {
    if (declarator.type === 'identifier') return declarator.text;
    const inner = childForField(declarator, 'declarator');
    if (!inner) break;
    declarator = inner;
  }
  return '(anonymous)';
}

function inspectFunction(fnNode, banned) {
  const allocs = [];
  const frees = [];
  const bannedCalls = [];
  const nullChecked = new Set();
  const name = functionNameNode(fnNode);

  const visit = (node) => {
    if (node.type === 'if_statement') {
      const condition = childForField(node, 'condition')?.text ?? '';
      for (const identifier of condition.match(/[A-Za-z_]\w*/g) ?? []) nullChecked.add(identifier);
    }

    if (node.type === 'call_expression') {
      const callee = childForField(node, 'function')?.text ?? '';
      const args = childForField(node, 'arguments');

      if (ALLOCATORS.has(callee)) {
        allocs.push({ call: callee, variable: assignedName(node), line: node.startPosition.row + 1 });
      }
      if (callee === 'free' || callee === 'cfree') {
        frees.push({ variable: cleanIdentifier(args?.namedChildren?.[0]?.text), line: node.startPosition.row + 1 });
      }
      if (banned.includes(callee)) {
        bannedCalls.push({ name: callee, line: node.startPosition.row + 1 });
      }
      if (callee === 'scanf' || callee === 'fscanf' || callee === 'sscanf') {
        const format = args?.namedChildren?.map((arg) => arg.text).find((text) => text.startsWith('"')) ?? '';
        if (UNBOUNDED_SCAN.test(format) && !/%\d+s/.test(format)) {
          bannedCalls.push({ name: `${callee}("%s")`, line: node.startPosition.row + 1 });
        }
      }
    }
    for (const child of node.namedChildren ?? []) visit(child);
  };

  visit(fnNode);

  const findings = [];
  for (const call of bannedCalls) {
    findings.push({ kind: 'banned_function', function: name, name: call.name, line: call.line });
  }

  const freeCount = new Map();
  for (const site of frees) {
    if (!site.variable) continue;
    freeCount.set(site.variable, (freeCount.get(site.variable) ?? 0) + 1);
  }
  for (const [variable, count] of freeCount) {
    if (count > 1) findings.push({ kind: 'double_free', function: name, variable, line: frees.find((site) => site.variable === variable)?.line ?? 0 });
  }

  for (const alloc of allocs) {
    if (!alloc.variable) continue;
    const freed = frees.some((site) => site.variable === alloc.variable);
    if (!freed) {
      findings.push({
        kind: 'possible_leak',
        function: name,
        variable: alloc.variable,
        call: alloc.call,
        line: alloc.line,
      });
    }
    if (!nullChecked.has(alloc.variable)) {
      findings.push({ kind: 'unchecked_alloc', function: name, variable: alloc.variable, line: alloc.line });
    }
  }

  return { allocs, frees, findings };
}

export async function analyzeCPatterns(source, { banned = [], checkLeaks = true, checkUnchecked = true } = {}) {
  const loaded = await loadCParser();
  if (!loaded.ok) return { available: false, reason: loaded.reason, findings: [] };

  const tree = loaded.parser.parse(source);
  if (!tree) return { available: false, reason: 'parser returned no tree', findings: [] };

  const findings = [];
  let allocCount = 0;
  let freeCount = 0;

  const visit = (node) => {
    if (node.type === 'function_definition') {
      const result = inspectFunction(node, banned);
      allocCount += result.allocs.length;
      freeCount += result.frees.length;
      for (const finding of result.findings) {
        if (finding.kind === 'possible_leak' && !checkLeaks) continue;
        if (finding.kind === 'unchecked_alloc' && !checkUnchecked) continue;
        findings.push(finding);
      }
    }
    for (const child of node.namedChildren ?? []) visit(child);
  };

  visit(tree.rootNode);

  return { available: true, reason: null, allocCount, freeCount, findings };
}
