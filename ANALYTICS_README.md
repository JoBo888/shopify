# Umsatz-Analyse — Setup-Anleitung

Diese App basiert auf dem offiziellen Shopify Remix-App-Template und wurde um
ein Umsatz-Dashboard mit Jahresvergleich und Bundle-Auswertung erweitert.

## Was diese App macht

- Synchronisiert Bestellungen (Webhooks `orders/create`, `orders/updated`,
  `orders/cancelled`) plus einmaligem historischem Backfill (Bulk-Operations-API,
  Standard: 2 Jahre) in eine eigene Datenbank.
- Zeigt Umsatzentwicklung, Bestellungen, Ø Bestellwert und Vorjahresvergleich
  (YoY) für einen wählbaren Zeitraum.
- Gruppiert Bundle-Komponenten zu einer Zeile pro Bundle statt sie als
  Einzelprodukte zu zählen.

## Warum eine eigene Datenbank statt Live-API-Abfragen?

Jahresvergleiche brauchen historische Daten über viele Bestellungen hinweg.
Das bei jedem Dashboard-Aufruf live über die Admin-API abzufragen, würde an
Rate-Limits scheitern und wäre langsam. Die App hält daher eine eigene,
laufend synchronisierte Kopie der relevanten Bestelldaten (nur das, was für
Umsatzberechnung nötig ist — keine Kundendaten, Adressen o. Ä.).

## Setup

### 1. Voraussetzungen

