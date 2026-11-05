/**
 * Deterministic copy-paste signals.
 *
 * A language model can say "this looks generated" but it cannot be audited and
 * it costs a request. These checks cost nothing, give the same answer twice, and
 * catch the cases that actually show up in a first-year C course: code pasted
 * out of a chat window with the fences still attached, the model's polite
 * preamble, smart quotes from a word processor, and tutorial prose in comments.
 *
 * None of this is proof of misconduct. The report calls it a signal and asks a
 * human to look - the same rule the similarity analyzer follows.
 */

/** Phrases models add when they hand code back. Not exhaustive; not magic. */
const PROSE_MARKERS = [
  /\bhere(?:'s| is) (?:the|a) (?:corrected|updated|complete|fixed)?\s*(?:code|program|version)/i,
  /\bcertainly[!,]/i,
  /\bsure[!,]/i,
  /\bas an ai\b/i,
  /\bi hope this helps\b/i,
  /\blet me know if\b/i,
  /\bthis (?:program|code) (?:will|should) (?:print|calculate|compute)\b/i,
  /\bnote: (?:this|the) (?:code|program)\b/i,
  /\bexplanation:/i,
  /\bwould you like\b/i,
];

/** Tutorial-site comment shapes: `// Function to add two numbers`. */
const TUTORIAL_COMMENTS = [
  /^\s*\/\/\s*(?:function|program|code) to\b/im,
  /^\s*\/\/\s*(?:declare|initialise|initialize) (?:the )?(?:variables?|array)\b/im,
  /^\s*\/\/\s*(?:read|take) (?:the )?input\b/im,
  /^\s*\/\/\s*(?:print|display) (?:the )?(?:result|output)\b/im,
  /^\s*\/\*\s*[A-Z][a-z]+ [a-z]+ (?:program|code)\s*\*\//m,
  /^\s*\/\/\s*step \d+\b/im,
];

const FRAMEWORK_MARKERS = [
  { re: /```/, id: 'markdown_fence', label: 'Markdown code fences left in the file', weight: 0.55 },
  { re: /#include\s*<bits\/stdc\+\+\.h>/, id: 'bits_header', label: 'C++ competitive-programming header in a C file', weight: 0.3 },
  { re: /\busing\s+namespace\s+std\b/, id: 'using_namespace', label: 'C++ namespace pulled into a C submission', weight: 0.25 },
  { re: /[“”‘’—]/, id: 'smart_punctuation', label: 'Typographic quotes or dashes pasted from a document', weight: 0.3 },
  { re: /\bTODO\b|\bYOUR CODE HERE\b|\byour code here\b/, id: 'placeholder', label: 'Unfilled placeholder text from a template', weight: 0.35 },
  { re: /\bthe quick brown fox\b|\bhello world\b/i, id: 'sample_text', label: 'Sample text from a tutorial', weight: 0.1 },
];

const countLines = (source) => source.split('\n').length;

/** Comment lines, and how many of them read like a textbook rather than a person. */
function commentProfile(source) {
  const lines = source.split('\n');
  const commentLines = lines.filter((line) => /^\s*(\/\/|\/\*|\*)/.test(line));
  const tutorial = commentLines.filter((line) => TUTORIAL_COMMENTS.some((pattern) => pattern.test(line)));
  return {
    comment_lines: commentLines.length,
    total_lines: countLines(source),
    tutorial_comments: tutorial.length,
    ratio: commentLines.length / Math.max(1, lines.filter((line) => line.trim()).length),
  };
}

function namingProfile(source) {
  const identifiers = (source.match(/\b[A-Za-z_]\w*\b/g) ?? []).filter(
    (name) => !/^(?:auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|restrict|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while|include|define|ifdef|ifndef|endif|printf|scanf|main|std|h)$/.test(name),
  );
  const snake = identifiers.filter((name) => /^[a-z]+(?:_[a-z0-9]+)+$/.test(name)).length;
  const camel = identifiers.filter((name) => /^[a-z]+(?:[A-Z][a-z0-9]+)+$/.test(name)).length;
  const single = identifiers.filter((name) => name.length === 1).length;
  return {
    identifiers: identifiers.length,
    snake_case: snake,
    camel_case: camel,
    single_letter: single,
    mixed_style: snake > 1 && camel > 1,
  };
}

/**
 * Weighted evidence, not a verdict. The scores combine with `1 - Π(1 - w)`, so
 * three weak signals do not add up to an accusation the way a sum would.
 */
export function copySignals(source) {
  const text = String(source ?? '');
  const signals = [];

  if (text.trim()) {
    for (const marker of FRAMEWORK_MARKERS) {
      if (marker.re.test(text)) signals.push({ id: marker.id, label: marker.label, weight: marker.weight, source: 'pattern' });
    }

    const prose = PROSE_MARKERS.filter((pattern) => pattern.test(text));
    if (prose.length) {
      signals.push({
        id: 'assistant_prose',
        label: `Assistant-style phrasing left in the file (${prose.length} phrase${prose.length === 1 ? '' : 's'})`,
        weight: Math.min(0.6, 0.3 + prose.length * 0.1),
        source: 'pattern',
      });
    }

    const comments = commentProfile(text);
    if (comments.tutorial_comments > 0) {
      signals.push({
        id: 'tutorial_comments',
        label: `Textbook-style comments (${comments.tutorial_comments}) such as "function to ..."`,
        weight: Math.min(0.45, 0.2 + comments.tutorial_comments * 0.1),
        source: 'pattern',
      });
    }
    if (comments.ratio > 0.5 && comments.comment_lines >= 4) {
      signals.push({
        id: 'comment_heavy',
        label: 'More than half the file is comment - typical of pasted explanations',
        weight: 0.15,
        source: 'pattern',
      });
    }

    const naming = namingProfile(text);
    if (naming.mixed_style) {
      signals.push({
        id: 'mixed_naming',
        label: 'Two naming conventions in one small file (snake_case and camelCase)',
        weight: 0.2,
        source: 'pattern',
      });
    }

    // A file with almost no blank lines but tidy indentation reads like output,
    // not like something typed by hand. Weak on its own, useful with the rest.
    const lines = text.split('\n');
    const blank = lines.filter((line) => !line.trim()).length;
    if (lines.length > 25 && blank === 0 && lines.every((line) => !/\s{2,}\S/.test(line) || /^\s{2,4}\S/.test(line))) {
      signals.push({ id: 'uniform_shape', label: 'Uniform, machine-like layout with no blank lines', weight: 0.1, source: 'pattern' });
    }
  }

  return signals;
}

export const likelihoodFrom = (signals) =>
  Math.round((1 - signals.reduce((remaining, signal) => remaining * (1 - signal.weight), 1)) * 1000) / 1000;

/** What the analyzer can say with no API key at all. */
export function heuristicReview(source) {
  const signals = copySignals(source);
  const likelihood = likelihoodFrom(signals);
  return {
    signals,
    ai_likelihood: likelihood,
    copy_likelihood: likelihood,
    verdict:
      likelihood >= 0.8
        ? 'strong_signal'
        : likelihood >= 0.6
          ? 'review_recommended'
          : likelihood >= 0.35
            ? 'inconclusive'
            : 'likely_original',
  };
}

/** A compact, prompt-sized description of a submission. */
export function codeSummary(source) {
  const text = String(source ?? '');
  const lines = text.split('\n');
  const nonEmpty = lines.filter((line) => line.trim());
  const functions = (text.match(/^[A-Za-z_][\w \t*]*\b[A-Za-z_]\w*\s*\([^;{)]*\)\s*\{/gm) ?? []).length;
  return {
    lines: lines.length,
    non_empty_lines: nonEmpty.length,
    blank_lines: lines.length - nonEmpty.length,
    longest_line: lines.reduce((max, line) => Math.max(max, line.length), 0),
    functions,
    includes: (text.match(/^\s*#include\s*<[^>]+>/gm) ?? []).length,
    comments: (text.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g) ?? []).length,
    tabs: (text.match(/^\t+/gm) ?? []).length,
    spaces: (text.match(/^ {2,}\S/gm) ?? []).length,
  };
}
