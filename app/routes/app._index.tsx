import { useMemo } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams, useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Select,
  Badge,
  DataTable,
  Banner,
  Box,
  Button,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { authenticate } from "../shopify.server";
import {
  getYoYComparison,
  getRevenueTimeSeries,
  getTopProductsAndBundles,
  getBundleVsStandaloneSplit,
} from "../models/analytics.server";
import { getSyncState } from "../models/bulkSync.server";

const RANGE_OPTIONS = [
  { label: "Letzte 30 Tage", value: "30" },
  { label: "Letzte 90 Tage", value: "90" },
  { label: "Letzte 12 Monate", value: "365" },
];

function rangeFromDays(days: number) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  return { from, to };
}

function formatMoney(amount: number, currency = "EUR") {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatPct(pct: number | null) {
  if (pct === null) return "—";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const days = Number(url.searchParams.get("days") ?? "90");
  const range = rangeFromDays(Number.isFinite(days) ? days : 90);

  const syncState = await getSyncState(shop);

  // First run: nothing synced yet, nudge the merchant to kick off the
  // historical backfill rather than silently showing an empty dashboard.
  if (!syncState || syncState.backfillStatus === "pending") {
    return { needsBackfill: true as const, syncState, days };
  }

  const [yoy, timeSeries, topItems, bundleSplit] = await Promise.all([
    getYoYComparison(shop, range),
    getRevenueTimeSeries(shop, range, days > 120 ? "month" : "day"),
    getTopProductsAndBundles(shop, range, 10),
    getBundleVsStandaloneSplit(shop, range),
  ]);

  return {
    needsBackfill: false as const,
    syncState,
    days,
    yoy,
    timeSeries,
    topItems,
    bundleSplit,
  };
};

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const syncFetcher = useFetcher();

  const days = data.days ?? 90;

  const handleRangeChange = (value: string) => {
    const params = new URLSearchParams(searchParams);
    params.set("days", value);
    navigate(`/app?${params.toString()}`);
  };

  const chartData = useMemo(() => {
    if (data.needsBackfill) return [];
    return data.timeSeries.map((p) => ({
      period: p.periodStart,
      Umsatz: Math.round(p.revenue),
    }));
  }, [data]);

  if (data.needsBackfill) {
    const status = data.syncState?.backfillStatus ?? "pending";
    return (
      <Page>
        <TitleBar title="Umsatz-Analyse" />
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Erstmaliger Datenabgleich erforderlich
                </Text>
                <Text as="p" variant="bodyMd">
                  Bevor Umsatz- und Jahresvergleiche angezeigt werden können,
                  müssen historische Bestellungen aus eurem Shop geladen
                  werden (Standard: letzte 2 Jahre). Das läuft im Hintergrund
                  über die Shopify Bulk-Operations-API und kann je nach
                  Bestellvolumen einige Minuten dauern.
                </Text>
                {status === "running" && (
                  <Banner tone="info">
                    Datenabgleich läuft … Diese Seite kann neu geladen werden,
                    um den Fortschritt zu prüfen.
                  </Banner>
                )}
                {status === "failed" && (
                  <Banner tone="critical">
                    Der letzte Abgleich ist fehlgeschlagen:{" "}
                    {data.syncState?.errorMessage ?? "Unbekannter Fehler"}
                  </Banner>
                )}
                <InlineStack>
                  <syncFetcher.Form method="post" action="/app/sync">
                    <Button
                      variant="primary"
                      submit
                      loading={syncFetcher.state !== "idle" || status === "running"}
                    >
                      Historische Daten jetzt laden
                    </Button>
                  </syncFetcher.Form>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  const { yoy, topItems, bundleSplit, syncState } = data;
  const currency = "EUR";

  const productRows = topItems.map((item) => [
    item.title,
    item.isBundle ? <Badge tone="info">Bundle</Badge> : <Badge>Einzelprodukt</Badge>,
    String(item.unitsSold),
    formatMoney(item.revenue, currency),
  ]);

  return (
    <Page fullWidth>
      <TitleBar title="Umsatz-Analyse" />
      <BlockStack gap="500">
        {syncState?.backfillStatus === "completed" && (
          <Box>
            <InlineStack align="space-between">
              <Text as="span" variant="bodySm" tone="subdued">
                Letzter Datenabgleich:{" "}
                {syncState.backfillCompletedAt
                  ? new Date(syncState.backfillCompletedAt).toLocaleString("de-DE")
                  : "—"}
              </Text>
              <Select
                label="Zeitraum"
                labelInline
                options={RANGE_OPTIONS}
                value={String(days)}
                onChange={handleRangeChange}
              />
            </InlineStack>
          </Box>
        )}

        <Layout>
          <Layout.Section>
            <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
              <Card>
                <BlockStack gap="200">
                  <Text as="span" variant="bodySm" tone="subdued">
                    Umsatz (Zeitraum)
                  </Text>
                  <Text as="p" variant="headingLg">
                    {formatMoney(yoy.current.revenue, currency)}
                  </Text>
                  <Badge tone={yoy.revenueChangePct !== null && yoy.revenueChangePct >= 0 ? "success" : "critical"}>
                    {`${formatPct(yoy.revenueChangePct)} ggü. Vorjahr`}
                  </Badge>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="200">
                  <Text as="span" variant="bodySm" tone="subdued">
                    Bestellungen
                  </Text>
                  <Text as="p" variant="headingLg">
                    {yoy.current.orderCount}
                  </Text>
                  <Badge tone={yoy.orderCountChangePct !== null && yoy.orderCountChangePct >= 0 ? "success" : "critical"}>
                    {`${formatPct(yoy.orderCountChangePct)} ggü. Vorjahr`}
                  </Badge>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="200">
                  <Text as="span" variant="bodySm" tone="subdued">
                    Ø Bestellwert
                  </Text>
                  <Text as="p" variant="headingLg">
                    {formatMoney(yoy.current.averageOrderValue, currency)}
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    Vorjahr: {formatMoney(yoy.previous.averageOrderValue, currency)}
                  </Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="200">
                  <Text as="span" variant="bodySm" tone="subdued">
                    Umsatzanteil Bundles
                  </Text>
                  <Text as="p" variant="headingLg">
                    {bundleSplit.bundleSharePct.toFixed(1)}%
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {formatMoney(bundleSplit.bundleRevenue, currency)} aus Bundles
                  </Text>
                </BlockStack>
              </Card>
            </InlineGrid>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Umsatzentwicklung
                </Text>
                <div style={{ width: "100%", height: 320 }}>
                  <ResponsiveContainer>
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="period" tick={{ fontSize: 12 }} />
                      <YAxis
                        tick={{ fontSize: 12 }}
                        tickFormatter={(v) => formatMoney(Number(v), currency)}
                        width={90}
                      />
                      <Tooltip formatter={(v: number) => formatMoney(v, currency)} />
                      <Line type="monotone" dataKey="Umsatz" stroke="#008060" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Top Produkte &amp; Bundles
                </Text>
                {productRows.length === 0 ? (
                  <Text as="p" tone="subdued">
                    Keine Umsätze im gewählten Zeitraum.
                  </Text>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "text", "numeric", "numeric"]}
                    headings={["Produkt / Bundle", "Typ", "Verkaufte Einheiten", "Umsatz"]}
                    rows={productRows}
                  />
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
