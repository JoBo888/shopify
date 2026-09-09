# Umsatz-Analyse — Setup-Anleitung

Diese App basiert auf dem offiziellen Shopify Remix-App-Template und wurde um
ein Umsatz-Dashboard mit Jahresvergleich und Bundle-Auswertung erweitert.

## Neu: Filter, freier Zeitraum & Bundle-Drill-down

- **Freier Zeitraum** über Von/Bis-Datumsfelder (statt nur fixer Presets)
- **Eigener Vergleichszeitraum** wahlweise statt automatisch "Vorjahr"
- **Filter nach Zielland** (Lieferadresse) und **Vertriebskanal** (`sourceName`,
  z. B. Onlineshop vs. POS vs. Draft Orders)
- **Bundle-Drill-down**: ein oder mehrere Bundles auswählen, um Umsatz/Ertrag
  nur für diese über die Zeit zu sehen
- **Bundle-Gruppierungsfehler behoben**: Bundles wurden vorher pro Bestellung
  einzeln gezählt (da Shopifys `LineItemGroup`-ID pro Bestellung neu vergeben
  wird), jetzt korrekt über den Bundle-**Titel** hinweg aggregiert

### Wichtig: einmaliger Nachsync für bereits importierte Bestellungen

Land und Vertriebskanal sind neue Datenfelder. Bestellungen, die **vor**
diesem Update importiert wurden, haben diese Felder noch leer (`null`) —
sie tauchen dann nicht in den Länder-/Kanalfiltern auf. Einmalig beheben:

1. App im Store öffnen
2. Oben rechts auf **"Daten neu synchronisieren"** klicken
3. Das startet einen neuen Bulk-Abgleich über die letzten 2 Jahre — bereits
   vorhandene Bestellungen werden dabei aktualisiert (nicht dupliziert),
   diesmal inklusive Land und Kanal

## Neu: Umsatz jetzt netto und retouren-bereinigt

- **Umsatz = netto (ohne MwSt) UND abzüglich Retouren/Teil-Retouren.**
  Nutzt jetzt `LineItem.priceAfterAllDiscountsBeforeTaxesSet` (Shopify API
  2026-07+) statt `discountedTotalSet` — dieses Feld schließt Steuern aus
  und rechnet retournierte/entfernte Mengen automatisch heraus.
- **Stornierte Bestellungen (`cancelledAt` gesetzt) waren schon vorher
  ausgeschlossen** — das ändert sich nicht, war nur vorher nicht in der
  README erwähnt.
- **Wichtig — einmaliger Nachsync nötig:** Bereits importierte Bestellungen
  wurden mit dem alten (teils brutto, retouren-inklusive) Wert gespeichert.
  Auf **„Daten neu synchronisieren"** klicken, damit alle Bestellungen der
  letzten 2 Jahre mit dem korrigierten, netto/retouren-bereinigten Umsatz
  neu abgeglichen werden. Bis dahin sind Zahlen ein Mix aus altem und neuem
  Berechnungsstand.

## Neu: Bundle-Erkennung sprachunabhängig gemacht

