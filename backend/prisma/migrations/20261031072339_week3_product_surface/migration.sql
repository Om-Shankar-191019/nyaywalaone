-- AlterTable
ALTER TABLE "evaluations" ADD COLUMN     "stage" TEXT NOT NULL DEFAULT 'queued';

-- AlterTable
ALTER TABLE "similarity_matches" ADD COLUMN     "review_note" TEXT,
ADD COLUMN     "reviewed_at" TIMESTAMPTZ(6),
ADD COLUMN     "reviewed_by" UUID;

-- AlterTable
ALTER TABLE "submissions" ADD COLUMN     "signature" JSONB,
ADD COLUMN     "signature_params" JSONB;

-- CreateIndex
CREATE INDEX "submissions_assignment_id_created_at_idx" ON "submissions"("assignment_id", "created_at" DESC);