- Node.js 20.19+ oder 22.12+
- [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) (`npm install -g @shopify/cli`)
- Ein [Shopify Partner-Account](https://partners.shopify.com/) und eine
  Development Store zum Testen
- **pnpm empfohlen** (das Template ist als pnpm-Workspace aufgesetzt —
  `pnpm-workspace.yaml` liegt bereits im Projekt). Mit npm funktioniert es
  ebenfalls, kann aber vereinzelt zu doppelt aufgelösten Abhängigkeiten
  führen (sichtbar z. B. als TypeScript-Fehler in `app/shopify.server.ts`,
  der zur Laufzeit keine Auswirkung hat). Mit `pnpm install` tritt das nicht auf.

```bash
pnpm install
```

### 2. App im Partner-Dashboard anlegen & verknüpfen

```bash
shopify app config link
```

Das trägt automatisch `client_id` in `shopify.app.toml` ein.

### 3. Lokal starten

```bash
shopify app dev
```

Das startet einen Tunnel, installiert die App in eurer Dev-Store und wendet
beim ersten Start automatisch die Prisma-Migrationen an (Skript `setup` in
`package.json`: `prisma generate && prisma migrate deploy`).

### 4. Nach der Installation: historischen Datenabgleich starten

Beim ersten Öffnen der App zeigt das Dashboard einen Button "Historische
Daten jetzt laden". Das stößt eine Shopify Bulk Operation an; die Ergebnisse
kommen asynchron über den `bulk_operations/finish`-Webhook zurück und werden
automatisch verarbeitet. Bei sehr großem Bestellvolumen kann das mehrere
Minuten dauern — die Seite kann währenddessen neu geladen werden.

### 5. Bundle-Erkennung mit PickyStory verifizieren

**Das ist der wichtigste Schritt, bevor ihr euch auf die Bundle-Zahlen
verlasst.** Die App erkennt Bundles standardmäßig über Shopifys natives
`LineItemGroup`-Feld (siehe `app/models/bundleDetection.server.ts`). Das ist
der Mechanismus, den die native Shopify Bundles App und viele
Cart-Transform-basierte Bundle-Apps nutzen — ob PickyStory ihn ebenfalls
verwendet, hängt vom genutzten Bundle-Typ ab (Fixed Bundle vs. Mix & Match
vs. Mengenrabatt).

So prüft ihr es:

1. Legt eine Testbestellung mit einem PickyStory-Bundle an.
2. Öffnet die Bestellung im Shopify Admin → "..." Menü →
   "View order in GraphiQL" (oder fragt die Order manuell über
   `shopify app dev` → GraphiQL ab) und schaut, ob die Line Items ein
   `lineItemGroup { id title }` Feld enthalten.
3. **Falls ja:** Nichts zu tun, die App erkennt das Bundle automatisch korrekt.
4. **Falls nein:** Schaut euch `customAttributes` der Line Items oder die
   Order-Tags an — PickyStory setzt in dem Fall vermutlich eigene Metadaten.
   Passt dann `extractBundleInfo()` in
   `app/models/bundleDetection.server.ts` entsprechend an (die Funktion ist
   bewusst isoliert, damit genau das an einer einzigen Stelle passiert).

Bis das verifiziert ist, würde ich den "Umsatzanteil Bundles"-KPI und die
Bundle-Kennzeichnung in der Produkttabelle mit Vorsicht behandeln — die
generelle Umsatz- und YoY-Zahlen sind davon unabhängig korrekt, da sie auf
`discountedTotalAmount` der Line Items basieren, unabhängig von der
Bundle-Zuordnung.

### 6. Hosting für Produktivbetrieb

Für den Store-Betrieb (nicht nur lokales Testen) braucht die App dauerhaftes
Hosting mit öffentlicher HTTPS-URL, z. B. Render, Fly.io, Railway oder ein
eigener Server. Wichtig:

- SQLite (`prisma/schema.prisma`, aktuell `file:dev.sqlite`) eignet sich nur
  für lokale Entwicklung. Für Produktion auf einen Postgres-Datastore
  umstellen (`provider = "postgresql"`, `url = env("DATABASE_URL")`) — dafür
  müsst ihr die Migrationen einmal neu generieren (`npx prisma migrate dev`),
  da SQLite- und Postgres-SQL nicht identisch sind.
- `SHOPIFY_APP_URL` und die Redirect-/Webhook-URLs müssen auf die
  öffentliche Domain zeigen (`shopify app deploy` aktualisiert das).
- Der Scope `read_all_orders` erfordert für öffentliche Apps im App Store
  eine Begründung im Review-Prozess; für eine private/Custom-App (nur für
  euren eigenen Store) reicht die einmalige Zustimmung bei der Installation.

## Projektstruktur (Ergänzungen zum Standard-Template)

```
app/models/
  analytics.server.ts       Umsatz-, YoY- und Produkt/Bundle-Auswertungen
  orderQuery.server.ts      GraphQL-Query-Bausteine (Einzelabruf + Bulk)
  orderSync.server.ts       Normalisierung + Upsert in die DB
  bulkSync.server.ts        Historischer Backfill via Bulk-Operations-API
  bundleDetection.server.ts Zentrale Stelle für Bundle-Erkennung (→ anpassen für PickyStory)

app/routes/
  app._index.tsx                    Dashboard
  app.sync.tsx                      Backfill-Trigger
  webhooks.orders.create.tsx
  webhooks.orders.updated.tsx
  webhooks.orders.cancelled.tsx
  webhooks.bulk-operations.finish.tsx

prisma/schema.prisma          + Order, OrderLineItem, SyncState
```

## Bekannte Einschränkungen dieser ersten Version

- Zeitraum-Presets sind fix (30/90/365 Tage); ein freier Datumsbereich lässt
  sich leicht ergänzen (in `app._index.tsx`, `RANGE_OPTIONS` + Loader).
- Multi-Currency-Shops: Beträge werden aktuell in `shopMoney` (Shop-Währung)
  aggregiert; bei mehreren Verkaufswährungen ggf. `presentmentMoney` +
  Umrechnung ergänzen.
- Keine Kosten-/Marge-Daten (nur Umsatz, kein "Ertrag" im Sinne von Deckungsbeitrag) —
  dafür bräuchtet ihr zusätzlich Einkaufspreise/COGS, die Shopify selbst nicht
  vorhält (z. B. über `InventoryItem.unitCost`, falls gepflegt).
