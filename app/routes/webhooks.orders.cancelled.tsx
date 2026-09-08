import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { markOrderCancelled } from "../models/orderSync.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const orderId = (payload as { id?: number | string }).id;
  const cancelledAt = (payload as { cancelled_at?: string }).cancelled_at;
  if (orderId == null) return new Response();

  const orderGid = `gid://shopify/Order/${orderId}`;
  await markOrderCancelled(shop, orderGid, cancelledAt ?? new Date().toISOString());

  return new Response();
};
