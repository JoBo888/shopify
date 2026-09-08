import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { syncSingleOrder } from "../models/orderSync.server";

// Shopify's REST webhook payload for orders/* does NOT include lineItemGroup
// (bundle) data, so instead of trusting the payload we just use it as a
// "something changed" signal and re-fetch the full order via GraphQL, which
// does expose lineItemGroup. See app/models/orderQuery.server.ts.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  if (!admin) {
    // No offline session (e.g. app was uninstalled between order creation and
    // webhook delivery) — nothing we can authenticate a GraphQL call with.
    return new Response();
  }

  const orderId = (payload as { id?: number | string }).id;
  if (orderId == null) return new Response();

  const orderGid = `gid://shopify/Order/${orderId}`;
  await syncSingleOrder(admin, shop, orderGid);

  return new Response();
};
