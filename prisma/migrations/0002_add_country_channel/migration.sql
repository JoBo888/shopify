-- AlterTable
ALTER TABLE "Order" ADD COLUMN "shippingCountryCode" TEXT;
ALTER TABLE "Order" ADD COLUMN "channelName" TEXT;

-- CreateIndex
CREATE INDEX "Order_shop_shippingCountryCode_idx" ON "Order"("shop", "shippingCountryCode");

-- CreateIndex
CREATE INDEX "Order_shop_channelName_idx" ON "Order"("shop", "channelName");
