import type { ActionFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { startBackfill } from "../models/bulkSync.server";

// Triggered by the "Historische Daten jetzt laden" button on the dashboard.
// Kicks off a Shopify bulk operation; results land asynchronously via the
// bulk_operations/finish webhook (see webhooks.bulk-operations.finish.tsx).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  await startBackfill(admin, session.shop);
  return redirect("/app");
};
