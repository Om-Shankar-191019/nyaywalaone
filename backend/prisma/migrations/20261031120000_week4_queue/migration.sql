-- AlterTable
ALTER TABLE "evaluations" ADD COLUMN     "attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "claimed_at" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "evaluations_status_claimed_at_idx" ON "evaluations"("status", "claimed_at");
