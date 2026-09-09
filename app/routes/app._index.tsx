import { useMemo, useState } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams, useFetcher, Form } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Badge,
  DataTable,
  Banner,
  Box,
  Button,
  Checkbox,
  Collapsible,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";
import { authenticate } from "../shopify.server";
import {
  getPeriodComparison,
  getRevenueTimeSeriesWithComparison,
  getTopProductsAndBundles,
  getBundleVsStandaloneSplit,
  getAvailableCountries,
  getAvailableChannels,
  getAvailableBundles,
  getAvailableTags,
  getAvailableProductTags,
  resolveBundleFilterTitles,
  shiftRangeByOneYear,
  type Filters,
  type DateRange,
} from "../models/analytics.server";
import { getSyncState } from "../models/bulkSync.server";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultRange(): DateRange {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 90);
  return { from, to };
}

function endOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(23, 59, 59, 999);
  return copy;
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

// Country code -> flag emoji + short label, for a friendlier filter list than
// raw ISO codes. Falls back to the raw code for anything not in this map.
const COUNTRY_LABELS: Record<string, string> = {
  DE: "🇩🇪 Deutschland",
  AT: "🇦🇹 Österreich",
  CH: "🇨🇭 Schweiz",
  NL: "🇳🇱 Niederlande",
  BE: "🇧🇪 Belgien",
  FR: "🇫🇷 Frankreich",
  IT: "🇮🇹 Italien",
  ES: "🇪🇸 Spanien",
  PL: "🇵🇱 Polen",
  GB: "🇬🇧 Vereinigtes Königreich",
  US: "🇺🇸 USA",
  DK: "🇩🇰 Dänemark",
  SE: "🇸🇪 Schweden",
  LU: "🇱🇺 Luxemburg",
};

