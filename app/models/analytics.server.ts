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
  tags?: string[]; // Order.tags — order matches if it has ANY of these tags
  productTags?: string[]; // Product.tags (per line item) — matches if line item's product has ANY of these tags
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
  bundleProductId: string | null;
  productTags: string[];
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
    ...(filters?.tags?.length ? { tags: { hasSome: filters.tags } } : {}),
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
      ...(filters?.productTags?.length
        ? { productTags: { hasSome: filters.productTags } }
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
      bundleProductId: true,
      productTags: true,
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
  filters?: Filters,
): Promise<PeriodTotals> {
  const items = await lineItemsInRange(shop, range, filters);
  const revenue = items.reduce((sum: number, li) => sum + li.discountedTotalAmount, 0);
  const orderIds = new Set(items.map((li) => li.orderId));
  const orderCount = orderIds.size;

  return {
    revenue,
    orderCount,
    averageOrderValue: orderCount > 0 ? revenue / orderCount : 0,
  };
}

export interface PeriodComparison {
  current: PeriodTotals;
  previous: PeriodTotals;
  previousLabel: string; // e.g. "Vorjahr" or "1. Jan – 31. Mär 2025"
  revenueChangePct: number | null;
  orderCountChangePct: number | null;
}

export function shiftRangeByOneYear(range: DateRange): DateRange {
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
        select: { discountedTotalAmount: true, bundleTitle: true, productTags: true },
      },
    },
  });

  const buckets = new Map<string, number>();
  for (const order of orders) {
    const key = periodKey(order.createdAt, granularity);
    let relevantLineItems = filters?.bundleTitles?.length
      ? order.lineItems.filter(
          (li: { bundleTitle: string | null }) =>
            li.bundleTitle && filters.bundleTitles!.includes(li.bundleTitle),
        )
      : order.lineItems;
    if (filters?.productTags?.length) {
      relevantLineItems = relevantLineItems.filter((li: { productTags: string[] }) =>
        li.productTags.some((t: string) => filters.productTags!.includes(t)),
      );
    }
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
}

