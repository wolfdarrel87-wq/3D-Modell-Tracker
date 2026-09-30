# Abschlussbericht – Master-Auftrag Druckplatte (Preview)

Branch: `claude/amazing-galileo-jq5avw` · Stand: 30.09.2026 (Umsetzung 29.09.2026) · **Status: Preview, nicht in Produktion deployt**

> **Aktualisiert durch die Review-Runde → [`REVIEW-BERICHT.md`](REVIEW-BERICHT.md).** Dieser Bericht beschreibt die erste Umsetzung.
> Überholt bzw. geändert sind: Cloudflare-Anmeldung ohne zweiten Code (31, 33, 34), Fail-closed-Start in Produktion,
> atomarer Store-Lock (14), strikte Origin-Prüfung, externe Bild-URLs nur per Allowlist + strengere CSP + lokale Schriften,
> gelöschte Konten → Aufträge privat (29), eigene öffentliche Modelle in „Öffentliche Modelle“ (7) und die Testzahlen (37/38).
> **Dieser Branch ist NICHT direkt produktionskompatibel und wurde NICHT deployt.**

## Vorab: Was lag vor, was wurde gebaut?

- Das GitHub-Repository enthielt nur den **Prototyp „Druckplatte 3.0“**: eine einzelne `index.html` im Claude-Artifact-Stil. Alle Daten lagen im geteilten `window.storage` und damit vollständig in **jedem** Browser. Admin-Schutz war ein im Code sichtbarer PIN. Das zweite Repo `3d-Modell-ideaPAGE` ist ebenfalls nur ein statischer Prototyp.
- **Nicht im Repo** und für diese Sitzung nicht erreichbar ist das Produktivsystem auf dem Raspberry Pi. Dazu gehören Bambu/A2L, Bambuddy, Reports, Archiv, Filament-, Preis- und Kostenlogik, Control Center, VPN-Webseite, bestehende Mail-Benachrichtigungen, die bestehende „Öffentliche Modelle“-Seite und die Cloudflare-Access-Konfiguration. Diese Teile wurden **weder geändert noch getestet**. Laut deiner privaten Notion-Doku („Zweites Gehirn“ → Druckplatte, Stand 28.09.2026) läuft dort Release v146 mit 243 bestandenen Tests. Die Notion-Seiten Druckplatte, Offene Aufgaben und Cloudflare & Domain sind auf diesen Preview-Stand aktualisiert (30.09.2026).
- Die Datenschutz- und Geräte-Anforderungen lassen sich ohne Server nicht erfüllen, weil private Daten gar nicht erst in den Browser dürfen. Deshalb wurde im Repo eine **isolierte Preview mit eigenem, abhängigkeitsfreiem Node-Server** gebaut. Die bisherige Oberfläche und alle Prototyp-Funktionen bleiben erhalten: Einreichen, Ideen, Support, Admin-Bearbeitung, Bild per URL/Datei/Drag & Drop/Strg+V, AGB, README und Filament-Guide.
- Für die Übernahme in die echte Produktion muss der Produktivcode verfügbar sein, zum Beispiel als privates GitHub-Repo ohne Secrets und Daten. Die Module `server/domain/privacy.js`, `server/domain/dpRefs.js` und `server/auth/*` samt Tests sind so geschrieben, dass sie sich übertragen lassen.

---

## 1. Welche Dateien wurden geändert?

