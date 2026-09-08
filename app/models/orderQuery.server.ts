// Shared GraphQL fragment used both for single-order webhook lookups and for
// the bulk operation backfill query, so the shape stays consistent in
// orderSync.server.ts.

export const ORDER_LINE_ITEM_FIELDS = /* GraphQL */ `
  id
  quantity
  title
  sku
  originalTotalSet {
    shopMoney { amount currencyCode }
  }
  discountedTotalSet {
    shopMoney { amount currencyCode }
  }
  variant {
    id
    title
    product { id }
  }
  lineItemGroup {
    id
    title
  }
  customAttributes {
    key
    value
  }
`;

// Used for webhook-triggered single order fetches (orders/create, orders/updated).
export const ORDER_BY_ID_QUERY = /* GraphQL */ `
  query OrderForSync($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      cancelledAt
      test
      totalPriceSet {
        shopMoney { amount currencyCode }
      }
      totalDiscountsSet {
        shopMoney { amount currencyCode }
      }
      lineItems(first: 100) {
        edges { node { ${ORDER_LINE_ITEM_FIELDS} } }
      }
    }
  }
`;

// Used as the bulk operation query string for the historical backfill.
// Bulk operations use a flat, connection-based query with no variables.
export function buildBulkBackfillQuery(sinceISODate: string): string {
  return /* GraphQL */ `
    {
      orders(query: "created_at:>='${sinceISODate}'") {
        edges {
          node {
            id
            name
            createdAt
            cancelledAt
            test
            totalPriceSet { shopMoney { amount currencyCode } }
            totalDiscountsSet { shopMoney { amount currencyCode } }
            lineItems {
              edges {
                node {
                  ${ORDER_LINE_ITEM_FIELDS}
                }
              }
            }
          }
        }
      }
    }
  `;
}
