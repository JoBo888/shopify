-- AlterTable
ALTER TABLE "OrderLineItem" ADD COLUMN "bundleProductId" TEXT;

-- CreateIndex
CREATE INDEX "OrderLineItem_shop_bundleProductId_idx" ON "OrderLineItem"("shop", "bundleProductId");