| Datei | Art |
|---|---|
| `index.html` → `public/index.html` | verschoben; Inline-Script entfernt (→ `app.js`), Styles/Markup ergänzt (Login, Live-Bereiche, Profil/Geräte, Admin-Dialog, Benutzerverwaltung) |
| `public/app.js` | neu – Frontend-Logik (API statt `window.storage`) |
| `server/app.js`, `server/index.js`, `server/config.js`, `server/store.js` | neu – Server, Routing, Konfiguration mit Sicherheitsriegeln, transaktionaler Speicher |
| `server/auth/devices.js`, `sessions.js`, `otp.js`, `identity.js`, `pepper.js`, `cfAccess.js` | neu – Anmeldung, Sessions, vertrauenswürdige Geräte, Cloudflare-Access-Prüfung |
| `server/domain/privacy.js`, `dpRefs.js`, `orders.js`, `queue.js`, `users.js`, `support.js`, `images.js` | neu – Datenschutz-Projektionen, DP-Zähler/Migration, Fachlogik |
| `server/mail/mailer.js`, `templates.js` | neu – nur Dev-Postausgang, Mailtexte ohne Tokens |
| `server/util/*.js` | neu – HTTP, Krypto, Zeit, Rate-Limit, Log (mit Token-Schwärzung), Gerätelabel |
| `scripts/migrate-idea-dp.js`, `seed-preview.js`, `preview.js`, `hash-password.js` | neu |
| `test/*.test.js`, `test/helpers.js`, `test/e2e/run-e2e.js` | neu |
| `package.json`, `.gitignore`, `README.md`, `docs/ABSCHLUSSBERICHT.md` | neu |

## 2. Welche API-Endpunkte wurden geändert?

Vorher gab es keine API. Alle Endpunkte sind neu, jeder mit serverseitiger Rechteprüfung:

- **Öffentlich:** `GET /api/health`
- **Anmeldung:** `POST /api/auth/request-code`, `POST /api/auth/verify-code`, `POST /api/auth/logout`, `GET /api/me`
- **Geräte:** `GET /api/devices`, `POST /api/devices/:id/revoke`, `POST /api/devices/revoke-others`
- **Datenschutz-Projektionen:** `GET /api/live`, `GET /api/current-print`, `GET /api/queue`, `GET /api/orders`
- **Aufträge/Ideen:** `POST /api/orders`, `PATCH /api/orders/:id` (Eigentümer: nur Sichtbarkeit; Admin: alles außer DP/Typ), `DELETE /api/orders/:id`, `POST /api/orders/:id/accept`, `POST /api/orders/:id/reject`, `GET /api/images/:key`
- **Support:** `POST /api/support`, `GET /api/support` (Admin), `POST /api/support/:id/resolve` (Admin)
- **Admin:** `POST /api/admin/elevate`, `POST /api/admin/leave`, `POST|DELETE /api/admin/queue…`, `POST /api/admin/printer/{current,progress,finish,clear}`, `GET /api/admin/users`, `POST /api/admin/users/:id/{block,unblock,reset-devices}`, `DELETE /api/admin/users/:id`
- **Nur Preview:** `GET /dev/outbox` (Dev-Postausgang; in `test`/`production` 404)

## 3. Welche Live-Endpunkte wurden geändert?

`GET /api/live` ist der Live-Sync. Der Browser fragt ihn alle 5 s ab, solange der Tab sichtbar ist, und sofort beim Zurückkehren. Er liefert aktuellen Druck, Warteschlange, eigene Aufträge und öffentliche Modelle, jeweils bereits pro Betrachter gefiltert. Dazu kommen `GET /api/current-print` und `GET /api/queue`. WebSocket/SSE gibt es nicht. Der „Druckfortschritt“ stammt in diesem Build aus Admin-Eingaben, weil eine Druckeranbindung im Repo nicht existiert.

## 4. Wie wird Owner vs. fremder Benutzer erkannt?

Die Kette ist: authentifizierter Benutzer → Eigentümer des Auftrags → eigen/fremd → öffentlich/privat → sichere Antwort.

1. Der Server liest ausschließlich seine eigenen HttpOnly-Cookies (Session + Gerät). Er vergleicht deren HMAC-Hash mit der Datenbank und ermittelt daraus `userId`.
2. Pro Auftrag gilt: `order.ownerId === viewer.userId` → **eigen**.
3. Sonst ist der Auftrag **öffentlich** nur bei `isPublic === true` **und** angenommenem Auftrag. In allen anderen Fällen ist er **privat**.

Client-Angaben wie owner, email oder user werden nie ausgewertet. Admin-Sicht gibt es nur mit Admin-Rolle (aus `ADMIN_EMAILS`) **und** in dieser Sitzung bestätigtem Admin-Passwort.

## 5. Welche Daten erhält der Eigentümer?

