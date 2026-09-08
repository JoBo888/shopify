/**
 * Single place that decides "is this line item part of a bundle, and which one".
 *
 * Default strategy: Shopify's native LineItemGroup (used by the Shopify Bundles
 * app and most cart-transform-based bundle apps). Every line item that is a
 * component of a bundle carries a `lineItemGroup { id, title }` reference; the
 * bundle "parent" itself is virtual and never a purchasable line item.
 * https://shopify.dev/docs/api/admin-graphql/latest/objects/LineItemGroup
 *
 * PickyStory / Bundle.app can behave differently depending on the bundle type
 * you use (fixed bundle, mix & match, volume discount, etc.). Two things to
 * check with PickyStory support or by inspecting a real test order's GraphQL
 * response (Admin > Orders > open order > "..." > "View order in GraphiQL",
 * or query the order manually in GraphiQL — see README "Verifying bundle
 * detection"):
 *
 *   1. Does the order's line items expose `lineItemGroup`? If yes, no changes
 *      needed here.
 *   2. If not, PickyStory likely tags the order (order.tags) or sets a
 *      line item custom attribute / property (line_item.properties) such as
 *      "_bundle_id" or similar. Adjust `extractBundleInfo` below to read that
 *      instead — the GraphQL fragment in orderQuery.server.ts already fetches
 *      `customAttributes` on each line item so you have the raw data to work
 *      with without another API round trip.
 */

export interface RawLineItemForBundleDetection {
  lineItemGroup?: { id: string; title: string } | null;
  customAttributes?: { key: string; value: string }[] | null;
}

export interface BundleInfo {
  bundleGroupId: string | null;
  bundleTitle: string | null;
}

const PICKYSTORY_ATTRIBUTE_KEYS = [
  "_bundle_id",
  "_ps_bundle_id",
  "bundle_id",
] as const;

export function extractBundleInfo(
  lineItem: RawLineItemForBundleDetection,
): BundleInfo {
  // 1) Native Shopify bundle mechanism (preferred, most reliable).
  if (lineItem.lineItemGroup?.id) {
    return {
      bundleGroupId: lineItem.lineItemGroup.id,
      bundleTitle: lineItem.lineItemGroup.title ?? null,
    };
  }

  // 2) Fallback: look for a custom attribute PickyStory (or another app) may
  // have written onto the line item. Uncomment / adjust once you've confirmed
  // the actual key PickyStory uses for your store's bundle configuration.
  const attrs = lineItem.customAttributes ?? [];
  const bundleAttr = attrs.find((a) =>
    PICKYSTORY_ATTRIBUTE_KEYS.includes(
      a.key.toLowerCase() as (typeof PICKYSTORY_ATTRIBUTE_KEYS)[number],
    ),
  );
  if (bundleAttr) {
    return { bundleGroupId: bundleAttr.value, bundleTitle: null };
  }

  return { bundleGroupId: null, bundleTitle: null };
}
