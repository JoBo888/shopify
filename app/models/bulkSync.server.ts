import db from "../db.server";
import { buildBulkBackfillQuery } from "./orderQuery.server";
import { normalizeOrderNode, upsertOrder } from "./orderSync.server";

type AdminGraphqlClient = {
  graphql: (query: string, opts?: any) => Promise<Response>;
};

// How far back to backfill by default. Two years is enough for a YoY
// comparison plus some headroom; raise if you need multi-year trends.
// Note: read_all_orders is required to see orders older than 60 days.
const DEFAULT_BACKFILL_YEARS = 2;

export async function startBackfill(
  admin: AdminGraphqlClient,
  shop: string,
): Promise<{ started: boolean; reason?: string }> {
  const state = await db.syncState.upsert({
    where: { shop },
    create: { shop, backfillStatus: "pending" },
    update: {},
  });

  if (state.backfillStatus === "running") {
    return { started: false, reason: "already_running" };
  }

  const since = new Date();
  since.setFullYear(since.getFullYear() - DEFAULT_BACKFILL_YEARS);
  const sinceISODate = since.toISOString().slice(0, 10);

  const mutation = /* GraphQL */ `
    mutation StartOrdersBackfill($query: String!) {
      bulkOperationRunQuery(query: $query) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }
  `;

  const response = await admin.graphql(mutation, {
    variables: { query: buildBulkBackfillQuery(sinceISODate) },
  });
  const json = await response.json();
  const result = json?.data?.bulkOperationRunQuery;

  if (result?.userErrors?.length) {
    const message = result.userErrors.map((e: any) => e.message).join("; ");
    await db.syncState.update({
      where: { shop },
      data: { backfillStatus: "failed", errorMessage: message },
    });
    return { started: false, reason: message };
  }

  await db.syncState.update({
    where: { shop },
    data: {
      backfillStatus: "running",
      backfillBulkOpId: result?.bulkOperation?.id ?? null,
      backfillRequestedAt: new Date(),
      errorMessage: null,
    },
  });

  return { started: true };
}

// Called from the bulk_operations/finish webhook once Shopify has generated
// the JSONL export. Downloads it, reassembles order + line item rows
// (bulk operations flatten nested connections into a flat JSONL stream where
// child rows carry a `__parentId` pointing at their parent order's id), and
// upserts each order.
export async function processCompletedBackfill(
  admin: AdminGraphqlClient,
  shop: string,
): Promise<void> {
  const query = /* GraphQL */ `
    query CurrentBulkOperation {
      currentBulkOperation {
        id
        status
        errorCode
        url
        objectCount
      }
    }
  `;
  const response = await admin.graphql(query);
  const json = await response.json();
  const op = json?.data?.currentBulkOperation;

  if (!op) return;

  if (op.status === "FAILED" || op.status === "CANCELED") {
    await db.syncState.update({
      where: { shop },
      data: { backfillStatus: "failed", errorMessage: op.errorCode ?? op.status },
    });
    return;
  }

  if (op.status !== "COMPLETED" || !op.url) {
    // Not actually done yet (finish webhook can occasionally race); ignore,
    // a later delivery or manual re-check will pick it up.
    return;
  }

  const fileResponse = await fetch(op.url);
  const text = await fileResponse.text();
  const lines = text.split("\n").filter(Boolean);

  const ordersById = new Map<string, any>();

  for (const line of lines) {
    const obj = JSON.parse(line);
    if (obj.__parentId) {
      const parent = ordersById.get(obj.__parentId);
      if (!parent) continue;
      parent.lineItems.edges.push({ node: obj });
    } else {
      ordersById.set(obj.id, { ...obj, lineItems: { edges: [] } });
    }
  }

  // Upsert sequentially in reasonably sized batches to avoid holding the
  // whole shop's order history in memory as pending DB transactions at once.
  const BATCH_SIZE = 50;
  const orderNodes = Array.from(ordersById.values());
  for (let i = 0; i < orderNodes.length; i += BATCH_SIZE) {
    const batch = orderNodes.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map((node) => upsertOrder(normalizeOrderNode(shop, node))),
    );
  }

  await db.syncState.update({
    where: { shop },
    data: {
      backfillStatus: "completed",
      backfillCompletedAt: new Date(),
      lastWebhookSyncAt: new Date(),
      errorMessage: null,
    },
  });
}

export async function getSyncState(shop: string) {
  return db.syncState.findUnique({ where: { shop } });
}
