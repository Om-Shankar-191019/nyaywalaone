import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { createDatabase, resolveTransport, waitForConnection } from '../src/lib/db-adapter.js';
import { describePrismaError } from '../src/lib/prisma-errors.js';
import { defaultRules, resolveRules } from '../src/grading/rules.js';
import { rulesHash } from '../src/grading/canonical.js';

// Prisma 7 needs a driver adapter; the seed is standalone so it can run
// without the full app environment (no ACCESS_TOKEN_SECRET required).
//
// It uses the API's transport and pool settings (src/lib/db-adapter.js) because
// the seed is the first command a fresh clone runs, and therefore the first
// thing to meet a cold Neon compute, and because on a network that drops port
// 5432 the seed has to use the same HTTPS fallback as the API. Without the
// connect retries it dies with an empty Prisma message: `Seed failed:` and
// nothing else.
const { prisma, pool } = createDatabase({
  connectionString: process.env.DATABASE_URL,
  transport: resolveTransport(process.env.DATABASE_TRANSPORT),
});

const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'Passw0rd-Demo-2026';
const INSTRUCTOR_EMAIL = 'prof@example.edu';
const COURSE_JOIN_CODE = 'ADDC2026';

const STUDENTS = [
  { email: 'student1@example.edu', fullName: 'Aarav Sharma' },
  { email: 'student2@example.edu', fullName: 'Bhavna Iyer' },
  { email: 'student3@example.edu', fullName: 'Chen Wei' },
  { email: 'student4@example.edu', fullName: 'Diya Menon' },
  { email: 'student5@example.edu', fullName: 'Ethan Fernandes' },
  { email: 'student6@example.edu', fullName: 'Fatima Qureshi' },
  { email: 'student7@example.edu', fullName: 'Gaurav Patil' },
  { email: 'student8@example.edu', fullName: 'Hana Suzuki' },
];

/**
 * Idempotent seed: running it twice must not duplicate keys or reset a
 * password that someone already changed.
 */
async function main() {
  const reachable = await waitForConnection({ prisma, pool });
  if (!reachable.ok) {
    console.error('Cannot reach the database:', describePrismaError(reachable.error));
    console.error('Run `npm run db:check` to see which step fails (env, DNS, TCP, login, schema), then retry.');
    console.error('If it reports that port 5432 is blocked, set DATABASE_TRANSPORT=https in backend/.env and run it again.');
    process.exitCode = 1;
    return;
  }

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 12);

  const instructor = await prisma.user.upsert({
    where: { email: INSTRUCTOR_EMAIL },
    create: { email: INSTRUCTOR_EMAIL, fullName: 'Dr. Priya Raman', passwordHash, role: 'INSTRUCTOR' },
    update: {},
  });

  const students = [];
  for (const student of STUDENTS) {
    students.push(
      await prisma.user.upsert({
        where: { email: student.email },
        create: { email: student.email, fullName: student.fullName, passwordHash, role: 'STUDENT' },
        update: {},
      }),
    );
  }

  const course = await prisma.course.upsert({
    where: { joinCode: COURSE_JOIN_CODE },
    create: { name: 'CS 101 - Programming in C', instructorId: instructor.id, joinCode: COURSE_JOIN_CODE },
    update: {},
  });

  for (const student of students) {
    await prisma.enrollment.upsert({
      where: { courseId_studentId: { courseId: course.id, studentId: student.id } },
      create: { courseId: course.id, studentId: student.id },
      update: {},
    });
  }

  // Week 2 demo: one assignment with a reference solution, three trusted tests
  // and a published rule set, so the grading engine can be exercised without
  // hand-editing JSON in the database.
  const REFERENCE = `#include <stdio.h>

int main(void) {
    long a, b;
    if (scanf("%ld %ld", &a, &b) != 2) return 1;
    printf("%ld\\n", a + b);
    return 0;
}
`;

  let assignment = await prisma.assignment.findFirst({
    where: { courseId: course.id, title: 'Sum of two integers' },
  });

  if (!assignment) {
    assignment = await prisma.assignment.create({
      data: {
        courseId: course.id,
        title: 'Sum of two integers',
        statement:
          'Read two integers from standard input, separated by whitespace, and print their sum on one line.\\n\\nInput may contain negative numbers. The program must not crash on malformed input.',
        referenceSolution: REFERENCE,
        allowLate: true,
        allowNoOracle: false,
      },
    });
  }

  const tests = [
    { name: 'small positives', stdin: '2 3\n', expectedStdout: '5\n', ordinal: 0 },
    { name: 'negatives', stdin: '-7 4\n', expectedStdout: '-3\n', ordinal: 1 },
    { name: 'large values', stdin: '1000000000 1000000000\n', expectedStdout: '2000000000\n', ordinal: 2 },
  ];

  for (const test of tests) {
    await prisma.testCase.upsert({
      where: { assignmentId_name: { assignmentId: assignment.id, name: test.name } },
      create: { assignmentId: assignment.id, ...test },
      update: { stdin: test.stdin, expectedStdout: test.expectedStdout, ordinal: test.ordinal },
    });
  }

  if (!assignment.activeRuleSetId) {
    const { rules, errors } = resolveRules(defaultRules('add_two_integers'));
    if (errors.length) throw new Error(`Default rule set is invalid: ${errors[0].path} ${errors[0].message}`);

    const ruleSet = await prisma.ruleSet.create({
      data: {
        assignmentId: assignment.id,
        version: 1,
        rules,
        rulesHash: rulesHash(rules),
        isPublished: true,
        publishedAt: new Date(),
        createdById: instructor.id,
      },
    });

    assignment = await prisma.assignment.update({
      where: { id: assignment.id },
      data: { activeRuleSetId: ruleSet.id, publishedAt: new Date() },
    });
  }

  console.log('\nSeed complete. These credentials are for local development only.\n');
  console.log(`  Instructor  ${INSTRUCTOR_EMAIL}  /  ${SEED_PASSWORD}`);
  console.log(`  Students    student1..8@example.edu  /  ${SEED_PASSWORD}`);
  console.log(`  Course      ${course.name}   join code: ${course.joinCode}`);
  console.log(`  Assignment  ${assignment.title}  (${assignment.id})`);
  console.log(`  Enrolled    ${students.length} students\n`);
}

main()
  .catch((error) => {
    console.error('Seed failed:', describePrismaError(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    await pool?.end().catch(() => {});
  });
