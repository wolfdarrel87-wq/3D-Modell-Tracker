# Druckplatte – 3D-Druck-Tracker (Preview 4.0)

Druckplatte sammelt 3D-Druck-Aufträge (MakerWorld-Modelle und eigene Ideen), zeigt den aktuellen Druck und die Warteschlange und verwaltet alles für den Admin.

> **Status: isolierte Preview – nicht in Produktion deployt.** Dieser Stand wartet auf Freigabe.
> Den Abschlussbericht mit allen Prüfpunkten findest du in [`docs/ABSCHLUSSBERICHT.md`](docs/ABSCHLUSSBERICHT.md).

## Was ist neu gegenüber dem Prototyp „Druckplatte 3.0“?

Der Prototyp war eine einzelne HTML-Datei. Alle Daten lagen in einem geteilten `window.storage`, also in jedem Browser vollständig. Diese Version hat einen kleinen Node-Server ohne externe Abhängigkeiten. Er entscheidet **serverseitig**, was ein Browser überhaupt bekommt:

- **Datenschutz:** Aktueller Druck und Druckwarteschlange zeigen fremde private Aufträge nur anonym, zum Beispiel „🔒 Privater Druck“ oder „Aktuell wird ein anderer Druck bearbeitet.“ Private Daten werden gar nicht erst übertragen. Öffentliche Modelle erscheinen nur über eine feste Allowlist (Bild, Name, Material, Farbe, Link), **nie** mit DP-Nummer.
- **Eigene Position:** Jeder sieht die eigene Position, etwa „Dein Platz: 3 · Noch 2 Drucke vor dir“.
- **DP-Auftragsnummern für Ideen:** Auch Ideen erhalten `DP-JJJJ-NNNNNN` aus demselben atomaren Zähler. Für Alt-Ideen gibt es eine Migration mit Dry-Run.
- **Vertrauenswürdige Geräte:** Nach einmaliger E-Mail-Code-Anmeldung bleibt der Browser genau 30 Tage vertrauenswürdig. Links aus Druckplatte-Mails brauchen dann keinen neuen Code und legen kein neues Gerät an. Die Geräte lassen sich im Profil verwalten.
- **Admin:** Der Admin sieht alles, wie bisher. Er braucht dafür zusätzlich das Admin-Passwort, das serverseitig in jeder Sitzung geprüft wird und den alten Client-PIN ersetzt.

## Schnellstart (Preview)

Voraussetzung: Node.js ≥ 20. Es wird kein `npm install` benötigt.

```bash
npm run preview            # startet auf http://localhost:8080 (legt Testdaten an, falls leer)
npm run preview -- --reset # Testdaten neu anlegen (inkl. Migrations-Dry-Run + Preview-Migration)
```

- Die Anmeldecodes landen im **Dev-Postausgang** unter <http://localhost:8080/dev/outbox>. Es wird keine echte E-Mail versendet.
- Testkonten: `anna@example.test` (Platz 3 in der Warteschlange), `dora@example.test` (ohne Warteschlangen-Auftrag), `ben@…`, `clara@…`.
- Admin: `admin@druckplatte.test`, Admin-Passwort der Preview: `preview-admin-2026` (nur Preview!).
- Daten liegen in `data/preview/` (nicht im Git). Die Preview verweigert Datenverzeichnisse ohne „preview“ im Pfad.

**Preview auf dem Raspberry Pi starten und vom PC aus ansehen:** Die Cookies sind absichtlich `Secure`. Browser akzeptieren sie ohne HTTPS nur für `localhost`, nicht für `http://<pi-ip>`. Die Preview auf dem Pi läuft deshalb weiter auf `127.0.0.1`. Du öffnest sie per SSH-Tunnel:

```bash
ssh -L 8080:127.0.0.1:8080 <benutzer>@<raspberry-pi>   # danach am PC: http://localhost:8080
```

