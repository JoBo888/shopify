-- AlterTable
ALTER TABLE "Order" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT '{}';

-- CreateIndex
-- GIN index for fast `tags && ARRAY[...]` / Prisma `hasSome` containment
-- filtering. Not declared via a matching @@index() in schema.prisma because
-- this project applies hand-written migrations directly rather than
-- `prisma migrate dev` (see README) — intentional, documented drift.
CREATE INDEX "Order_shop_tags_idx" ON "Order" USING GIN ("tags");