Eigene Aufträge: interne ID (für eigene Aktionen), DP-Nummer, Typ (Idee/Modell), Name, Link, Farbe, Filament, Notiz, Bild, Sichtbarkeit, Status, Annahme-Status, Erstellzeit.

Beim eigenen aktuellen Druck kommen hinzu: Fortschritt, Startzeit (→ Laufzeit), Restzeit und voraussichtliche Fertigstellung.

In der Warteschlange: eigene Position(en) und „Noch X Drucke vor dir“.

## 6. Welche Daten werden bei fremden privaten Aufträgen entfernt?

Entfernt wird alles: Modellname, Beschreibung/Notiz, Bild, Links, Dateiname, Besitzer/E-Mail, DP-Nummer, interne IDs, Material, Farbe, Status, Zeiten. Preise und Kosten existieren in diesem Build nicht.

Übrig bleiben nur:
- Warteschlange: `{"kind":"private_queue_slot","position":2}`
- Aktueller Druck: `{"kind":"foreign_private","state":"printing","progressBucket":40,"remainingApproxMinutes":105}`. Der Fortschritt ist auf 10-%-Schritte abgerundet, die Restzeit auf 15 Minuten aufgerundet.

## 7. Welche Daten dürfen bei fremden öffentlichen Modellen sichtbar sein?

Die Public-Allowlist in `PUBLIC_MODEL_FIELDS` umfasst exakt `name`, `color`, `filament`, `link`, `imageUrl` (plus `kind`).

**Nicht** enthalten sind: DP-Nummer, IDs, Besitzer, E-Mail, Notiz, Status und Zeiten. Das Bild wird über einen zufälligen Schlüssel geladen, der nicht aus der Auftrags-ID ableitbar ist.

*Review-Runde:* `link` wird öffentlich nur als MakerWorld-Link ausgegeben, externe Bild-URLs nur von freigegebenen Hosts. Eigene öffentliche Modelle erscheinen jetzt ebenfalls in „Öffentliche Modelle“, und zwar in derselben Allowlist-Form.

## 8. Wie wird die Druckwarteschlange anonymisiert?

Jede Position wird einzeln projiziert: eigen → volle eigene Daten, fremd-öffentlich → Allowlist, fremd-privat → `private_queue_slot`. Die Anzahl und die eigene Position bleiben sichtbar. Hat jemand keinen eigenen Auftrag, sieht er „Aktuell befinden sich 4 Drucke in der Warteschlange.“ Mindestens drei aufeinanderfolgende private Plätze fasst die Oberfläche zusammen, etwa „Plätze 1–3 · 3 private Drucke“.

## 9. Wie wird Current Print anonymisiert?

Wie unter 6 beschrieben. Die Anzeige lautet „Aktuell wird ein anderer Druck bearbeitet.“ mit ungefährem Fortschritt und ungefährer Restzeit. Ist das Modell öffentlich, kommen nur die Allowlist-Felder hinzu. Eigentümer und Admin sehen alles.

## 10. Wie wird verhindert, dass private Daten überhaupt im Browser landen?

- Die Antworten werden **positiv** aus erlaubten Feldern zusammengebaut. Es wird nichts weggelöscht, und kein vollständiges Objekt geht raus.
- Der Bildabruf `GET /api/images/:key` prüft dieselben Regeln serverseitig und antwortet mit `Cache-Control: private, no-store`.
- API-Antworten tragen `no-store` und `Vary: Cookie`.
- Der Browser **ersetzt** seinen Zustand bei jedem Live-Update vollständig und rendert neu, ohne zu mischen. Bei Abmeldung oder einer 401-Antwort werden JS-Zustand und DOM geleert.
- Tests prüfen `JSON.stringify(response)` auf Namen, Links, Notizen, DP-Nummern, IDs, E-Mails, Bildschlüssel, Farben und Materialien. Der Browser-Test prüft zusätzlich DOM und mitgeschnittene Netzwerkantworten.

## 11. Wie bekommen Ideen ihre DP-Auftragsnummer?

