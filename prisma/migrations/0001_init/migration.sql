-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "currencyCode" TEXT NOT NULL,
    "totalPriceAmount" DOUBLE PRECISION NOT NULL,
    "totalDiscountsAmount" DOUBLE PRECISION NOT NULL,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "originalTotalAmount" DOUBLE PRECISION NOT NULL,
    "discountedTotalAmount" DOUBLE PRECISION NOT NULL,
    "unitCostAmount" DOUBLE PRECISION,
    "totalCostAmount" DOUBLE PRECISION,
    "bundleGroupId" TEXT,
    "bundleTitle" TEXT,

    CONSTRAINT "OrderLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "shop" TEXT NOT NULL,
    "backfillStatus" TEXT NOT NULL DEFAULT 'pending',
    "backfillBulkOpId" TEXT,
    "backfillRequestedAt" TIMESTAMP(3),
    "backfillCompletedAt" TIMESTAMP(3),
    "lastWebhookSyncAt" TIMESTAMP(3),
    "errorMessage" TEXT,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("shop")
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

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