// Groups line items into products vs. bundles. Bundles are grouped by
// `bundleProductId` (stable across orders/locales) when available, falling
// back to `bundleTitle` for older rows or PickyStory-fallback bundles that
// have no resolvable product id. Falling back to bundleTitle for grouping
// means pre-migration / PickyStory-only bundles can still fragment across
// locales — resync after this change to backfill bundleProductId.
export async function getTopProductsAndBundles(
  shop: string,
  range: DateRange,
  limit = 15,
  filters?: Filters,
): Promise<ProductOrBundleRevenue[]> {
  const items = await lineItemsInRange(shop, range, filters);

  const grouped = new Map<
    string,
    ProductOrBundleRevenue & {
      orderIds: Set<string>;
      titleCounts: Map<string, number>;
    }
  >();

  for (const li of items) {
    const isBundle = Boolean(li.bundleTitle);
    const key = isBundle
      ? `bundle:${li.bundleProductId ?? li.bundleTitle}`
      : `product:${li.productId ?? li.productTitle}`;
    const displayTitleCandidate = isBundle
      ? li.bundleTitle!
      : li.variantTitle
        ? `${li.productTitle} — ${li.variantTitle}`
        : li.productTitle;

    const existing = grouped.get(key);
    if (existing) {
      existing.revenue += li.discountedTotalAmount;
      existing.unitsSold += li.quantity;
      existing.orderIds.add(li.orderId);
      existing.titleCounts.set(
        displayTitleCandidate,
        (existing.titleCounts.get(displayTitleCandidate) ?? 0) + 1,
      );
    } else {
      grouped.set(key, {
        key,
        title: displayTitleCandidate,
        isBundle,
        revenue: li.discountedTotalAmount,
        unitsSold: li.quantity,
        orderCount: 0,
        orderIds: new Set([li.orderId]),
        titleCounts: new Map([[displayTitleCandidate, 1]]),
      });
    }
  }

  return Array.from(grouped.values())
    .map((row) => {
      // Majority-vote title: when a bundle was grouped by bundleProductId,
      // orders may carry different locale titles — show whichever title
      // occurred most often instead of just "whatever came first".
      let bestTitle = row.title;
      let bestCount = 0;
      for (const [t, count] of row.titleCounts) {
        if (count > bestCount) {
          bestTitle = t;
          bestCount = count;
        }
      }
      return {
        key: row.key,
        title: bestTitle,
        isBundle: row.isBundle,
        revenue: row.revenue,
        unitsSold: row.unitsSold,
        orderCount: row.orderIds.size,
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

// Prisma has no "distinct array elements" query, so this fetches every
// order's tags array for the shop and dedupes in JS. Fine at this app's
// order volume; revisit (e.g. a separate OrderTag join table) if a shop
// grows into the hundreds of thousands of orders.
export async function getAvailableTags(shop: string): Promise<string[]> {
  const rows = await db.order.findMany({
    where: { shop, tags: { isEmpty: false } },
    select: { tags: true },
  });
  const tagSet = new Set<string>();
  for (const r of rows) {
    for (const t of r.tags) tagSet.add(t);
  }
  return Array.from(tagSet).sort();
}

// Same idea as getAvailableTags, but for Product.tags (denormalized onto
// each OrderLineItem at sync time) — a different concept from order tags:
// these are the tags set on the product/article itself in Shopify admin.
export async function getAvailableProductTags(shop: string): Promise<string[]> {
  const rows = await db.orderLineItem.findMany({
    where: { shop, productTags: { isEmpty: false } },
    select: { productTags: true },
  });
  const tagSet = new Set<string>();
  for (const r of rows) {
    for (const t of r.productTags) tagSet.add(t);
  }
  return Array.from(tagSet).sort();
}

export interface BundleOption {
  key: string; // stable filter value: bundleProductId if known, else the raw title
  title: string; // majority-vote display label across all locale variants
}

// One row per distinct bundle, deduped across locales via bundleProductId
// when available (falls back to raw title for rows without a resolvable
// product id, e.g. pre-migration data or PickyStory-only bundles).
export async function getAvailableBundles(shop: string): Promise<BundleOption[]> {
  const rows = await db.orderLineItem.findMany({
    where: { shop, bundleTitle: { not: null } },
    select: { bundleTitle: true, bundleProductId: true },
  });

  const groups = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const title = r.bundleTitle;
    if (!title) continue;
    const key = r.bundleProductId ?? title;
    const titleCounts = groups.get(key) ?? new Map<string, number>();
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
    groups.set(key, titleCounts);
  }

  const options: BundleOption[] = [];
  for (const [key, titleCounts] of groups) {
    let bestTitle = key;
    let bestCount = 0;
    for (const [t, count] of titleCounts) {
      if (count > bestCount) {
        bestTitle = t;
        bestCount = count;
      }
    }
    options.push({ key, title: bestTitle });
  }
  return options.sort((a, b) => a.title.localeCompare(b.title));
}

// Resolves canonical bundle filter keys (as produced by getAvailableBundles,
// and posted back from the checkbox form) into the full set of raw
// bundleTitle strings that share that key — needed because a single bundle
// can be stored under several locale-specific titles. Callers should filter
// with `bundleTitle: { in: <result> }`, not the raw keys directly.
export async function resolveBundleFilterTitles(
  shop: string,
  selectedKeys: string[],
): Promise<string[]> {
  if (selectedKeys.length === 0) return [];
  const keySet = new Set(selectedKeys);
  const rows = await db.orderLineItem.findMany({
    where: { shop, bundleTitle: { not: null } },
    select: { bundleTitle: true, bundleProductId: true },
    distinct: ["bundleTitle", "bundleProductId"],
  });
  const titles = new Set<string>();
  for (const r of rows) {
    if (!r.bundleTitle) continue;
    const key = r.bundleProductId ?? r.bundleTitle;
    if (keySet.has(key)) titles.add(r.bundleTitle);
  }
  return Array.from(titles);
}
