-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "cancelledAt" DATETIME,
    "currencyCode" TEXT NOT NULL,
    "totalPriceAmount" REAL NOT NULL,
    "totalDiscountsAmount" REAL NOT NULL,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "OrderLineItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "originalTotalAmount" REAL NOT NULL,
    "discountedTotalAmount" REAL NOT NULL,
    "bundleGroupId" TEXT,
    "bundleTitle" TEXT,
    CONSTRAINT "OrderLineItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncState" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "backfillStatus" TEXT NOT NULL DEFAULT 'pending',
    "backfillBulkOpId" TEXT,
    "backfillRequestedAt" DATETIME,
    "backfillCompletedAt" DATETIME,
    "lastWebhookSyncAt" DATETIME,
    "errorMessage" TEXT
);

-- CreateIndex
CREATE INDEX "Order_shop_createdAt_idx" ON "Order"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "Order_shop_cancelledAt_idx" ON "Order"("shop", "cancelledAt");

-- CreateIndex
CREATE INDEX "OrderLineItem_shop_productId_idx" ON "OrderLineItem"("shop", "productId");

-- CreateIndex
CREATE INDEX "OrderLineItem_shop_bundleGroupId_idx" ON "OrderLineItem"("shop", "bundleGroupId");

-- CreateIndex
CREATE INDEX "OrderLineItem_orderId_idx" ON "OrderLineItem"("orderId");