`createOrder()` vergibt die Nummer **in derselben Store-Transaktion**, die den Auftrag speichert, für Modelle und Ideen gleich. Format: `DP-JJJJ-NNNNNN`, das Jahr in deutscher Zeit. „Idee“ bleibt nur Typ bzw. Badge. Einen Präfix `IDEA-`/`IDEE-` gibt es nicht. Der Browser erzeugt nie eine Nummer.

## 12. Wie viele bestehende Ideen ohne DP wurden gefunden?

- **Preview-Daten:** 2. Das sind die bewusst angelegten Alt-Ideen „Schlüsselbrett Flur“ und „Deko-Mond Lampe“.
- **Produktionsdaten:** **nicht geprüft**, weil sie für diese Sitzung nicht erreichbar sind.
- **Prototyp-Daten (`window.storage` in claude.ai):** nicht zugänglich. Dort hatte kein einziger Eintrag eine DP-Nummer, auch keine normalen Aufträge.

## 13. Ergebnis des Migration-Dry-Runs (Preview)

```
=== DRY RUN (keine Änderungen) ===
Ideen insgesamt: 4
Mit DP: 2
Ohne DP: 2
Höchste DP-Nummer pro Jahr: 2026 → DP-2026-000010
Zählerstand: 2026 → 10

Datensatz ord_preview_legacyBen „Schlüsselbrett Flur“
  Erstellt: 15.9.2026, 08:14:15
  würde erhalten: DP-2026-000011

Datensatz ord_preview_legacyDora „Deko-Mond Lampe“
  Erstellt: 16.9.2026, 01:14:15
  würde erhalten: DP-2026-000012
```

Danach wurde die Migration **nur auf den Preview-Daten** angewendet, mit Backup. Die Ergebnisse sind identisch, ein erneuter Lauf meldet „nichts zu tun“.

## 14. Wie verhindert der DP-Counter Race Conditions?

- Transaktionen sind synchron und laufen per Copy-on-Write: Der Node-Prozess führt sie strikt nacheinander aus. Vergabe und Speichern bilden eine Einheit.
- Schlägt das Speichern fehl, wird alles zurückgerollt. Es entsteht keine Lücke und keine verbrauchte Nummer.
- Eine Lock-Datei verhindert einen zweiten Prozess auf denselben Daten. *Review-Runde:* Die Übernahme eines verwaisten Locks ist jetzt atomar (Wiederherstellungs-Lock per `O_EXCL` + erneute Prüfung). Zuvor konnten mehrere Prozesse gleichzeitig „gewinnen“; im Test mit altem Code waren es 4 von 6.
- Die nächste Nummer ist `max(Zählerstand, höchste vergebene Nummer) + 1`, zusätzlich mit Eindeutigkeitsprüfung.
- Getestet mit 40 gleichzeitigen Einreichungen (Ideen und Aufträge gemischt): 40 eindeutige, lückenlose Nummern.

## 15. Warum bleiben bestehende DP-Referenzen unverändert?

Die Migration fasst nur Ideen mit **leerem** `dpRef` an. Ungültige Werte werden gemeldet, aber nicht verändert. Über die API ist `dpRef` nicht änderbar, weil es kein Eingabefeld dafür gibt. Beim Annehmen einer Idee bleibt die Nummer gleich. Das ist mit Tests belegt: Q, S und „DP-Nummer bleibt bei Annahme gleich“.

## 16. Wie wurde das Trusted-Device-System umgesetzt?

1. Nach korrektem E-Mail-Code erzeugt der Server einen Token mit 256 Bit Zufall (`crypto.randomBytes(32)`).
2. Der Token geht nur als Cookie an den Browser.
3. Gespeichert wird ein Gerätedatensatz mit `id`, `userId`, `tokenHash` (HMAC-SHA256), `createdAt`, `expiresAt` = `createdAt` + 30 × 24 h, `lastUsedAt`, `revokedAt` und `deviceLabel` (grob, z. B. „Chrome · Windows“).

Die normale Sitzung ist davon getrennt: ein eigenes Session-Cookie mit 12 h Laufzeit, gebunden an das Gerät und nie länger gültig als dieses. Läuft die Sitzung ab, erzeugt ein gültiges Gerät **ohne Code** eine neue.

