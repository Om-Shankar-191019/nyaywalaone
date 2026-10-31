-- CreateEnum
CREATE TYPE "EvaluationStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL');

-- AlterTable
ALTER TABLE "assignments" ADD COLUMN     "active_ruleset_id" UUID,
ADD COLUMN     "allow_late" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "allow_no_oracle" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "grade_release_at" TIMESTAMPTZ(6),
ADD COLUMN     "published_at" TIMESTAMPTZ(6),
ADD COLUMN     "reference_solution" TEXT;

-- CreateTable
CREATE TABLE "rule_sets" (
    "id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "rules" JSONB NOT NULL,
    "rules_hash" TEXT NOT NULL,
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "rule_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_cases" (
    "id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "stdin" TEXT NOT NULL DEFAULT '',
    "expected_stdout" TEXT NOT NULL DEFAULT '',
    "is_hidden" BOOLEAN NOT NULL DEFAULT false,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "test_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submissions" (
    "id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "source_hash" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "released_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluations" (
    "id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "ruleset_id" UUID NOT NULL,
    "evaluation_key" TEXT NOT NULL,
    "status" "EvaluationStatus" NOT NULL DEFAULT 'QUEUED',
    "grade_hundredths" INTEGER,
    "report_hash" TEXT,
    "provider" TEXT NOT NULL,
    "toolchain_fingerprint" TEXT NOT NULL,
    "grader_version" TEXT NOT NULL,
    "failed_reason" TEXT,
    "lineage_of" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_results" (
    "id" UUID NOT NULL,
    "evaluation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "analyzer" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "contribution" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "feedback" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "metric_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_cache" (
    "cache_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "output" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_cache_pkey" PRIMARY KEY ("cache_key")
);

-- CreateTable
CREATE TABLE "similarity_matches" (
    "id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "submission_a" UUID NOT NULL,
    "submission_b" UUID NOT NULL,
    "similarity" DOUBLE PRECISION NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'minhash-128',
    "matched_span" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "similarity_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_cache" (
    "prompt_hash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "params_hash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_cache_pkey" PRIMARY KEY ("prompt_hash")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rule_sets_assignment_id_version_idx" ON "rule_sets"("assignment_id", "version" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "rule_sets_assignment_id_version_key" ON "rule_sets"("assignment_id", "version");

-- CreateIndex
CREATE INDEX "test_cases_assignment_id_ordinal_idx" ON "test_cases"("assignment_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "test_cases_assignment_id_name_key" ON "test_cases"("assignment_id", "name");

-- CreateIndex
CREATE INDEX "submissions_assignment_id_student_id_idx" ON "submissions"("assignment_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "submissions_assignment_id_student_id_attempt_key" ON "submissions"("assignment_id", "student_id", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "evaluations_evaluation_key_key" ON "evaluations"("evaluation_key");

-- CreateIndex
CREATE INDEX "evaluations_submission_id_idx" ON "evaluations"("submission_id");

-- CreateIndex
CREATE INDEX "metric_results_evaluation_id_idx" ON "metric_results"("evaluation_id");

-- CreateIndex
CREATE UNIQUE INDEX "metric_results_evaluation_id_name_key" ON "metric_results"("evaluation_id", "name");

-- CreateIndex
CREATE INDEX "similarity_matches_assignment_id_similarity_idx" ON "similarity_matches"("assignment_id", "similarity" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "similarity_matches_submission_a_submission_b_method_key" ON "similarity_matches"("submission_a", "submission_b", "method");

-- CreateIndex
CREATE INDEX "audit_log_entity_entity_id_idx" ON "audit_log"("entity", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_idx" ON "audit_log"("actor_id");

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_active_ruleset_id_fkey" FOREIGN KEY ("active_ruleset_id") REFERENCES "rule_sets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_sets" ADD CONSTRAINT "rule_sets_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_sets" ADD CONSTRAINT "rule_sets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_ruleset_id_fkey" FOREIGN KEY ("ruleset_id") REFERENCES "rule_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_lineage_of_fkey" FOREIGN KEY ("lineage_of") REFERENCES "evaluations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_results" ADD CONSTRAINT "metric_results_evaluation_id_fkey" FOREIGN KEY ("evaluation_id") REFERENCES "evaluations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "similarity_matches" ADD CONSTRAINT "similarity_matches_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