Dafür gibt es drei Gründe: Der Dev-Postausgang zeigt die Anmeldecodes, die Preview ist so nie aus dem Netz erreichbar, und sie läuft getrennt von der Produktion (eigener Port, eigenes `data/preview`). Ist Port 8080 auf dem Pi schon belegt, etwa durch die Produktion, startest du mit `PORT=8090 npm run preview` und tunnelst `8090` statt `8080`.

## Tests

```bash
npm test          # Server-, Datenschutz-, DP- und Trusted-Device-Tests (node:test, ohne Abhängigkeiten)
npm run test:e2e  # Browser-Tests mit Playwright/Chromium (Playwright muss installiert sein)
```

Die E2E-Tests legen Screenshots in `test-results/screenshots/` ab, für 360, 390, 430, 768, 1280 und 1920 px.

## Konfiguration (Umgebungsvariablen)

| Variable | Standard | Bedeutung |
|---|---|---|
| `DRUCKPLATTE_ENV` | `preview` | `preview`, `test` oder `production` |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | Adresse des Servers |
| `DATA_DIR` | `data/preview` | Datenverzeichnis (JSON-Datei, Bilder, Postausgang, Schlüssel) |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` | Basis für Links in E-Mails (Produktion: `https://…`) |
| `ADMIN_EMAILS` | – | Kommagetrennte Admin-Adressen (Admin-Rolle kommt **nur** von hier) |
| `ADMIN_PASSWORD_HASH` | – | scrypt-Hash, erzeugen mit `printf '%s' 'passwort' \| npm run hash-password` |
| `LOGIN_ALLOWLIST` | leer = alle | Optional: nur diese Adressen dürfen sich anmelden |
| `SESSION_TTL_HOURS` | `12` | Lebensdauer einer normalen Sitzung (das Gerät gilt davon unabhängig 30 Tage) |
| `AUTH_PEPPER` | Datei `auth-pepper.key` | Schlüssel für Token-/Code-Hashes. Ein Austausch macht alle Geräte ungültig |
| `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` | – | Optional: Cloudflare-Access-JWT verpflichtend prüfen |
| `TRUST_PROXY` | `false` | `CF-Connecting-IP`/`X-Forwarded-For` für das Rate-Limit verwenden |
| `MAIL_PRODUCTION_ENABLED` | `false` | Mit `true` startet dieser Build **absichtlich nicht**, weil kein Produktions-Mailtransport integriert ist |

Die Laufzeit vertrauenswürdiger Geräte ist fest auf 30 Tage gesetzt und nicht konfigurierbar.

## Migration bestehender Ideen

```bash
node scripts/migrate-idea-dp.js --data-dir data/preview           # Dry-Run (READ-ONLY)
node scripts/migrate-idea-dp.js --data-dir data/preview --apply   # anwenden (mit Backup, Lock)
```

Die Migration arbeitet deterministisch (Erstellungszeitpunkt, dann ID) und ist idempotent. Sie nutzt den gemeinsamen Zähler und ändert keine anderen Felder. In Produktion (`DRUCKPLATTE_ENV=production`) verweigert `--apply` die Ausführung ohne ausdrückliches `--allow-production`.

## Aufbau

```
public/            index.html (Oberfläche, Styles) + app.js (Logik, CSP-konform)
server/
  app.js           Routing und API
  store.js         JSON-Speicher mit Copy-on-Write-Transaktionen + Lock-Datei
  auth/            E-Mail-Code, Sessions, vertrauenswürdige Geräte, Identität, Cloudflare Access
  domain/          Aufträge, DP-Nummern, Datenschutz-Projektionen, Warteschlange, Benutzer, Support, Bilder
  mail/            Dev-Postausgang + Mailtexte (Links nur mit Zielpfad, nie mit Tokens)
scripts/           Preview, Testdaten, Migration, Passwort-Hash
test/              node:test-Suite + e2e/ (Playwright)
```

Dieser Build steuert **keinen Drucker**. „Als aktuellen Druck markieren“ und der Fortschritt sind reine Anzeige-Daten, die der Admin pflegt.