## 17. Wie wird ein registriertes Gerät bei einem Druckplatte-Mail-Link erkannt?

Der Link enthält nur einen Pfad, etwa `/auftrag/DP-2026-000007` oder `/support`. Der Browser schickt beim Öffnen sein vorhandenes `__Host-dp_device`-Cookie mit. `SameSite=Lax` erlaubt das bei Klicks aus Mail-Programmen. Die Seite ruft `/api/me` auf, und der Server prüft das Gerät. Ist es gültig, entsteht bei Bedarf still eine neue Sitzung. Danach öffnet sich die Zielansicht: Die Karte wird hervorgehoben oder der Support-Dialog geöffnet. Getestet ist das mit echter Cross-Site-Navigation im Browser.

## 18. Wie wird verhindert, dass jede Mail ein neues Gerät erzeugt?

`registerDevice()` wird **ausschließlich** nach einer erfolgreichen Anmeldung aufgerufen: `POST /api/auth/verify-code` nach korrektem Code, oder (Review-Runde, Cloudflare-Modus) `POST /api/auth/access-session` nach einer frischen Access-Anmeldung. Die Identitätsprüfung legt nie Geräte an, sie liest nur und legt höchstens eine neue Sitzung an. Die Tests AC–AE sowie E5 und E6 im Browser prüfen: Nach Status-, Fertigstellungs-, Ideen- und Support-Mail bleiben Geräteanzahl und Geräte-ID gleich, und es wird kein Code verschickt.

## 19. Wo wird der Trusted-Device-Token gespeichert?

Nur im Cookie `__Host-dp_device`, und dort HttpOnly. Er landet weder in localStorage, sessionStorage, URL, HTML, DOM, JS-Zustand noch in Mails oder Logs. Das ist per Test geprüft, im Browser zusätzlich über `document.cookie` und den Storage.

## 20. Wird serverseitig ausschließlich ein Hash gespeichert?

Ja. Gespeichert wird HMAC-SHA256 mit einem Server-Schlüssel (`auth-pepper.key` bzw. `AUTH_PEPPER`). Das gilt genauso für Session-Tokens und E-Mail-Codes. Ein Test durchsucht die Datendatei nach dem Klartext-Token.

## 21. Welche Cookie-Flags werden verwendet?

- **Gerät:** `__Host-dp_device=<token>; Max-Age=<Restsekunden, ≤ 2592000>; Expires=<expiresAt>; Path=/; HttpOnly; Secure; SameSite=Lax`
- **Sitzung:** `__Host-dp_session=<token>; Path=/; HttpOnly; Secure; SameSite=Lax` (Browser-Sitzung)

`SameSite=Lax` statt `Strict` ist nötig, damit Klicks aus Mail-Programmen das Cookie mitsenden. Das `__Host-`-Präfix erzwingt Secure, `Path=/` und verbietet eine Domain.

## 22. Wie überlebt der Cookie Browser- und Geräte-Neustarts?

Durch `Max-Age`/`Expires` ist er persistent und wird auf dem Datenträger gespeichert. Der Browser-Test startet Chromium komplett neu und übernimmt nur die persistenten Cookies: Es erscheint kein Code und kein neues Gerät. Zusätzlich ist ein Server-Neustart getestet.

## 23. Wie ist garantiert, dass nach exakt 30 Tagen wieder ein Code nötig ist?

`expiresAt` wird einmalig auf `createdAt + 2 592 000 000 ms` gesetzt, und bei jeder Anfrage gilt: `jetzt ≥ expiresAt` → abgelehnt. Der Cookie läuft im selben Moment ab, und eine Sitzung lebt nie länger als ihr Gerät.

Getestet: 29 Tage gültig, 30 Tage minus 1 ms gültig, ab 30 Tagen abgelehnt. Die Ablehnung greift auch serverseitig, wenn ein Client den Cookie trotzdem mitschickt (+0 ms, +1 ms, +500 ms, +60 s).

