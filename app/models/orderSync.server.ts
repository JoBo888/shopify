import db from "../db.server";
import { extractBundleInfo } from "./bundleDetection.server";

// Normalized shape both the webhook path and the bulk-backfill JSONL parser
// convert their raw GraphQL data into, so upsertOrder() only has one input format.
export interface NormalizedOrder {
  id: string;
  shop: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  test: boolean;
  shippingCountryCode: string | null;
  channelName: string | null;
  tags: string[];
  currencyCode: string;
  totalPriceAmount: number;
  totalDiscountsAmount: number;
  lineItems: NormalizedLineItem[];
}

export interface NormalizedLineItem {
  id: string;
  productId: string | null;
  variantId: string | null;
  productTitle: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  originalTotalAmount: number;
  discountedTotalAmount: number;
  unitCostAmount: number | null;
  totalCostAmount: number | null;
  bundleGroupId: string | null;
  bundleTitle: string | null;
  bundleProductId: string | null;
  productTags: string[];
}

// Converts a single GraphQL `order` node (from ORDER_BY_ID_QUERY, or a
// reassembled bulk-operation node) into the normalized shape above.
export function normalizeOrderNode(shop: string, node: any): NormalizedOrder {
  const lineItemEdges: any[] = node.lineItems?.edges ?? [];

  const lineItems: NormalizedLineItem[] = lineItemEdges.map((edge) => {
    const li = edge.node;
    const bundle = extractBundleInfo(li);
    const quantity = li.quantity ?? 0;
    // unitCost is only present if the app/user has "View product costs"
    // permission and the merchant has set a "Cost per item" on the variant.
    // Absent in either case -> null, and margin figures downstream treat
    // that line's cost as unknown rather than zero.
    const unitCostRaw = li.variant?.inventoryItem?.unitCost?.amount;
    const unitCostAmount =
      unitCostRaw !== undefined && unitCostRaw !== null
        ? Number(unitCostRaw)
        : null;

    return {
      id: li.id,
      productId: li.variant?.product?.id ?? null,
      variantId: li.variant?.id ?? null,
      productTitle: li.title,
      variantTitle: li.variant?.title ?? null,
      sku: li.sku ?? null,
      quantity,
      originalTotalAmount: Number(
        li.originalTotalSet?.shopMoney?.amount ?? 0,
      ),
      // Net revenue for this line: no VAT, and refunded/removed quantities
      // already excluded by Shopify (priceAfterAllDiscountsBeforeTaxesSet).
      // Falls back to the older discountedTotalSet (gross, incl. refunded
      // quantities) only if the new field is ever absent from a response.
      discountedTotalAmount: Number(
        li.priceAfterAllDiscountsBeforeTaxesSet?.shopMoney?.amount ??
          li.discountedTotalSet?.shopMoney?.amount ??
          0,
      ),
      unitCostAmount,
      totalCostAmount: unitCostAmount !== null ? unitCostAmount * quantity : null,
      bundleGroupId: bundle.bundleGroupId,
      bundleTitle: bundle.bundleTitle,
      bundleProductId: bundle.bundleProductId,
      productTags: Array.isArray(li.variant?.product?.tags) ? li.variant.product.tags : [],
    };
  });

  return {
    id: node.id,
    shop,
    name: node.name,
    createdAt: node.createdAt,
    cancelledAt: node.cancelledAt ?? null,
    test: Boolean(node.test),
    shippingCountryCode: node.shippingAddress?.countryCode ?? null,
    channelName: node.sourceName ?? null,
    tags: Array.isArray(node.tags) ? node.tags : [],
    currencyCode: node.totalPriceSet?.shopMoney?.currencyCode ?? "EUR",
    totalPriceAmount: Number(node.totalPriceSet?.shopMoney?.amount ?? 0),
    totalDiscountsAmount: Number(
      node.totalDiscountsSet?.shopMoney?.amount ?? 0,
    ),
    lineItems,
  };
}

// Upserts one order + its line items. Replaces line items wholesale on
// update, which is simplest and cheap enough at order-line-item volume.
export async function upsertOrder(order: NormalizedOrder): Promise<void> {
  await db.$transaction(async (tx: typeof db) => {
    await tx.order.upsert({
      where: { id: order.id },
      create: {
        id: order.id,
        shop: order.shop,
        name: order.name,
        createdAt: new Date(order.createdAt),
        cancelledAt: order.cancelledAt ? new Date(order.cancelledAt) : null,
        currencyCode: order.currencyCode,
        totalPriceAmount: order.totalPriceAmount,
        totalDiscountsAmount: order.totalDiscountsAmount,
        test: order.test,
        shippingCountryCode: order.shippingCountryCode,
        channelName: order.channelName,
        tags: order.tags,
      },
      update: {
        cancelledAt: order.cancelledAt ? new Date(order.cancelledAt) : null,
        totalPriceAmount: order.totalPriceAmount,
        totalDiscountsAmount: order.totalDiscountsAmount,
        shippingCountryCode: order.shippingCountryCode,
        channelName: order.channelName,
        tags: order.tags,
        updatedAt: new Date(),
      },
    });

    await tx.orderLineItem.deleteMany({ where: { orderId: order.id } });

    if (order.lineItems.length > 0) {
      await tx.orderLineItem.createMany({
        data: order.lineItems.map((li) => ({
          id: li.id,
          orderId: order.id,
          shop: order.shop,
          productId: li.productId,
          variantId: li.variantId,
          productTitle: li.productTitle,
          variantTitle: li.variantTitle,
          sku: li.sku,
          quantity: li.quantity,
          originalTotalAmount: li.originalTotalAmount,
          discountedTotalAmount: li.discountedTotalAmount,
          unitCostAmount: li.unitCostAmount,
          totalCostAmount: li.totalCostAmount,
          bundleGroupId: li.bundleGroupId,
          bundleTitle: li.bundleTitle,
          bundleProductId: li.bundleProductId,
          productTags: li.productTags,
        })),
      });
    }
  });
}

// Fetches one order by GID via GraphQL and upserts it. Used by the
// orders/create and orders/updated webhook handlers.
export async function syncSingleOrder(
  admin: { graphql: (query: string, opts?: any) => Promise<Response> },
  shop: string,
  orderGid: string,
): Promise<void> {
  const { ORDER_BY_ID_QUERY } = await import("./orderQuery.server");
  const response = await admin.graphql(ORDER_BY_ID_QUERY, {
    variables: { id: orderGid },
  });
  const json = await response.json();
  const node = json?.data?.order;
  if (!node) return; // order may have been deleted/inaccessible since webhook fired
  await upsertOrder(normalizeOrderNode(shop, node));
}

export async function markOrderCancelled(
  shop: string,
  orderGid: string,
  cancelledAt: string,
): Promise<void> {
  await db.order.updateMany({
    where: { id: orderGid, shop },
    data: { cancelledAt: new Date(cancelledAt) },
  });
}
