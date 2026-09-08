import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { processCompletedBackfill } from "../models/bulkSync.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, admin } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  if (!admin) return new Response();

  await processCompletedBackfill(admin, shop);

  return new Response();
};