- **Bundles wurden bisher pro Bestellsprache separat gezählt** (z.B. "EMS
  HOME System mit 20 Elektroden" / "... with 20 Electrodes" / "...-systeem
  met 20 elektroden" als 3 verschiedene Zeilen), weil `LineItemGroup.title`
  laut Shopify in der Sprache zurückkommt, in der die Bestellung aufgegeben
  wurde — nicht als stabiler Bezeichner gedacht.
- Gruppierung läuft jetzt über `LineItemGroup.productId` (stabil, sprach­
  unabhängig, benötigt API 2026-07+). Der angezeigte Titel ist der
  "Mehrheits-Titel" über alle Sprachvarianten hinweg.
- **Der Bundle-Filter (Checkbox-Liste) filtert weiterhin korrekt** — eine
  Auswahl schließt automatisch alle Sprachvarianten des Bundles mit ein.
- **Wichtig:** Bundles, die noch nie über die native Shopify-Bundle-
  Mechanik synchronisiert wurden (nur der PickyStory-Fallback ohne
  `productId`, oder alte Zeilen vor diesem Update), fallen weiterhin auf
  Titel-Gruppierung zurück und können sich in seltenen Fällen noch
  aufsplitten — betrifft aber nur bereits synchronisierte Altdaten vor dem
  nächsten Resync.
- **Hinweis, was NICHT im Bundle-Filter auftaucht:** Der Filter zeigt nur
  echte Shopify-Bundles (mehrere Produkte zu einem Paket kombiniert).
  Einzelprodukte mit z.B. verschiedenen Längen/Größen als Varianten
  (z. B. "Klimmzugstange, 60 cm" vs. "100 cm") sind **keine Bundles** und
  erscheinen hier bewusst nicht — das ist kein Fehler, sondern Absicht.
- **Einmaliger Nachsync nötig**, damit `bundleProductId` für alle
  Bestellungen nachgetragen wird: oben rechts auf
  "Daten neu synchronisieren" klicken.

## Was diese App macht

- Synchronisiert Bestellungen (Webhooks `orders/create`, `orders/updated`,
  `orders/cancelled`) plus einmaligem historischem Backfill (Bulk-Operations-API,
  Standard: 2 Jahre) in eine eigene Datenbank.
- Zeigt Umsatzentwicklung, Bestellungen, Ø Bestellwert, **Ertrag (Rohgewinn/Marge)**
  und Vorjahresvergleich (YoY) für einen wählbaren Zeitraum.
- Gruppiert Bundle-Komponenten zu einer Zeile pro Bundle statt sie als
  Einzelprodukte zu zählen — inkl. Marge pro Bundle.

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
- **Eine Postgres-Datenbank für lokale Entwicklung.** Das Schema ist auf
  Postgres umgestellt (siehe Abschnitt 6). Am einfachsten lokal per Docker:
  ```bash
  docker run --name umsatz-analyse-db -e POSTGRES_PASSWORD=postgres \
    -p 5432:5432 -d postgres:16
  ```
  und dann eine `.env`-Datei im Projekt-Root anlegen:
  ```
  DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
  ```
  Alternativ direkt gegen die Render-Datenbank aus Abschnitt 6a entwickeln
  (External Database URL aus dem Render-Dashboard kopieren).
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

**Kurzfassung: der schnellste Weg ist jetzt der "Deploy to Render"-Button (Details unten in Abschnitt 6a).** Alternativ funktioniert jede andere Docker-fähige Plattform (Fly.io, Railway, eigener Server) mit dem mitgelieferten `Dockerfile`.

Grundsätzlich gilt für jede Hosting-Variante:

- Die Datenbank ist bereits auf Postgres umgestellt (`prisma/schema.prisma`,
  Migration `prisma/migrations/0001_init`) — SQLite kommt nur noch lokal
  beim allerersten Ausprobieren zum Einsatz, falls ihr das selbst so
  einrichtet.
- `SHOPIFY_APP_URL` und die Redirect-/Webhook-URLs müssen auf die
  öffentliche Domain zeigen (`shopify app deploy` aktualisiert das im
  Partner-Dashboard).
- Der Scope `read_all_orders` erfordert für öffentliche Apps im App Store
  eine Begründung im Review-Prozess; für eine private/Custom-App (nur für
  euren eigenen Store) reicht die einmalige Zustimmung bei der Installation.

### 6a. Ein-Klick-Deploy über Render

Die Datei `render.yaml` im Projekt-Root ist ein sogenanntes "Render
Blueprint" — es definiert Web-Service *und* Postgres-Datenbank in einem
Rutsch, inklusive automatisch verknüpfter `DATABASE_URL`.

**Wichtig zur Erwartungshaltung:** Auch das ist kein "ZIP hochladen und
fertig" — Render deployt aus einem Git-Repository, nicht aus einer
Zip-Datei. Der Ablauf ist aber danach wirklich nur noch wenige Klicks:

1. **Einmalig:** Projekt in ein eigenes (privates) GitHub-Repository
   pushen, z. B.:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   gh repo create umsatz-analyse-app --private --source=. --push
   # oder ohne GitHub CLI: manuell ein leeres Repo auf github.com anlegen
   # und die von GitHub angezeigten Befehle ausführen
   ```
2. Auf [render.com](https://render.com) einloggen/registrieren →
   **New +** → **Blueprint** → das gerade erstellte Repo auswählen.
   Render erkennt `render.yaml` automatisch und zeigt an, was angelegt wird
   (1 Web-Service + 1 Postgres-Datenbank).
3. **Deploy** klicken. Render baut das `Dockerfile`, legt die Datenbank an
   und verbindet beides automatisch über `DATABASE_URL`.
4. Nach dem ersten (fehlschlagenden) Deploy zeigt Render die vergebene
   URL, z. B. `https://umsatz-analyse-app.onrender.com`. Diese URL:
   - im Render-Dashboard unter dem Web-Service → **Environment** als
     `SHOPIFY_APP_URL` eintragen
   - zusätzlich dort `SHOPIFY_API_KEY` und `SHOPIFY_API_SECRET` aus dem
     Partner-Dashboard eintragen (diese drei Werte lässt `render.yaml`
     bewusst leer, damit keine Geheimnisse im Git-Repo landen)
5. Lokal `shopify.app.toml` → `application_url` bzw. per
   ```bash
   shopify app config link
   shopify app deploy
   ```
   auf dieselbe Render-URL zeigen lassen, damit Shopify Redirect- und
   Webhook-URLs kennt.
6. In Render **Manual Deploy → Deploy latest commit** erneut anstoßen,
   damit die App mit den jetzt gesetzten Umgebungsvariablen neu startet.
7. Ab hier läuft die App dauerhaft — jeder weitere `git push` auf den
   verbundenen Branch löst automatisch einen neuen Deploy aus.

<!-- Sobald das Repo öffentlich auf GitHub liegt, funktioniert auch der
     offizielle Render-Button für einen Klick-Deploy-Link:
     [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)
     Für ein privates Repo (empfohlen, da hier eure Store-Zugangsdaten
     landen) ist der manuelle "New + → Blueprint"-Weg oben der richtige. -->

> **Kostenhinweis:** `render.yaml` ist bewusst auf bezahlte Tarife
> voreingestellt — Web-Service auf `starter` (~7 $/Monat), Datenbank auf
> `basic-256mb` (~7 $/Monat, zusammen ca. 14 $/Monat). Render benennt
> Postgres-Tarife inzwischen anders als Compute-Tarife: der alte Name
> `starter` funktioniert für Datenbanken nicht mehr ("Legacy Postgres
> plans... are no longer supported for new databases") — deshalb hier
> zwei unterschiedliche Tarifnamen für zwei unterschiedliche Dinge. Der
> kostenlose Tarif pausiert Web-Services nach 15 Minuten Inaktivität und
> lässt die Datenbank nach 30 Tagen ablaufen — für zuverlässige
> Webhook-Verarbeitung (Bestellsynchronisation) ungeeignet. Zum
> unverbindlichen ersten Ausprobieren kann in `render.yaml` trotzdem
> `plan: free` eingetragen werden, sollte vor Produktivbetrieb aber
> umgestellt werden.

### 6b. Alternative: Fly.io / Railway / eigener Server

Funktioniert genauso über das mitgelieferte `Dockerfile`, nur ohne die
automatische Datenbank-Verknüpfung aus `render.yaml` — dort muss
`DATABASE_URL` manuell auf eine selbst angelegte Postgres-Instanz zeigen
(z. B. Fly Postgres via `fly postgres create`, oder eine externe
Postgres-Instanz wie Neon/Supabase).

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
- **Ertrag/Marge basiert auf `InventoryItem.unitCost`** ("Cost per item" in
  Shopify). Das ist nur so gut wie die dort gepflegten Daten:
  - Fehlt der Wert bei einer Variante, wird die Zeile bei der Margenberechnung
    ausgeklammert (nicht als 0 gewertet) — das Dashboard zeigt dann an, wie
    viel Prozent des Umsatzes überhaupt Kostendaten haben ("nur X% mit
    Kostendaten"). Bei niedriger Abdeckung ist der Ertragswert nur ein grober
    Anhaltspunkt.
  - Der Zugriff auf `unitCost` erfordert den Scope `read_inventory` **und**
    dass "View product costs" für die App/den User in den Shopify-Staff-
    Berechtigungen aktiviert ist — sonst liefert das Feld `null`.
  - Es ist ein reiner Rohgewinn (Verkaufspreis − Einkaufspreis), keine volle
    Deckungsbeitragsrechnung: Versand-, Verpackungs-, Marketing- oder
    Zahlungskosten sind nicht enthalten.