> Hinweis: „30 Tage“ bedeutet genau 30 × 24 Stunden. In deinem Beispiel (27.09.2026, 14:00) liegt die Zeitumstellung am 25.10.2026 dazwischen. Die Uhr zeigt beim Ablauf deshalb **27.10.2026, 13:00** statt 14:00, die Dauer beträgt trotzdem exakt 30 Tage. Soll stattdessen „gleiche Uhrzeit am Kalendertag“ gelten, wären es in diesem Fall 30 Tage und 1 Stunde. Das widerspricht aber der Vorgabe „maximal 30 Tage“.

## 24. Wie wird verhindert, dass tägliche Nutzung die 30 Tage verlängert?

Bei Nutzung ändert sich nur `lastUsedAt` (höchstens einmal pro Stunde geschrieben). `expiresAt` wird nie neu berechnet, und der Geräte-Cookie wird nie neu gesetzt. Der Test AH nutzt das Gerät 29 Tage lang täglich: `expiresAt` bleibt unverändert.

## 25. Wie funktionieren mehrere Geräte?

Jede Code-Anmeldung in einem Browser ohne gültiges Gerät legt einen eigenen Datensatz an: eigener Token, eigenes `createdAt`, `expiresAt`, `lastUsedAt` und `revokedAt`. Pro Browser-Profil gibt es genau ein Geräte-Cookie. Eine erneute Code-Anmeldung im selben Browser **ersetzt** dessen bisheriges Gerät, indem sie den alten Token widerruft (Token-Rotation).

## 26. Wie kann ein Benutzer einzelne Geräte widerrufen?

Im Profil unter „Vertrauenswürdige Geräte“ mit dem Button **Gerät abmelden** (`POST /api/devices/:id/revoke`). Der Server setzt `revokedAt` und löscht die Sitzungen dieses Geräts. Der nächste Zugriff von dort verlangt einen Code. Das eigene aktuelle Gerät lässt sich ebenfalls abmelden, danach folgt der Logout.

## 27. „Alle anderen Geräte abmelden“

Umgesetzt über `POST /api/devices/revoke-others`: Alle Geräte außer dem aktuellen werden widerrufen. Separat gibt es **Abmelden (dieses Gerät vergessen)**, das nur das aktuelle Gerät widerruft.

## 28. Verhalten bei gesperrten Benutzern

Sperrt der Admin einen Benutzer, passiert Folgendes:
- Der Status wird `blocked`.
- **Alle** Geräte werden widerrufen und alle Sitzungen gelöscht.
- Jede Wiederherstellung prüft zusätzlich Existenz, Status, Widerruf und Ablauf.
- Eine korrekte Code-Anmeldung wird mit „Konto gesperrt“ abgewiesen, ohne ein Gerät anzulegen.

Test AS prüft das auch für den Fall eines nur im Datenbestand gesperrten Kontos.

## 29. Verhalten bei gelöschten Benutzern

Konto, Geräte, Sitzungen und offene Codes werden sofort gelöscht. Ein alter Cookie ist damit wertlos und ergibt 401 (Test AT). Die Aufträge bleiben für den Admin erhalten, jetzt ohne Besitzer. *Review-Runde:* Sie werden zusätzlich auf `isPublic=false` gesetzt (DELETE1–5).

## 30. Verhalten für Admins

Die Admin-Rolle kommt nur aus `ADMIN_EMAILS`. Admin-Rechte erfordern **zusätzlich** das Admin-Passwort, serverseitig per scrypt geprüft und pro Sitzung gültig. Eine per Gerät wiederhergestellte Sitzung hat **keine** Admin-Rechte, das Passwort ist erneut nötig. Normale Benutzer können sich nicht hochstufen (Test AU). Der alte, im öffentlichen Repo sichtbare Client-PIN `2026` ist entfernt.

## 31. Zusammenspiel mit Cloudflare Access

