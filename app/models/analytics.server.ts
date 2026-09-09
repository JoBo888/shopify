import db from "../db.server";

export interface DateRange {
  from: Date;
  to: Date;
}

// Applied on top of a DateRange. Every field is optional / "no filter" when
// omitted or an empty array, so existing callers that only pass a DateRange
// keep working unchanged.
export interface Filters {
  countries?: string[]; // Order.shippingCountryCode values (ISO alpha-2)
  channels?: string[]; // Order.channelName values (Shopify sourceName)
  bundleTitles?: string[]; // only include line items belonging to these bundles
}

interface LineItemRow {
  productId: string | null;
  productTitle: string;
  variantTitle: string | null;
  discountedTotalAmount: number;
  totalCostAmount: number | null;
  quantity: number;
  bundleGroupId: string | null;
  bundleTitle: string | null;
  orderId: string;
}

function orderWhere(shop: string, range: DateRange, filters?: Filters) {
  return {
    shop,
    createdAt: { gte: range.from, lte: range.to },
    cancelledAt: null,
    test: false,
    ...(filters?.countries?.length
      ? { shippingCountryCode: { in: filters.countries } }
      : {}),
    ...(filters?.channels?.length
      ? { channelName: { in: filters.channels } }
      : {}),
  };
}

// Line items from cancelled orders, and test orders, are excluded from
// revenue by default. When `filters.bundleTitles` is set, only line items
// belonging to one of those bundles are returned — used for the bundle
// drill-down view.
async function lineItemsInRange(
  shop: string,
  range: DateRange,
  filters?: Filters,
): Promise<LineItemRow[]> {
  return db.orderLineItem.findMany({
    where: {
      shop,
      order: orderWhere(shop, range, filters),
      ...(filters?.bundleTitles?.length
        ? { bundleTitle: { in: filters.bundleTitles } }
        : {}),
    },
    select: {
      productId: true,
      productTitle: true,
      variantTitle: true,
      discountedTotalAmount: true,
      totalCostAmount: true,
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
  grossProfit: number | null; // null if no line item in range has cost data
  grossMarginPct: number | null;
  costDataCoveragePct: number; // % of revenue for which a cost was known — read this before trusting grossProfit
}

export async function getPeriodTotals(
  shop: string,
  range: DateRange,
  filters?: Filters,
): Promise<PeriodTotals> {
  const items = await lineItemsInRange(shop, range, filters);
  const revenue = items.reduce((sum: number, li) => sum + li.discountedTotalAmount, 0);
  const orderIds = new Set(items.map((li) => li.orderId));
  const orderCount = orderIds.size;

  let costedRevenue = 0;
  let totalCost = 0;
  for (const li of items) {
    if (li.totalCostAmount !== null) {
      costedRevenue += li.discountedTotalAmount;
      totalCost += li.totalCostAmount;
    }
  }
  const costDataCoveragePct = revenue > 0 ? (costedRevenue / revenue) * 100 : 0;
  const grossProfit = costedRevenue > 0 ? costedRevenue - totalCost : null;
  const grossMarginPct =
    grossProfit !== null && costedRevenue > 0 ? (grossProfit / costedRevenue) * 100 : null;

  return {
    revenue,
    orderCount,
    averageOrderValue: orderCount > 0 ? revenue / orderCount : 0,
    grossProfit,
    grossMarginPct,
    costDataCoveragePct,
  };
}

export interface PeriodComparison {
  current: PeriodTotals;
  previous: PeriodTotals;
  previousLabel: string; // e.g. "Vorjahr" or "1. Jan – 31. Mär 2025"
  revenueChangePct: number | null;
  orderCountChangePct: number | null;
  grossProfitChangePct: number | null;
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

// `compareRange` lets the caller supply an explicit custom comparison period
// (e.g. a different quarter). If omitted, defaults to "same dates, one year
// earlier" — the classic YoY comparison.
export async function getPeriodComparison(
  shop: string,
  range: DateRange,
  filters?: Filters,
  compareRange?: DateRange,
): Promise<PeriodComparison> {
  const previousRange = compareRange ?? shiftRangeByOneYear(range);
  const [current, previous] = await Promise.all([
    getPeriodTotals(shop, range, filters),
    getPeriodTotals(shop, previousRange, filters),
  ]);

  const fmt = (d: Date) => d.toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric" });
  const previousLabel = compareRange
    ? `${fmt(previousRange.from)} – ${fmt(previousRange.to)}`
    : "Vorjahr";

  return {
    current,
    previous,
    previousLabel,
    revenueChangePct: pctChange(current.revenue, previous.revenue),
    orderCountChangePct: pctChange(current.orderCount, previous.orderCount),
    grossProfitChangePct:
      current.grossProfit !== null && previous.grossProfit !== null
        ? pctChange(current.grossProfit, previous.grossProfit)
        : null,
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

// Enumerates every distinct period key between range.from and range.to
// (inclusive), in order, regardless of whether that period had any orders.
function enumeratePeriods(range: DateRange, granularity: Granularity): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const cursor = new Date(range.from);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(range.to);
  while (cursor <= end) {
    const key = periodKey(cursor, granularity);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

// Fills gaps (periods with zero orders) with revenue: 0, so a series always
// has one point per period in the range — required for index-aligned
// overlays (e.g. current vs. previous-year line charts).
function fillPeriods(
  points: TimeSeriesPoint[],
  range: DateRange,
  granularity: Granularity,
): TimeSeriesPoint[] {
  const byKey = new Map(points.map((p) => [p.periodStart, p.revenue]));
  return enumeratePeriods(range, granularity).map((periodStart) => ({
    periodStart,
    revenue: byKey.get(periodStart) ?? 0,
  }));
}

export async function getRevenueTimeSeries(
  shop: string,
  range: DateRange,
  granularity: Granularity = "day",
  filters?: Filters,
): Promise<TimeSeriesPoint[]> {
  const orders = await db.order.findMany({
    where: orderWhere(shop, range, filters),
    select: {
      createdAt: true,
      lineItems: {
        select: { discountedTotalAmount: true, bundleTitle: true },
      },
    },
  });

  const buckets = new Map<string, number>();
  for (const order of orders) {
    const key = periodKey(order.createdAt, granularity);
    const relevantLineItems = filters?.bundleTitles?.length
      ? order.lineItems.filter(
          (li: { bundleTitle: string | null }) =>
            li.bundleTitle && filters.bundleTitles!.includes(li.bundleTitle),
        )
      : order.lineItems;
    const orderRevenue = relevantLineItems.reduce(
      (sum: number, li: { discountedTotalAmount: number }) => sum + li.discountedTotalAmount,
      0,
    );
    buckets.set(key, (buckets.get(key) ?? 0) + orderRevenue);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([periodStart, revenue]) => ({ periodStart, revenue }));
}

// Current-period series (gap-filled) plus the previous-period series
// (Vorjahr or custom compareRange), aligned by index so the frontend can
// zip them straight into one chart-data array with two lines.
export async function getRevenueTimeSeriesWithComparison(
  shop: string,
  range: DateRange,
  granularity: Granularity,
  filters?: Filters,
  compareRange?: DateRange,
): Promise<{ current: TimeSeriesPoint[]; previous: TimeSeriesPoint[] }> {
  const previousRange = compareRange ?? shiftRangeByOneYear(range);
  const [currentRaw, previousRaw] = await Promise.all([
    getRevenueTimeSeries(shop, range, granularity, filters),
    getRevenueTimeSeries(shop, previousRange, granularity, filters),
  ]);
  return {
    current: fillPeriods(currentRaw, range, granularity),
    previous: fillPeriods(previousRaw, previousRange, granularity),
  };
}

export interface ProductOrBundleRevenue {
  key: string; // productId, or "bundle:<title>" for bundles
  title: string;
  isBundle: boolean;
  revenue: number;
  unitsSold: number;
  orderCount: number; // how many distinct orders included this product/bundle
  grossProfit: number | null;
  grossMarginPct: number | null;
}

// Groups line items into products vs. bundles. Bundles are grouped by
// `bundleTitle` (the bundle's product name) rather than `bundleGroupId`
// (Shopify's LineItemGroup id, which is generated fresh per order and is
// NOT stable across orders) — this is what makes "3 sales of the same
// bundle across 3 different orders" collapse into one row instead of three.
export async function getTopProductsAndBundles(
  shop: string,
  range: DateRange,
  limit = 15,
  filters?: Filters,
): Promise<ProductOrBundleRevenue[]> {
  const items = await lineItemsInRange(shop, range, filters);

  const grouped = new Map<
    string,
    ProductOrBundleRevenue & { costedRevenue: number; totalCost: number; orderIds: Set<string> }
  >();

  for (const li of items) {
    const isBundle = Boolean(li.bundleTitle);
    const key = isBundle
      ? `bundle:${li.bundleTitle}`
      : `product:${li.productId ?? li.productTitle}`;
    const title = isBundle
      ? li.bundleTitle!
      : li.variantTitle
        ? `${li.productTitle} — ${li.variantTitle}`
        : li.productTitle;

    const existing = grouped.get(key);
    if (existing) {
      existing.revenue += li.discountedTotalAmount;
      existing.unitsSold += li.quantity;
      existing.orderIds.add(li.orderId);
      if (li.totalCostAmount !== null) {
        existing.costedRevenue += li.discountedTotalAmount;
        existing.totalCost += li.totalCostAmount;
      }
    } else {
      grouped.set(key, {
        key,
        title,
        isBundle,
        revenue: li.discountedTotalAmount,
        unitsSold: li.quantity,
        orderCount: 0,
        grossProfit: null,
        grossMarginPct: null,
        costedRevenue: li.totalCostAmount !== null ? li.discountedTotalAmount : 0,
        totalCost: li.totalCostAmount ?? 0,
        orderIds: new Set([li.orderId]),
      });
    }
  }

  return Array.from(grouped.values())
    .map((row) => {
      const grossProfit = row.costedRevenue > 0 ? row.costedRevenue - row.totalCost : null;
      const grossMarginPct =
        grossProfit !== null && row.costedRevenue > 0
          ? (grossProfit / row.costedRevenue) * 100
          : null;
      return {
        ...row,
        orderCount: row.orderIds.size,
        grossProfit,
        grossMarginPct,
      };
    })
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
  filters?: Filters,
): Promise<BundleVsStandaloneSplit> {
  const items = await lineItemsInRange(shop, range, filters);
  let bundleRevenue = 0;
  let standaloneRevenue = 0;
  for (const li of items) {
    if (li.bundleTitle) bundleRevenue += li.discountedTotalAmount;
    else standaloneRevenue += li.discountedTotalAmount;
  }
  const total = bundleRevenue + standaloneRevenue;
  return {
    bundleRevenue,
    standaloneRevenue,
    bundleSharePct: total > 0 ? (bundleRevenue / total) * 100 : 0,
  };
}

// ---- Filter option lists (populate the dashboard's checkboxes/dropdowns) ----

export async function getAvailableCountries(shop: string): Promise<string[]> {
  const rows = await db.order.findMany({
    where: { shop, shippingCountryCode: { not: null } },
    select: { shippingCountryCode: true },
    distinct: ["shippingCountryCode"],
  });
  return rows
    .map((r: { shippingCountryCode: string | null }) => r.shippingCountryCode)
    .filter((c: string | null): c is string => Boolean(c))
    .sort();
}

export async function getAvailableChannels(shop: string): Promise<string[]> {
  const rows = await db.order.findMany({
    where: { shop, channelName: { not: null } },
    select: { channelName: true },
    distinct: ["channelName"],
  });
  return rows
    .map((r: { channelName: string | null }) => r.channelName)
    .filter((c: string | null): c is string => Boolean(c))
    .sort();
}

export async function getAvailableBundles(shop: string): Promise<string[]> {
  const rows = await db.orderLineItem.findMany({
    where: { shop, bundleTitle: { not: null } },
    select: { bundleTitle: true },
    distinct: ["bundleTitle"],
  });
  return rows
    .map((r: { bundleTitle: string | null }) => r.bundleTitle)
    .filter((t: string | null): t is string => Boolean(t))
    .sort();
}
