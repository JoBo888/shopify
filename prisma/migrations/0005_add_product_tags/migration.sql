-- AlterTable
ALTER TABLE "OrderLineItem" ADD COLUMN "productTags" TEXT[] NOT NULL DEFAULT '{}';

-- CreateIndex
CREATE INDEX "OrderLineItem_shop_productTags_idx" ON "OrderLineItem" USING GIN ("productTags");