*Review-Runde:* In Produktion ist die Prüfung jetzt **Pflicht** (fail-closed). Mit Access gibt es **keinen zweiten Druckplatte-Code** mehr (`AUTH_MODE=cloudflare-access`). Details stehen im REVIEW-BERICHT. Ursprünglicher Stand: Optional ließ sich über `CF_ACCESS_TEAM_DOMAIN` und `CF_ACCESS_AUD` eine Prüfung aktivieren. Dann braucht jede API-Anfrage ein gültiges Cloudflare-Access-JWT: Signatur (RS256 über die Team-JWKS), `aud`, `iss`, `exp` und `nbf` werden geprüft. Session und Gerät werden nur akzeptiert, wenn die Access-E-Mail zum Druckplatte-Konto passt. Ein Druckplatte-Cookie ersetzt Cloudflare Access also **nie** und umgeht es auch nicht. Getestet ist das mit selbst signierten Test-JWTs.

## 32. Welche aktuelle Cloudflare-Access-Session-Dauer wurde festgestellt?

**Keine, nicht feststellbar.** Es gibt keinen Zugriff auf das Cloudflare-Dashboard, die Konfiguration liegt nicht im Repo, und auch die Notion-Doku (Seite „Cloudflare & Domain“, Stand 18.09.2026) nennt keinen Wert. Dort ist nur vermerkt, dass Cloudflare Access die Anwendung schützt und ein eigenes Login-Gateway auf Cloudflare Pages existiert. Laut Cloudflare-Doku gilt ohne gesetzte Policy- oder App-Sitzungsdauer ein Standard von **24 Stunden** für das `CF_Authorization`-Cookie.

## 33. Muss sie für die 30-Tage-Funktion geändert werden?

**Wahrscheinlich ja**, falls Cloudflare Access vor Druckplatte selbst einen E-Mail-Code verlangt. Dann fragt Cloudflare nach Ablauf seiner Sitzung (Standard 24 h) erneut nach einem Code, **bevor** Druckplatte erreicht wird. Kein Druckplatte-Cookie kann das verhindern.

## 34. Erforderliche Änderung (nicht durchgeführt, nur dokumentiert)

In Cloudflare Zero Trust:

1. **Access → Applications → Druckplatte → Session Duration:** „1 month“, das laut Doku zulässige Maximum.
2. **Policies der App:** keine kürzere eigene Policy-Sitzungsdauer, denn eine Policy-Dauer hat Vorrang vor der App-Dauer.
3. **Settings → Authentication → Global session timeout:** mindestens 1 Monat. Die globale Sitzung bestimmt, wie oft man sich beim Identity Provider (hier: One-time PIN) neu anmelden muss.
4. **Cookie-Einstellungen der App:** SameSite **nicht** auf „Strict“ stellen (Lax), sonst fehlt das Access-Cookie bei Klicks aus Mail-Programmen.

**Sicherheitsauswirkung:** Ein gestohlenes Access-Cookie wäre bis zu einem Monat gültig. Gegenmaßnahmen:
- Sitzungen bei Verdacht in Zero Trust widerrufen.
- „Binding Cookie“ aktivieren.
- Admin, Control Center und VPN als **eigene** Access-Apps mit kürzerer Dauer betreiben.
- Den Druckplatte-eigenen Geräte-Widerruf zusätzlich nutzen.

**Wichtig für die Produktions-Integration (in der Review-Runde umgesetzt, siehe REVIEW-BERICHT):** Kommt der „bestehende E-Mail-Code“ in Produktion von Cloudflare, sollte Druckplatte **keinen zweiten** Code verlangen. Sonst gibt es am ersten Tag zwei Codes, und die zwei 30-Tage-Uhren laufen versetzt. Dann sollte Druckplatte das Gerät bei der ersten frisch per Access authentifizierten Anfrage registrieren, die bestehende Handoff-Logik. Die 30-Tage-Grenze würde beim Ablauf per Access-Logout einen neuen Access-Code erzwingen. Das lässt sich erst mit dem Produktivcode sauber umsetzen.

Quellen: [Cloudflare One – Session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/), [Cloudflare One – Authorization cookie](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/). Die Doku-Seiten selbst waren aus der Sandbox gesperrt. Die Angaben stammen aus der Websuche über diese Seiten und sollten vor der Umstellung im Dashboard gegengeprüft werden.

## 35. Wurde ein unsicherer Cloudflare-Bypass eingebaut?

