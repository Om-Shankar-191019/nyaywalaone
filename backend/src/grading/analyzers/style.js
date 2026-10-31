import { z } from 'zod';
import { analyzeC } from '../../analysis/c-metrics.js';
import { clamp01, decayScore, round3 } from '../score.js';

export const paramsSchema = z
  .object({
    min_name_length: z.number().int().min(1).max(10).default(3),
    min_comment_ratio: z.number().min(0).max(0.5).default(0.03),
    max_line_length: z.number().int().min(40).max(240).default(100),
  })
  .strict();

const KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern',
  'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'restrict', 'return', 'short', 'signed',
  'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while',
  'include', 'define', 'ifdef', 'ifndef', 'endif', 'printf', 'scanf', 'main', 'std', 'h',
]);

const identifierScore = (source, minLength) => {
  const names = (source.match(/\b[A-Za-z_]\w*\b/g) ?? []).filter((name) => !KEYWORDS.has(name));
  if (!names.length) return { score: 0, average_length: 0, single_letter_ratio: 0, count: 0 };
  const single = names.filter((name) => name.length === 1).length;
  const average = names.reduce((sum, name) => sum + name.length, 0) / names.length;
  const singleRatio = single / names.length;
  // Long names are not automatically good; this rewards "descriptive enough".
  const lengthScore = clamp01((average - (minLength - 1.5)) / 3);
  return {
    score: clamp01(lengthScore * (1 - singleRatio)),
    average_length: Math.round(average * 10) / 10,
    single_letter_ratio: Math.round(singleRatio * 1000) / 1000,
    count: names.length,
  };
};

/**
 * Readability, measured rather than judged: identifier length and single-letter
 * ratio, comment coverage, line length, indentation consistency. No LLM is
 * involved, so the number is the same on every run.
 */
export const styleAnalyzer = {
  name: 'style_analysis',
  supports: ['source'],
  paramsSchema,

  async run(ctx, params) {
    const source = ctx.source;
    const lines = source.split('\n');
    const nonEmpty = lines.filter((line) => line.trim().length > 0);
    const maxLine = lines.reduce((max, line) => Math.max(max, line.length), 0);
    const longLines = lines.filter((line) => line.length > params.max_line_length).length;

    const analysis = await analyzeC(source);
    const totalLines = analysis.available ? Math.max(1, analysis.metrics.totalLines) : lines.length;
    const commentLines = analysis.available ? analysis.metrics.commentLines : (source.match(/^\s*(\/\/|\/\*)/gm) ?? []).length;
    const commentRatio = commentLines / totalLines;

    const tabIndented = nonEmpty.filter((line) => /^\t+/.test(line)).length;
    const spaceIndented = nonEmpty.filter((line) => /^ {2,}\S/.test(line)).length;
    const mixedIndentation = tabIndented > 0 && spaceIndented > 0;
    const trailingWhitespace = lines.filter((line) => /[ \t]+$/.test(line)).length;

    const names = identifierScore(source, params.min_name_length);
    const componentScores = {
      names: names.score,
      comments: clamp01(commentRatio / Math.max(params.min_comment_ratio, 0.001)),
      line_length: decayScore(maxLine, params.max_line_length, params.max_line_length * 1.5),
      indentation: mixedIndentation ? 0 : 0.25 + (trailingWhitespace === 0 ? 0.75 : 0.4),
    };

    const score = clamp01(
      0.35 * componentScores.names +
        0.25 * componentScores.comments +
        0.2 * componentScores.line_length +
        0.2 * componentScores.indentation,
    );

    const notes = [];
    if (names.single_letter_ratio > 0.25) notes.push(`${Math.round(names.single_letter_ratio * 100)}% of identifiers are one letter`);
    if (commentRatio < params.min_comment_ratio) notes.push(`comments cover ${(commentRatio * 100).toFixed(1)}% of lines`);
    if (longLines) notes.push(`${longLines} line${longLines === 1 ? '' : 's'} over ${params.max_line_length} characters`);
    if (mixedIndentation) notes.push('tabs and spaces are mixed');
    if (trailingWhitespace) notes.push(`${trailingWhitespace} line(s) end in whitespace`);

    return {
      score: round3(score),
      status: 'ok',
      evidence: {
        identifiers: names,
        comments: { lines: commentLines, ratio: Math.round(commentRatio * 1000) / 1000 },
        lines: { total: totalLines, longest: maxLine, over_limit: longLines },
        indentation: { tab_indented: tabIndented, space_indented: spaceIndented, mixed: mixedIndentation },
        trailing_whitespace_lines: trailingWhitespace,
        components: componentScores,
        notes,
      },
      feedback: notes.length ? `Readability: ${notes.join('; ')}.` : 'Readable: names, comments, line length and indentation are within the rules.',
    };
  },
};
