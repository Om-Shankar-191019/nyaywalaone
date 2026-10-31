/**
 * A fixed report, used by the text-report snapshot test.
 *
 * It is deliberately boring and fully specified: every field the renderer reads
 * is present, so a change to the layout shows up as a readable diff in the
 * golden file rather than as a crash on a missing property.
 */
export const reportFixture = {
  report: {
    schema_version: '2.0',
    grader_version: '2.0.0',
    evaluation: {
      id: '0f9a6f7e-0000-4000-8000-000000000001',
      key: 'e4c1d2f3a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f',
      status: 'SUCCEEDED',
      provider: 'onlinecompiler',
      toolchain_hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9',
    },
    submission: {
      id: '11111111-2222-4333-8444-555555555555',
      assignment_id: '66666666-7777-4888-8999-aaaaaaaaaaaa',
      student_id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
      attempt: 2,
      filename: 'add.c',
      size_bytes: 148,
      source_hash: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00',
    },
    rule_set: {
      id: 'dddddddd-eeee-4fff-8000-111111111111',
      version: 3,
      rules_hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      problem: 'add_two_integers',
    },
    testset: {
      hash: 'feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface',
      count: 2,
      names: ['positive', 'negatives'],
    },
    grade: { hundredths: 8714, percent: 87.14 },
    metrics: [
      {
        name: 'correctness',
        analyzer: 'io_tests',
        ordinal: 0,
        score: 1,
        weight: 0.2,
        contribution: 2000,
        status: 'ok',
        feedback: 'All 2 tests passed.',
        evidence: { tests_passed: 2, tests_total: 2 },
      },
      {
        name: 'syntax',
        analyzer: 'compiler_warnings',
        ordinal: 1,
        score: 1,
        weight: 0.1,
        contribution: 1000,
        status: 'partial',
        feedback: 'Compiled without errors. The sandbox uses a fixed compile line.',
        evidence: { warnings: 0 },
      },
      {
        name: 'readability_llm',
        analyzer: 'llm_review',
        ordinal: 2,
        score: 0,
        weight: 0,
        contribution: 0,
        status: 'unavailable',
        feedback: 'Not measured: GROQ_API_KEY is not set.',
        evidence: { reason: 'GROQ_API_KEY is not set' },
      },
      {
        name: 'originality',
        analyzer: 'similarity_flag',
        ordinal: 3,
        score: 0.86,
        weight: 0.1,
        contribution: 857,
        status: 'ok',
        feedback: 'Similarity 57% with another submission. Below the 85% review threshold.',
        evidence: { max_similarity: 0.571 },
      },
    ],
    flags: {
      review_recommended: ['syntax', 'readability_llm'],
      suspected_infinite_loop: false,
      identical_copy: false,
      no_oracle: false,
    },
    toolchain: {
      provider: 'onlinecompiler',
      compiler_version: '15.2.0',
      stdc_version: '202311',
      pointer_bits: 64,
      fingerprint_hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      analyzer_versions: { io_tests: '1.0.0' },
    },
    usefulness:
      'This grade measures correctness against the assignment\'s tests, structure, memory discipline, readability and originality.',
    limitations_version: '1.0',
    limitations: [
      'The optional language-model review is not configured or not enabled for this rule set.',
      'The sandbox fixes its own memory and process ceilings, so the rule set\'s memory and process limits were not enforced.',
    ],
  },
};