**NEIN.**

## 36. Welche neuen Tests wurden ergänzt?

Vorher gab es im Repo keine Tests. Es wurden also keine bestehenden Tests gelöscht oder abgeschwächt.

- `test/trusted-device.test.js`: W–AV, Cookie-Flags, E-Mail-Links A–G, 30-Tage-Grenze serverseitig, Token-Rotation, E-Mail-Code (Hash, 10 min, 5 Versuche, einmalig), keine Adress-Aufzählung, CSRF/Origin, Bereinigung
- `test/privacy.test.js`: A–I, API-Leak-Tests (Punkt 57), Bildzugriff, Rechte, Admin ohne Passwort, unangemeldet
- `test/dp.test.js`: J–V, Jahreswechsel, 40 parallele Einreichungen, Speicherfehler-Rollback, Migration (Dry-Run/Apply/idempotent), Migrationsskript mit Lock und Produktionssperre
- `test/store.test.js`: Transaktionen, Rollback, Lock, Dateirechte
- `test/api.test.js`: Konfigurationsriegel, CSP/statische Seiten, Validierung, Ideen-Workflow, Warteschlange/Admin, Support, Benutzerverwaltung, Cloudflare Access
- `test/e2e/run-e2e.js` (Chromium): Login, Browser-Neustart, Server-Neustart, Cross-Site-Mail-Links, neues Gerät, DOM- und Netzwerk-Datenschutz, Live-Sync öffentlich → privat, Admin, Profil/Geräte, Responsive 360/390/430/768/1280/1920, keine JS-Fehler, keine Tokens in Logs

Zusätzlich wurde per **Mutationstest** geprüft, dass die Tests echte Fehler finden. 13 absichtlich eingebaute Fehler, etwa Sliding Expiration, DP-Nummer in der Allowlist oder Code-Bypass, wurden alle erkannt.

## 37./38. Testergebnis

*Stand der ersten Umsetzung. Aktuelle Zahlen nach der Review-Runde: `npm test` 91/91, `npm run test:e2e` 19/19 (siehe REVIEW-BERICHT).*

| Suite | bestanden | fehlgeschlagen |
|---|---|---|
| `npm test` (Server/Integration) | 64 | 0 |
| `npm run test:e2e` (Chromium) | 13 | 0 |
| **Gesamt** | **77** | **0** |

## 39.–42. Bestätigungen

- **Produktion wurde nicht verändert.** Es gab keinen Zugriff auf den Raspberry Pi oder Cloudflare. Gepusht wurde nur auf den Feature-Branch, nicht auf `main`.
- **Keine Produktionsmigration durchgeführt.** Die Migration lief nur auf Preview-Testdaten.
- **Keine echte E-Mail versendet.** Es gibt nur den Dev-Postausgang, und mit `MAIL_PRODUCTION_ENABLED=true` startet der Server nicht.
- **Kein echter Druckerstart.** Dieser Build enthält keine Druckeranbindung.

## 43. Preview für die visuelle Prüfung

- Screenshots aller Ansichten und Breiten: <https://claude.ai/artifact/DyVZWiTv1rpa7jMZid2Asu> (privat, nur für dich sichtbar).
- Selbst starten: `npm run preview`, dann <http://localhost:8080> und <http://localhost:8080/dev/outbox>. Auf dem Pi per SSH-Tunnel, siehe README.

## Nächste Schritte (nach deiner Freigabe)

1. Produktivcode bereitstellen, zum Beispiel als privates GitHub-Repo ohne `.env`, Schlüssel und Daten.
2. Datenschutz-Projektionen, DP-Zähler und Geräte-Logik in den Produktivcode übertragen. Dabei die bestehende Public-Allowlist und die Counter-Logik dort wiederverwenden.
3. Cloudflare-Einstellungen aus Punkt 34 prüfen und entscheiden, wer den E-Mail-Code verschickt (Cloudflare oder Druckplatte).
4. Kontrollierter Deploy nach deinem Ablauf: Read-only-Precheck → Backups → Verifikation → Release → Tests → Restart → Checks → Rollback bei Fehler.
