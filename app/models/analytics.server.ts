import db from "../db.server";

export interface DateRange {
  from: Date;
  to: Date;
}

interface LineItemRow {
  productId: string | null;
  productTitle: string;
  variantTitle: string | null;
  discountedTotalAmount: number;
  quantity: number;
  bundleGroupId: string | null;
  bundleTitle: string | null;
  orderId: string;
}

// Line items from cancelled orders, and test orders, are excluded from
// revenue by default — flip `includeTest` if you want to sanity-check with
// test orders while developing.
async function lineItemsInRange(
  shop: string,
  range: DateRange,
  includeTest = false,
) {
  return db.orderLineItem.findMany({
    where: {
      shop,
      order: {
        createdAt: { gte: range.from, lte: range.to },
        cancelledAt: null,
        ...(includeTest ? {} : { test: false }),
      },
    },
    select: {
      productId: true,
      productTitle: true,
      variantTitle: true,
      discountedTotalAmount: true,
      quantity: true,
      bundleGroupId: true,
      bundleTitle: true,
      orderId: true,
    },
  });
}

export interface PeriodTotals {
  revenue: number;
  orderCount: number;
  averageOrderValue: number;
}

export async function getPeriodTotals(
  shop: string,
  range: DateRange,
): Promise<PeriodTotals> {
  const items: LineItemRow[] = await lineItemsInRange(shop, range);
  const revenue = items.reduce((sum: number, li) => sum + li.discountedTotalAmount, 0);
  const orderIds = new Set(items.map((li) => li.orderId));
  const orderCount = orderIds.size;
  return {
    revenue,
    orderCount,
    averageOrderValue: orderCount > 0 ? revenue / orderCount : 0,
  };
}

export interface YoYComparison {
  current: PeriodTotals;
  previous: PeriodTotals;
  revenueChangePct: number | null; // null when previous period had zero revenue
  orderCountChangePct: number | null;
}

function shiftRangeByOneYear(range: DateRange): DateRange {
  const from = new Date(range.from);
  const to = new Date(range.to);
  from.setFullYear(from.getFullYear() - 1);
  to.setFullYear(to.getFullYear() - 1);
  return { from, to };
}

function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

export async function getYoYComparison(
  shop: string,
  range: DateRange,
): Promise<YoYComparison> {
  const previousRange = shiftRangeByOneYear(range);
  const [current, previous] = await Promise.all([
    getPeriodTotals(shop, range),
    getPeriodTotals(shop, previousRange),
  ]);

  return {
    current,
    previous,
    revenueChangePct: pctChange(current.revenue, previous.revenue),
    orderCountChangePct: pctChange(current.orderCount, previous.orderCount),
  };
}

export type Granularity = "day" | "week" | "month";

export interface TimeSeriesPoint {
  periodStart: string; // ISO date
  revenue: number;
}

function periodKey(date: Date, granularity: Granularity): string {
  if (granularity === "day") return date.toISOString().slice(0, 10);
  if (granularity === "month") return date.toISOString().slice(0, 7);
  // ISO week key: year + week number
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((d.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export async function getRevenueTimeSeries(
  shop: string,
  range: DateRange,
  granularity: Granularity = "day",
): Promise<TimeSeriesPoint[]> {
  const orders = await db.order.findMany({
    where: {
      shop,
      createdAt: { gte: range.from, lte: range.to },
      cancelledAt: null,
      test: false,
    },
    select: {
      createdAt: true,
      lineItems: { select: { discountedTotalAmount: true } },
    },
  });

  const buckets = new Map<string, number>();
  for (const order of orders) {
    const key = periodKey(order.createdAt, granularity);
    const orderRevenue = order.lineItems.reduce(
      (sum: number, li: { discountedTotalAmount: number }) =>
        sum + li.discountedTotalAmount,
      0,
    );
    buckets.set(key, (buckets.get(key) ?? 0) + orderRevenue);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([periodStart, revenue]) => ({ periodStart, revenue }));
}

export interface ProductOrBundleRevenue {
  key: string; // productId or bundleGroupId
  title: string;
  isBundle: boolean;
  revenue: number;
  unitsSold: number;
}

// Groups line items into products vs. bundles: components sharing the same
// bundleGroupId are collapsed into a single "bundle" row so a $120 bundle of
// three $40 items shows up as one $120 line, not three separate products.
export async function getTopProductsAndBundles(
  shop: string,
  range: DateRange,
  limit = 15,
): Promise<ProductOrBundleRevenue[]> {
  const items: LineItemRow[] = await lineItemsInRange(shop, range);

  const grouped = new Map<string, ProductOrBundleRevenue>();

  for (const li of items) {
    const isBundle = Boolean(li.bundleGroupId);
    const key = isBundle ? `bundle:${li.bundleGroupId}` : `product:${li.productId ?? li.productTitle}`;
    const title = isBundle
      ? li.bundleTitle ?? "Bundle"
      : li.variantTitle
        ? `${li.productTitle} — ${li.variantTitle}`
        : li.productTitle;

    const existing = grouped.get(key);
    if (existing) {
      existing.revenue += li.discountedTotalAmount;
      existing.unitsSold += li.quantity;
    } else {
      grouped.set(key, {
        key,
        title,
        isBundle,
        revenue: li.discountedTotalAmount,
        unitsSold: li.quantity,
      });
    }
  }

  return Array.from(grouped.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}

export interface BundleVsStandaloneSplit {
  bundleRevenue: number;
  standaloneRevenue: number;
  bundleSharePct: number;
}

export async function getBundleVsStandaloneSplit(
  shop: string,
  range: DateRange,
): Promise<BundleVsStandaloneSplit> {
  const items: LineItemRow[] = await lineItemsInRange(shop, range);
  let bundleRevenue = 0;
  let standaloneRevenue = 0;
  for (const li of items) {
    if (li.bundleGroupId) bundleRevenue += li.discountedTotalAmount;
    else standaloneRevenue += li.discountedTotalAmount;
  }
  const total = bundleRevenue + standaloneRevenue;
  return {
    bundleRevenue,
    standaloneRevenue,
    bundleSharePct: total > 0 ? (bundleRevenue / total) * 100 : 0,
  };
}