const CHANNEL_LABELS: Record<string, string> = {
  web: "Onlineshop",
  pos: "Point of Sale",
  shopify_draft_order: "Entwurfsbestellungen",
  iphone: "Shopify POS (iPhone)",
  android: "Shopify POS (Android)",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const params = url.searchParams;

  const fromParam = params.get("from");
  const toParam = params.get("to");
  const range: DateRange = fromParam && toParam
    ? { from: new Date(fromParam), to: endOfDay(new Date(toParam)) }
    : defaultRange();

  const compareFromParam = params.get("compareFrom");
  const compareToParam = params.get("compareTo");
  const compareRange: DateRange | undefined =
    compareFromParam && compareToParam
      ? { from: new Date(compareFromParam), to: endOfDay(new Date(compareToParam)) }
      : undefined;

  const selectedBundleKeys = params.getAll("bundle");

  const syncState = await getSyncState(shop);

  if (!syncState || syncState.backfillStatus === "pending") {
    return { needsBackfill: true as const, syncState };
  }

  // Resolve the canonical bundle keys (productId-based, from the checkbox
  // form) into the actual raw bundleTitle strings stored per line item —
  // a single bundle can be stored under several locale-specific titles.
  const resolvedBundleTitles = await resolveBundleFilterTitles(shop, selectedBundleKeys);
  const filters: Filters = {
    countries: params.getAll("country"),
    channels: params.getAll("channel"),
    bundleTitles: resolvedBundleTitles,
    tags: params.getAll("tag"),
    productTags: params.getAll("productTag"),
  };

  const daySpanMs = range.to.getTime() - range.from.getTime();
  const granularity = daySpanMs > 1000 * 60 * 60 * 24 * 120 ? ("month" as const) : ("day" as const);

  const [comparison, timeSeriesData, topItems, previousTopItems, bundleSplit, availableCountries, availableChannels, availableBundles, availableTags, availableProductTags] =
    await Promise.all([
      getPeriodComparison(shop, range, filters, compareRange),
      getRevenueTimeSeriesWithComparison(shop, range, granularity, filters, compareRange),
      getTopProductsAndBundles(shop, range, 15, filters),
      getTopProductsAndBundles(shop, compareRange ?? shiftRangeByOneYear(range), 15, filters),
      getBundleVsStandaloneSplit(shop, range, filters),
      getAvailableCountries(shop),
      getAvailableChannels(shop),
      getAvailableBundles(shop),
      getAvailableTags(shop),
      getAvailableProductTags(shop),
    ]);

  return {
    needsBackfill: false as const,
    syncState,
    range: { from: isoDate(range.from), to: isoDate(range.to) },
    compareRange: compareRange
      ? { from: isoDate(compareRange.from), to: isoDate(compareRange.to) }
      : null,
    filters,
    selectedBundleKeys,
    comparison,
    timeSeries: timeSeriesData.current,
    previousTimeSeries: timeSeriesData.previous,
    topItems,
    previousTopItems,
    bundleSplit,
    availableCountries,
    availableChannels,
    availableBundles,
    availableTags,
    availableProductTags,
  };
};

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const syncFetcher = useFetcher();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [customCompare, setCustomCompare] = useState(Boolean(!data.needsBackfill && data.compareRange));

  const previousLabel = data.needsBackfill ? "Vorjahr" : data.comparison.previousLabel;

  const chartData = useMemo(() => {
    if (data.needsBackfill) return [];
    return data.timeSeries.map((p, i) => ({
      period: p.periodStart,
      Umsatz: Math.round(p.revenue),
      [previousLabel]: Math.round(data.previousTimeSeries[i]?.revenue ?? 0),
    }));
  }, [data, previousLabel]);

  const applyPreset = (days: number) => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days);
    const params = new URLSearchParams(searchParams);
    params.set("from", isoDate(from));
    params.set("to", isoDate(to));
    params.delete("compareFrom");
    params.delete("compareTo");
    navigate(`/app?${params.toString()}`);
  };

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
                  werden (Standard: letzte 2 Jahre).
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

  const { comparison, topItems, previousTopItems, bundleSplit, syncState, range, compareRange, filters, selectedBundleKeys } = data;
  const currency = "EUR";

  const activeFilterCount =
    (filters.countries?.length ?? 0) +
    (filters.channels?.length ?? 0) +
    (selectedBundleKeys?.length ?? 0) +
    (filters.tags?.length ?? 0) +
    (filters.productTags?.length ?? 0);

  const productRows = topItems.map((item) => [
    item.title,
    item.isBundle ? <Badge tone="info">Bundle</Badge> : <Badge>Einzelprodukt</Badge>,
    String(item.unitsSold),
    String(item.orderCount),
    formatMoney(item.revenue, currency),
  ]);

  const previousProductRows = previousTopItems.map((item) => [
    item.title,
    item.isBundle ? <Badge tone="info">Bundle</Badge> : <Badge>Einzelprodukt</Badge>,
    String(item.unitsSold),
    String(item.orderCount),
    formatMoney(item.revenue, currency),
  ]);

  return (
    <Page fullWidth>
      <TitleBar title="Umsatz-Analyse" />
      <BlockStack gap="500">
        {syncState?.backfillStatus === "completed" && (
          <Box>
            <InlineStack align="space-between" blockAlign="center">
              <Text as="span" variant="bodySm" tone="subdued">
                Letzter Datenabgleich:{" "}
                {syncState.backfillCompletedAt
                  ? new Date(syncState.backfillCompletedAt).toLocaleString("de-DE")
                  : "—"}
              </Text>
              <syncFetcher.Form method="post" action="/app/sync">
                <Button size="slim" submit loading={syncFetcher.state !== "idle"}>
                  Daten neu synchronisieren
                </Button>
              </syncFetcher.Form>
            </InlineStack>
          </Box>
        )}

        {/* ---- Zeitraum & Filter ---- */}
        <Card>
          <Form
            method="get"
            onSubmit={() => setFiltersOpen(false)}
          >
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Zeitraum &amp; Filter
                </Text>
                <InlineStack gap="200">
                  <Button size="slim" onClick={() => applyPreset(30)}>30 Tage</Button>
                  <Button size="slim" onClick={() => applyPreset(90)}>90 Tage</Button>
                  <Button size="slim" onClick={() => applyPreset(365)}>12 Monate</Button>
                  <Button
                    size="slim"
                    disclosure={filtersOpen ? "up" : "down"}
                    onClick={() => setFiltersOpen((v) => !v)}
                  >
                    {activeFilterCount > 0 ? `Filter (${activeFilterCount})` : "Filter"}
                  </Button>
                  <Button size="slim" variant="primary" submit>
                    Anwenden
                  </Button>
                </InlineStack>
              </InlineStack>

              <BlockStack gap="400">
                <InlineStack gap="400" wrap>
                  <Box minWidth="160px">
                    <Text as="label" variant="bodySm" tone="subdued">Von</Text>
                    <input
                      type="date"
                      name="from"
                      defaultValue={range.from}
                      style={{ display: "block", width: "100%", padding: 6, marginTop: 4 }}
                    />
                  </Box>
                  <Box minWidth="160px">
                    <Text as="label" variant="bodySm" tone="subdued">Bis</Text>
                    <input
                      type="date"
                      name="to"
                      defaultValue={range.to}
                      style={{ display: "block", width: "100%", padding: 6, marginTop: 4 }}
                    />
                  </Box>
                </InlineStack>

                <Checkbox
                  label="Eigenen Vergleichszeitraum statt automatisch 'Vorjahr' verwenden"
                  checked={customCompare}
                  onChange={setCustomCompare}
                />
                {customCompare && (
                  <InlineStack gap="400" wrap>
                    <Box minWidth="160px">
                      <Text as="label" variant="bodySm" tone="subdued">Vergleich von</Text>
                      <input
                        type="date"
                        name="compareFrom"
                        defaultValue={compareRange?.from}
                        style={{ display: "block", width: "100%", padding: 6, marginTop: 4 }}
                      />
                    </Box>
                    <Box minWidth="160px">
                      <Text as="label" variant="bodySm" tone="subdued">Vergleich bis</Text>
                      <input
                        type="date"
                        name="compareTo"
                        defaultValue={compareRange?.to}
                        style={{ display: "block", width: "100%", padding: 6, marginTop: 4 }}
                      />
                    </Box>
                  </InlineStack>
                )}

                <Collapsible open={filtersOpen} id="filters-collapsible">
                  <InlineGrid columns={{ xs: 1, md: 5 }} gap="400">
                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">Zielländer</Text>
                      {data.availableCountries.length === 0 && (
                        <Text as="p" tone="subdued" variant="bodySm">
                          Noch keine Lieferländer erfasst.
                        </Text>
                      )}
                      {data.availableCountries.map((code) => (
                        <label key={code} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <input
                            type="checkbox"
                            name="country"
                            value={code}
                            defaultChecked={filters.countries?.includes(code)}
                          />
                          <Text as="span" variant="bodyMd">{COUNTRY_LABELS[code] ?? code}</Text>
                        </label>
                      ))}
                    </BlockStack>

                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">Vertriebskanäle</Text>
                      {data.availableChannels.length === 0 && (
                        <Text as="p" tone="subdued" variant="bodySm">
                          Noch keine Kanaldaten erfasst.
                        </Text>
                      )}
                      {data.availableChannels.map((ch) => (
                        <label key={ch} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <input
                            type="checkbox"
                            name="channel"
                            value={ch}
                            defaultChecked={filters.channels?.includes(ch)}
                          />
                          <Text as="span" variant="bodyMd">{CHANNEL_LABELS[ch] ?? ch}</Text>
                        </label>
                      ))}
                    </BlockStack>

                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">Bestellungs-Tags</Text>
                      {data.availableTags.length === 0 && (
                        <Text as="p" tone="subdued" variant="bodySm">
                          Keine Bestellungs-Tags erfasst.
                        </Text>
                      )}
                      {data.availableTags.map((tag) => (
                        <label key={tag} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <input
                            type="checkbox"
                            name="tag"
                            value={tag}
                            defaultChecked={filters.tags?.includes(tag)}
                          />
                          <Text as="span" variant="bodyMd">{tag}</Text>
                        </label>
                      ))}
                    </BlockStack>

                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">Produkt-Tags</Text>
                      {data.availableProductTags.length === 0 && (
                        <Text as="p" tone="subdued" variant="bodySm">
                          Keine Produkt-Tags erfasst.
                        </Text>
                      )}
                      {data.availableProductTags.map((tag) => (
                        <label key={tag} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <input
                            type="checkbox"
                            name="productTag"
                            value={tag}
                            defaultChecked={filters.productTags?.includes(tag)}
                          />
                          <Text as="span" variant="bodyMd">{tag}</Text>
                        </label>
                      ))}
                    </BlockStack>

                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">Bundles (Drill-down)</Text>
                      {data.availableBundles.length === 0 && (
                        <Text as="p" tone="subdued" variant="bodySm">
                          Keine Bundles im gewählten Zeitraum gefunden.
                        </Text>
                      )}
                      {data.availableBundles.map((bundle) => (
                        <label key={bundle.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <input
                            type="checkbox"
                            name="bundle"
                            value={bundle.key}
                            defaultChecked={selectedBundleKeys?.includes(bundle.key)}
                          />
                          <Text as="span" variant="bodyMd">{bundle.title}</Text>
                        </label>
                      ))}
                    </BlockStack>
                  </InlineGrid>
                </Collapsible>

                <InlineStack>
                  <Button variant="primary" submit>
                    Anwenden
                  </Button>
                </InlineStack>
              </BlockStack>
            </BlockStack>
          </Form>
        </Card>

        {activeFilterCount > 0 && (
          <Banner tone="info">
            {selectedBundleKeys?.length
              ? `Ansicht eingeschränkt auf ${selectedBundleKeys.length} Bundle(s): ${data.availableBundles
                  .filter((b) => selectedBundleKeys.includes(b.key))
                  .map((b) => b.title)
                  .join(", ")}. `
              : ""}
            {filters.countries?.length ? `Länder: ${filters.countries.join(", ")}. ` : ""}
            {filters.channels?.length ? `Kanäle: ${filters.channels.join(", ")}. ` : ""}
            {filters.tags?.length ? `Bestellungs-Tags: ${filters.tags.join(", ")}. ` : ""}
            {filters.productTags?.length ? `Produkt-Tags: ${filters.productTags.join(", ")}.` : ""}
          </Banner>
        )}

        <Layout>
          <Layout.Section>
            <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
              <Card>
                <BlockStack gap="200">
                  <Text as="span" variant="bodySm" tone="subdued">Umsatz (Zeitraum)</Text>
                  <Text as="p" variant="headingLg">
                    {formatMoney(comparison.current.revenue, currency)}
                  </Text>
                  <Badge tone={comparison.revenueChangePct !== null && comparison.revenueChangePct >= 0 ? "success" : "critical"}>
                    {`${formatPct(comparison.revenueChangePct)} ggü. ${comparison.previousLabel}`}
                  </Badge>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="200">
                  <Text as="span" variant="bodySm" tone="subdued">Bestellungen</Text>
                  <Text as="p" variant="headingLg">{comparison.current.orderCount}</Text>
                  <Badge tone={comparison.orderCountChangePct !== null && comparison.orderCountChangePct >= 0 ? "success" : "critical"}>
                    {`${formatPct(comparison.orderCountChangePct)} ggü. ${comparison.previousLabel}`}
                  </Badge>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="200">
                  <Text as="span" variant="bodySm" tone="subdued">Ø Bestellwert</Text>
                  <Text as="p" variant="headingLg">
                    {formatMoney(comparison.current.averageOrderValue, currency)}
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {comparison.previousLabel}: {formatMoney(comparison.previous.averageOrderValue, currency)}
                  </Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="200">
                  <Text as="span" variant="bodySm" tone="subdued">Umsatzanteil Bundles</Text>
                  <Text as="p" variant="headingLg">{bundleSplit.bundleSharePct.toFixed(1)}%</Text>
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
                <Text as="h2" variant="headingMd">Umsatzentwicklung</Text>
                <div style={{ width: "100%", height: 320 }}>
                  <ResponsiveContainer>
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="period" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => formatMoney(Number(v), currency)} width={90} />
                      <Tooltip formatter={(v: number) => formatMoney(v, currency)} />
                      <Legend />
                      <Line type="monotone" dataKey="Umsatz" stroke="#008060" strokeWidth={2} dot={false} />
                      <Line
                        type="monotone"
                        dataKey={previousLabel}
                        stroke="#8C9196"
                        strokeWidth={2}
                        strokeDasharray="5 4"
                        dot={false}
                      />
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
                  {filters.bundleTitles?.length ? "Ausgewählte Bundles" : "Top Produkte & Bundles"}
                  {" — aktueller Zeitraum"}
                </Text>
                {productRows.length === 0 ? (
                  <Text as="p" tone="subdued">Keine Umsätze im gewählten Zeitraum / mit diesen Filtern.</Text>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "text", "numeric", "numeric", "numeric"]}
                    headings={["Produkt / Bundle", "Typ", "Einheiten", "Bestellungen", "Umsatz"]}
                    rows={productRows}
                  />
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  {filters.bundleTitles?.length ? "Ausgewählte Bundles" : "Top Produkte & Bundles"}
                  {` — Vergleichszeitraum (${comparison.previousLabel})`}
                </Text>
                {previousProductRows.length === 0 ? (
                  <Text as="p" tone="subdued">Keine Umsätze im Vergleichszeitraum / mit diesen Filtern.</Text>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "text", "numeric", "numeric", "numeric"]}
                    headings={["Produkt / Bundle", "Typ", "Einheiten", "Bestellungen", "Umsatz"]}
                    rows={previousProductRows}
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
