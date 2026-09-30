# Review-Bericht – Druckplatte-Branch (Review + Fixes)

Branch: `claude/amazing-galileo-jq5avw` · Stand: 30.09.2026 · Grundlage: Master-Auftrag „CLAUDE BRANCH REVIEW + FIXES“

> **Dieser Branch ist NICHT direkt produktionskompatibel und wurde NICHT deployt.**
>
> Er ist eine geprüfte **Vorlage**. Eine spätere Übernahme in die echte Druckplatte (v146) ist ein **separater Auftrag**. Dabei werden nur einzelne Module übernommen (siehe „Spätere Produktionsintegration“). Das Support-Modul `server/domain/support.js` gehört **nicht** dazu.

Vorgehen wie beauftragt: Read-only-Prüfung → Liste → Implementierung → Tests → Bericht → **STOPP**.

---

## Teil A – Ergebnis der Read-only-Prüfung (vor den Fixes)

### A1. Bereits korrekt (Punkt 44: „Dieser Punkt war bereits behoben“)

| Anforderung | Datei / Logik | Test |
|---|---|---|
| DP-Nummern für Ideen und Aufträge aus **einem** Zähler, in derselben Transaktion | `server/domain/dpRefs.js`, `server/domain/orders.js` (`createOrder`) | `dp.test.js` J/K/L/M, N/O, P |
| Bestehende DP-Nummern bleiben, Migration mit Dry-Run, idempotent | `scripts/migrate-idea-dp.js`, `dpRefs.applyIdeaMigration` | `dp.test.js` Q/R/S, „Migrationsskript …“ |
| Trusted Device: 256-Bit-Token, nur HMAC-Hash gespeichert, `expiresAt` absolut +30 Tage | `server/auth/devices.js` | `trusted-device.test.js` X, AF/AG/E, AH |
| Keine Sliding Expiration | `devices.js` (nur `lastUsedAt` wird geschrieben) | AH |
| Mail-Links erzeugen kein neues Gerät | `server/auth/identity.js` (liest nur) | AC/AD/AE, E-Mail-Links A–G, E2E E5/E6 |
| Sperre/Löschung wird bei jeder Wiederherstellung geprüft | `identity.js`, `devices.checkDeviceToken` | AS, AT |
| Admin nur mit Admin-Passwort pro Sitzung | `server/app.js` `/api/admin/elevate`, `identity.js` | AU, „Admin ohne Admin-Passwort …“ |
| Datenschutz-Projektionen Current Print / Queue / Allowlist | `server/domain/privacy.js` | `privacy.test.js` A–I, 57 (Leak-Test) |

Diese Punkte wurden **nicht** umgebaut. Sie laufen nur mit, wo neue Fixes sie berühren.

### A2. Musste geändert werden (Beobachtungen des Auftrags bestätigt)

| Punkt | Befund im alten Code |
|---|---|
| 4 – Doppelter Code | Mit Cloudflare Access verlangte Druckplatte zusätzlich den eigenen E-Mail-Code (`request-code`/`verify-code` waren der einzige Weg zum Gerät). |
| 5 – Fail-closed | `config.js` startete in Produktion ohne `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD`. Auch eine halbe Konfiguration wurde still ignoriert. |
| 6 – Store-Lock | Ein verwaister Lock wurde per `writeFileSync` einfach überschrieben (nicht atomar). Mehrere Prozesse konnten gleichzeitig „gewinnen“. |
| 7 – Externe Bilder | Jede `http(s)`-URL wurde akzeptiert, auch `127.0.0.1`, `192.168.x`, `169.254.169.254`. Die CSP hatte `img-src https:`. |
| 8 – Kontolöschung | Aufträge behielten `isPublic=true` und blieben so öffentlich sichtbar. |
| 9 – Eigene öffentliche Modelle | `publicModelsOf` schloss eigene Aufträge aus, sodass die Liste bei eigenen Modellen leer blieb. |
| 10 – Origin | Ohne `Origin`-Header wurde die Anfrage durchgelassen. Erlaubte Origins wurden aus dem `Host`-Header abgeleitet. |
| 11/34 – Support | `support.js` löscht Einträge beim Erledigen. Das ist ein Prototyp ohne REP/SUP, Verlauf und Archiv. |
| 24 – CSP/Assets | Google Fonts wurden extern geladen. |

### A3. Weitere Probleme (siehe „Zusätzlich gefundene Probleme“ unten)

---

## Teil B – BEREITS GEFIXT

### B1. Die Punkte aus dem Auftrag

| Punkt | Was jetzt gilt | Wichtigste Dateien | Tests |
|---|---|---|---|
| **4 – kein doppelter Code** | `AUTH_MODE=cloudflare-access` (Standard, sobald Access konfiguriert ist): Druckplatte verschickt **keinen** Code. `POST /api/auth/access-session` registriert das Gerät auf Basis der geprüften Access-Identität. `request-code`/`verify-code` antworten dann mit 404. Beide Anmeldewege nutzen dieselbe Funktion `registerLogin()` (Identity-Layer). | `server/app.js:156` `registerLogin`, `:192` `access-session`; `server/config.js` (`AUTH_MODES`); `server/auth/cfAccess.js` (liefert `iat`); `public/app.js` `accessLogin()` | 4 × „Cloudflare-Modus: …“, CF4, E2E CF-E1–CF-E4 |
| **5 – fail-closed** | `DRUCKPLATTE_ENV=production` bricht ab, wenn Access fehlt (außer `ALLOW_WITHOUT_CF_ACCESS=true`) oder nur halb konfiguriert ist. Ebenso bei `AUTH_MODE=email-code` zusammen mit Access (zwei Codes) und bei `http://`-Origins. | `server/config.js:100–133` | CF1, CF2, „CF1/CF2 real“ (echter Start von `server/index.js`), CF3, CF4, „ORIGIN: in Produktion nur https“ |
| **6 – Store-Lock** | Das Anlegen läuft atomar per `O_EXCL` (`wx`). Ein verwaister Lock wird nur übernommen, wenn der **Wiederherstellungs-Lock** (`store.lock.recover`, ebenfalls `wx`) gewonnen ist. Danach wird der Lock erneut gelesen (bei Änderung Abbruch), gelöscht und per `wx` neu angelegt. `close()` entfernt nur den eigenen Lock (Token `pid:zufall`). | `server/store.js:141` `_tryCreate`, `:172` `_acquireLock`, `:194` `_recoverStaleLock`, `:92` `close` | LOCK1, LOCK2, LOCK3, LOCK4a (deterministisch verschachtelt), LOCK4a (laufende Wiederherstellung), **LOCK4b (6 echte Prozesse × 5 Runden)** |
| **7 – externe Bilder** | Standard: **nur Uploads**. Mit `IMAGE_HOST_ALLOWLIST` sind nur `https` und nur exakt die freigegebenen Hosts erlaubt, ohne Port und ohne Zugangsdaten. **Immer** gesperrt sind IP-Literale, localhost, private/Link-Local/CGNAT/Multicast-Netze (IPv4 + IPv6 inkl. `::ffff:`) und interne Namen (`.local`, `.lan`, `.internal`, `.home.arpa` …). Altdaten werden beim **Ausliefern** erneut geprüft. | `server/domain/images.js:35/58/72`; `server/domain/privacy.js:41` `imageUrlFor`; `server/config.js` (Allowlist-Validierung) | IMAGE1–7, „IMAGE: Allowlist …“, „IMAGE: Altdaten …“ |
| **8 – Kontolöschung** | Aufträge bleiben für den Admin (inkl. DP-Nummer), werden aber `isPublic=false`. Geräte, Sitzungen und Codes werden gelöscht. | `server/domain/users.js:72` `deleteUser` | DELETE1–5 |
| **9 – eigene öffentliche Modelle** | Alle ausdrücklich öffentlichen Aufträge (auch eigene) stehen in „Öffentliche Modelle“, **nur** in der Allowlist-Form. Private bleiben privat. | `server/domain/privacy.js:199` `publicModelsOf` | PUBLIC1–3, E2E E8 |
| **10 – Origin** | Jede ändernde Anfrage braucht `Origin`. Fehlt er → 403 `origin_required`, ist er unbekannt → 403 `bad_origin`. Erlaubt sind nur `PUBLIC_BASE_URL` + `ALLOWED_ORIGINS`. **Nie** wird der `Host`-Header verwendet. GET bleibt ohne Origin möglich. | `server/app.js:86` `checkOrigin`; `server/config.js` `allowedOrigins` | ORIGIN1–5 (inkl. gefälschtem `Host` per Raw-Request), CSRF-Test in `trusted-device.test.js` |
| **11/34 – Support** | Nicht umgebaut, aber als Prototyp gekennzeichnet (Dateikopf). Hier und in der README steht: **nicht portieren**. | `server/domain/support.js:3–5`, `README.md` | – |
| **12–23 – beibehalten** | DP-Nummern, Trusted Device, Datenschutz-Projektionen und Legacy-Privat sind unverändert. Im Cloudflare-Modus gelten dieselben Garantien. | – | alle bestehenden Tests unverändert grün |
| **24 – CSP/lokale Assets** | Die CSP enthält `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: [+ Allowlist-Hosts]; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`. Die Schriften liegen lokal in `public/fonts/` (OFL-Lizenzen beiliegend). Es gibt keine Anfragen an fremde Hosts. | `server/util/http.js:26` `buildHtmlCsp`; `public/index.html` (`@font-face`); `server/app.js:551` Font-Route | „CSP: keine externen …“, E2E „… keine externen Anfragen“ |

### B2. Zusätzlich gefundene Probleme (Punkt 44)

Alle wurden im Branch behoben, jeweils mit Test.

| # | Problem | Fix | Test |
|---|---|---|---|
| Z1 | Kaputte %-Kodierung im Pfad (z. B. `/api/images/%E0%A4%A`) führte zu HTTP 500. | `matchRoute` antwortet mit 400 `bad_request` (`server/app.js:504`). | „Zusatz: kaputte URL-Kodierung …“ |
| Z2 | Der Dev-Postausgang mit Anmeldecodes war in der Preview aus dem Netz erreichbar. | Er antwortet nur noch auf direkte Loopback-Anfragen **ohne** Proxy-/Tunnel-Header (`X-Forwarded-For`, `CF-Connecting-IP`, `Forwarded`, `X-Real-IP` …), siehe `server/app.js:39` `isDirectLocalRequest`. | „Zusatz: Dev-Postausgang …“ (echte LAN-Adresse + Proxy-Header) |
| Z3 | Die öffentliche Ansicht gab bei Ideen beliebige Links aus (fremde Websites, Tracking). | Öffentlich erscheinen nur MakerWorld-Links (`privacy.js:54` `publicLink`). | „Zusatz: öffentliche Ansicht zeigt nur MakerWorld-Links“ |
| Z4 | Google Fonts wurden extern geladen, was jeden Besuch an Google meldet. | Die Schriften liegen jetzt lokal. | CSP-Test, E2E „keine externen Anfragen“ |
| Z5 | **Cloudflare-Modus:** Nach „Abmelden“ hätte das noch frische Access-Token (bis 10 Min.) sofort still ein neues Gerät angelegt. Das Abmelden wäre damit wirkungslos gewesen. | Abmelden und Sicherheitsreset setzen `accessReauthAfter`. Danach zählt nur eine Access-Anmeldung, die **später** stattfand (sekundengenau, im Zweifel abgelehnt). Das Frontend registriert nach dem Abmelden nicht automatisch neu und zeigt „Neu anmelden“. | „Cloudflare-Modus: nach Abmelden/Sicherheitsreset …“, E2E CF-E4 |
| Z6 | **Cloudflare-Modus:** Ein Skript ohne Cookies konnte mit einem gültigen Access-Token beliebig viele Geräte anlegen. | Das Rate-Limit liegt bei 10 neuen Geräten pro Identität in 15 Minuten. Wiederherstellungen zählen nicht. | im selben Test (8 Versuche → der 8. ergibt 429) |
| Z7 | `ALLOWED_ORIGINS` akzeptierte in Produktion `http://`. | In Produktion ist nur `https://` erlaubt, ungültige Werte (z. B. `*`) brechen den Start ab. | „ORIGIN: in Produktion nur https-Origins …“ |
| Z8 | `IMAGE_HOST_ALLOWLIST` akzeptierte interne Namen wie `nas.local`. Diese wären bei jeder URL-Prüfung ohnehin abgelehnt worden, was verwirrend ist. | Der Start bricht mit einer klaren Meldung ab (gleiche Regeln wie bei der URL-Prüfung). | „IMAGE: Allowlist …“ |
| Z9 | Kosmetik: Als Button gestaltete Links waren unterstrichen. | `.btn { text-decoration:none }` | Screenshots |

---

## Teil C – TESTS

### C1. Ergebnis (tatsächlich ausgeführt am 30.09.2026, Node 22, Chromium über Playwright)

```
npm test               # tests 91 · pass 91 · fail 0 · skipped 0 · cancelled 0 · todo 0
npm run test:e2e       # tests 19 · pass 19 · fail 0 · skipped 0 · cancelled 0 · todo 0
```

| Datei | total | pass | fail | skip |
|---|---|---|---|---|
| `test/api.test.js` | 10 | 10 | 0 | 0 |
| `test/dp.test.js` | 9 | 9 | 0 | 0 |
| `test/privacy.test.js` (1 Test + 15 Subtests) | 16 | 16 | 0 | 0 |
| `test/review-fixes.test.js` **(neu)** | 27 | 27 | 0 | 0 |
| `test/store.test.js` | 5 | 5 | 0 | 0 |
| `test/trusted-device.test.js` | 24 | 24 | 0 | 0 |
| **`npm test` gesamt** | **91** | **91** | **0** | **0** |
| `test/e2e/run-e2e.js` (2 Browser-Szenarien + 17 Schritte) | 19 | 19 | 0 | 0 |
| **Alles zusammen** | **110** | **110** | **0** | **0** |

Nicht ausgeführt: Tests gegen den echten Produktivcode (v146), das echte Cloudflare, echte Mails oder echte Drucker. Nichts davon ist in dieser Umgebung vorhanden, und nichts davon durfte angefasst werden.

### C2. Nachweis, dass die neuen Tests echte Fehler finden

Die Mutationstests liefen in einer Kopie im Scratchpad, nicht im Repo:

- **LOCK4b gegen den alten `store.js`**: schlägt fehl. In Runde 0 hielten **4 von 6** Prozessen gleichzeitig den Lock (`expected: 1, actual: 4`). Mit dem neuen Code hält in jeder Runde genau einer den Lock.
- **Z5 ohne `accessReauthAfter`-Prüfung**: Der Test schlägt fehl, weil erwartet 401 kommt, tatsächlich aber 200 und damit ein neues Gerät.

### C3. Neue Tests

- **`test/review-fixes.test.js` (neu, 27 Tests):**
  - CF1, CF2, CF1/CF2 real, CF3, CF4
  - ORIGIN (Produktion nur https)
  - 4 Cloudflare-Modus-Flows: kein zweiter Code; Frische + 30 Tage; Sperre, fremde Identität und Admin-Grenze; Abmelden/Reset + Rate-Limit
  - LOCK1, LOCK2, LOCK3, LOCK4a (×2), LOCK4b
  - DELETE1–5, PUBLIC1–3, ORIGIN1–5, IMAGE1–7
  - IMAGE-Allowlist, IMAGE-Altdaten, CSP/Schriften
  - 4 Zusatztests (Z1, Z2, Z3, Regression Gerätebezeichnung)
- **`test/e2e/run-e2e.js` (ergänzt):**
  - neues Szenario „Cloudflare-Access-Modus im Browser“ mit CF-E1 bis CF-E4 und einer Fehlerprüfung. Die Access-Edge wird über einen signierten `Cf-Access-Jwt-Assertion`-Header nachgestellt.
  - im bestehenden Szenario zusätzlich „keine externen Anfragen“.

### C4. Angepasste bestehende Tests (Punkt 25: keine gelöscht, keine Prüfung abgeschwächt)

| Datei / Test | Änderung | Warum |
|---|---|---|
| `test/api.test.js` „Eingaben: JSON-Pflicht …“ | Die direkte `fetch`-Anfrage sendet jetzt `Origin` mit. | Ohne Origin gibt es seit Punkt 10 **zu Recht** 403 statt der geprüften 415. Die 415-Prüfung bleibt unverändert. |
| `test/api.test.js` „Cloudflare Access: …“ | Die Anmeldung läuft über `access-session` statt `request-code`/`verify-code`. Neu wird geprüft, dass **keine** Mail entsteht. Alle JWT-Negativprüfungen bleiben (falsche Audience, falscher Issuer, abgelaufen, falscher Schlüssel, falsche Identität). | Punkt 4: Der alte Test prüfte genau den doppelten Code, der jetzt verboten ist. |
| `test/api.test.js` | Das `accessFixture()` ist unverändert nach `test/helpers.js` umgezogen, ergänzt um die Option `iat`. | Wird jetzt auch von den neuen Tests und E2E genutzt. |
| `test/privacy.test.js` `setupScenario` | Der Server startet mit `IMAGE_HOST_ALLOWLIST=cdn.example.test`. | Punkt 7: Externe URLs sind standardmäßig verboten. Der Leak-Test braucht ein URL-Bild, deshalb wird genau dieser Host freigegeben. Alle Leak-Prüfungen bleiben gleich. |
| `test/helpers.js` `Browser.request` | Ändernde Anfragen senden automatisch die Origin der Seite (wie ein echter Browser). `headers: { origin: null }` entfernt sie für Negativtests. | Punkt 10 (fail-closed). |
| `test/e2e/run-e2e.js` | `apiServer.origin` ist gesetzt, `startDruckplatte` nimmt Optionen an. | Punkt 10 sowie das neue Cloudflare-Szenario. |

---

## Teil D – Security-Review nach dem Fix (Punkt 38)

| Bereich | Ergebnis der Nachprüfung |
|---|---|
| **Auth** | Es gibt zwei getrennte Modi. Mit Access ist **nur** `access-session` aktiv, mit geprüftem JWT (RS256/JWKS, `aud`, `iss`, `exp`, `nbf`). Ein neues Gerät gibt es nur bei frischem `iat` (Standard 10 Min.) und nur nach dem letzten Abmelden/Reset (Z5). Die Registrierung ist rate-limitiert (Z6). Eine Produktion ohne Access startet nicht. Der E-Mail-Code-Modus bleibt für Preview/Test mit Hash, 10 Min., 5 Versuchen und einmaliger Nutzung. |
| **Device Token** | Unverändert: 256 Bit, nur HMAC-Hash, absolut 30 Tage, keine Verlängerung. Rotation bei erneuter Anmeldung im selben Browser. Das Gerät ist an die Access-Identität gebunden: Ein Gerät von A gilt nie für B, getestet auch im Cloudflare-Modus. |
| **Cookies** | `__Host-dp_device` / `__Host-dp_session`: HttpOnly, Secure, SameSite=Lax, Path=/, keine Domain. Laufzeit ≤ 2 592 000 s. |
| **Origin** | Fail-closed, nur konfigurierte Origins, in Produktion nur https, kein Host-Header. |
| **CSRF** | Origin-Pflicht, SameSite=Lax und JSON-Pflicht (415 für Formulare) wirken zusammen. Es gibt keine GET-Route mit Zustandsänderung, außer der stillen Sitzungswiederherstellung, die harmlos ist. |
| **Privacy** | Die Projektionen sind unverändert positiv aufgebaut (Allowlist). Neu: öffentliche Links nur MakerWorld, Bild-URLs werden beim Ausliefern erneut geprüft. Die Leak-Tests (API und E2E-DOM/Netzwerk) sind grün. |
| **Queue** | Unverändert: fremd-privat → `private_queue_slot`, eigene Position sichtbar (D–G, E2E E7). |
| **Current Print** | Unverändert: fremd-privat nur mit gerundetem Fortschritt und gerundeter Restzeit (A–C). |
| **Public Models** | Eigene und fremde öffentliche Modelle erscheinen nur als Allowlist, ohne DP-Nummer, IDs, E-Mail oder Notiz (PUBLIC1–3, T/U/V). |
| **Account Delete** | Aufträge werden privat, Geräte, Sitzungen und Codes gelöscht, ein alter Cookie ergibt 401 (DELETE1–5, AT). |
| **DP Counter** | Unverändert, race-safe innerhalb eines Prozesses. Mehrere Prozesse verhindert der jetzt atomare Lock (N/O, LOCK4b). |
| **Locking** | Atomar (siehe B1). **Grenze:** Hat das Betriebssystem die PID des verwaisten Locks inzwischen an einen anderen lebenden Prozess vergeben, gilt der Lock als belegt. Der Server startet dann nicht (sicher, aber manuelles Entfernen nötig). |
| **External URLs** | Standard: keine. Die Allowlist gilt nur mit https und exaktem Host, private und lokale Ziele sind immer gesperrt. Der Server ruft Bild-URLs **nie** selbst ab, es gibt also kein SSRF. Die Sperren schützen die Browser der Nutzer vor internen Zielen. **Grenze:** Ein freigegebener Hostname könnte per DNS auf eine interne IP zeigen. Deshalb sollten nur vertrauenswürdige CDNs freigegeben werden. |
| **CSP** | Streng, siehe B1/24. **Rest:** `style-src 'unsafe-inline'` bleibt wegen der `style`-Attribute (Farbpunkte, Fortschrittsbalken). Skripte bleiben streng `'self'`. |
| **Admin Boundary** | Die Admin-Rolle kommt nur aus `ADMIN_EMAILS` und gilt nur mit Admin-Passwort pro Sitzung. Access allein gibt **keine** Admin-Rechte (im Cloudflare-Modus getestet), ein wiederhergestelltes Gerät ebenfalls nicht (AU). |

---

## Teil E – NOCH OFFEN

1. **Kein Abgleich mit dem echten Produktivcode (v146).** Er liegt nicht im Repo. Wie Auth und Handoff, die Datenstruktur, der Service Worker, REP/SUP und die Bambu-/A2L-Anbindung dort aussehen, ist hier ungeprüft.
2. **Cloudflare-Einstellungen nicht geprüft und nicht geändert.** Ohne Dashboard-Zugriff lässt sich nicht feststellen, welche Session-Dauern aktuell gelten (siehe Teil F2).
3. **Frische-Grenze im Cloudflare-Modus:** Druckplatte sieht nur das `iat` des Access-Tokens, nicht, ob Cloudflare wirklich einen Code verlangt hat. Läuft das App-Token ab, stellt Cloudflare bei **noch gültiger globaler Sitzung** ohne Code ein neues aus. Trifft das genau auf das Ende der 30 Tage eines Geräts (Zeitfenster ≤ `CF_ACCESS_MAX_LOGIN_AGE_MINUTES`), könnte ein neues Gerät ohne Code entstehen. Das Hauptszenario ist dagegen abgesichert: Nach 30 Tagen ist das Token alt, und „Neu anmelden“ geht über `/cdn-cgi/access/logout`. Laut Cloudflare beendet diese Abmeldung die Sitzung in allen Access-Apps, danach ist ein neuer Code nötig.
4. **`style-src 'unsafe-inline'`** ist noch erlaubt (siehe D).
5. **Produktions-Mailtransport** ist absichtlich nicht enthalten. `MAIL_PRODUCTION_ENABLED=true` bricht den Start ab.
6. **Support-Modul** bleibt ein Prototyp und wird nicht weiterentwickelt (siehe F1).

---

## Teil F – SPÄTERE PRODUKTIONSINTEGRATION (separater Auftrag, erst nach Freigabe)

### F1. Was selektiv übernommen werden kann – und was nicht

**Geeignet für einen selektiven Port** in eine isolierte Kopie der echten Druckplatte:

1. **Datenschutz-Projektion:** `server/domain/privacy.js` (inkl. `PUBLIC_MODEL_FIELDS`, `publicLink`, `imageUrlFor`) + `server/domain/queue.js`, dazu die Tests aus `privacy.test.js` und PUBLIC/DELETE aus `review-fixes.test.js`.
2. **Trusted-Device-Logik:** `server/auth/devices.js`, `sessions.js`, `identity.js`, `pepper.js`, `cfAccess.js` und das Muster `registerLogin()` / `access-session` aus `server/app.js`, dazu `trusted-device.test.js` und die Cloudflare-Modus-Tests.
3. **DP-Ideen-Logik:** `server/domain/dpRefs.js` + `scripts/migrate-idea-dp.js`, dazu `dp.test.js`.
4. **Einzelne Härtungen als Muster:** Origin-Prüfung, Bild-URL-Prüfung (`images.js`), atomarer Lock (`store.js`), CSP-Builder.

**Nicht portieren:**

- **`server/domain/support.js`: NICHT in die echte Druckplatte übernehmen.** Dieses vereinfachte Support-Modul löscht Einträge beim Erledigen. Es ist kein Ersatz für das produktive REP-/SUP-System mit direkten Admin-Gesprächen, Archiv, Abschlusszeitpunkt, vollständigem Verlauf, „Wieder öffnen“ und gleicher ID/Referenz. Keine Integrationsanweisung darf es als Ersatz vorschlagen.
- Ebenfalls nicht übernehmen: `server/store.js` als Ersatz für die produktive Datenhaltung, `public/*` als Ersatz der produktiven Oberfläche und die Mail-Stubs.
- In der Produktion bleiben: echte Current-Print-Logik, Bambu/A2L, Bambuddy, REP/SUP, Archiv, Mail, Filament, Kosten, bestehende Auth, bestehender Handoff, Service Worker und die produktive Datenstruktur.

### F2. Cloudflare-Integration (nur dokumentiert – nichts an Cloudflare geändert)

Ein Druckplatte-Geräte-Cookie **kann Cloudflare Access nicht umgehen**, und das ist auch nicht gewollt. Verlangt Access z. B. nach 24 Stunden wieder einen Code, hilft ein gültiges Druckplatte-Gerät allein nicht. Für „30 Tage kein Code“ muss Access mitspielen:

- **Application → Session Duration: 1 month (≥ 30 Tage).** Innerhalb der 30 Tage wird dann kein neues App-Token nötig. Keine Policy der App darf eine kürzere Session Duration setzen, weil die Policy-Dauer Vorrang hat.
- **Global Session Duration:** Cloudflare empfiehlt, sie gleich oder länger als die App-Sitzung zu setzen. Dabei gilt Folgendes:
  - **Länger als 30 Tage:** Nach Ablauf eines App-Tokens gibt Cloudflare still ein neues aus (siehe Teil E3).
  - **Streng, „nach 30 Tagen immer ein Code“:** globale Sitzung ≤ 30 Tage. Nachteil: Andere Access-Apps fragen dann ebenfalls häufiger.

  Diese Abwägung musst du in Cloudflare selbst entscheiden.
- **Cookie-Einstellungen der App:** SameSite **nicht** `Strict`, sonst fehlt das Access-Cookie bei Klicks aus Mail-Programmen. HttpOnly aktiv. Optional „Binding Cookie“.
- **Ablauf nach 30 Tagen:**
  1. Das Druckplatte-Gerät ist abgelaufen, das Access-Token alt.
  2. Druckplatte zeigt „Neue Anmeldung nötig“ mit dem Button `/cdn-cgi/access/logout`.
  3. Cloudflare beendet die Sitzung und verlangt einen neuen Code.
  4. Das frische Token registriert ein neues Gerät für wieder 30 Tage.
- In der Produktion braucht Druckplatte: `DRUCKPLATTE_ENV=production`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `PUBLIC_BASE_URL=https://…` und bei Bedarf `ALLOWED_ORIGINS`. `AUTH_MODE` ergibt sich dann automatisch als `cloudflare-access`.

Quellen: [Cloudflare One – Session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/), [Cloudflare One – Identity FAQ (Logout)](https://developers.cloudflare.com/cloudflare-one/faq/authentication-faq/). Die Doku-Seiten selbst sind aus dieser Umgebung gesperrt. Die Aussagen stammen aus der Websuche und sollten vor einer Umstellung im Dashboard gegengeprüft werden.

---

## Teil G – Antworten auf die 36 Pflichtfragen (Punkt 39)

1. **Was wurde korrigiert?** Doppelter Code, fail-closed in Produktion, atomarer Stale-Lock, externe Bilder + CSP + lokale Schriften, Kontolöschung → privat, eigene öffentliche Modelle, strikte Origin-Prüfung. Dazu die Zusatzprobleme Z1–Z9 (Teil B).
2. **Wurde der Branch deployt?** **NEIN.**
3. **Warum darf der Branch nicht als Ganzes Produktion ersetzen?** Er ist eine eigenständige Preview-App mit eigener Datenhaltung, eigener Oberfläche und Mail-Stubs. Ihm fehlen Bambu/A2L, Bambuddy, REP/SUP, Archiv, Filament/Kosten, Service Worker, der bestehende Handoff und die produktive Datenstruktur. Ein Ersetzen würde all das verlieren. Deshalb nur selektiver Port (F1).
4. **Wie wurde die Doppelcode-Problematik behandelt?** Im Modus `cloudflare-access` verschickt Druckplatte keinen Code. Die geprüfte Access-Identität registriert das Gerät (`access-session`), und die Code-Endpunkte sind deaktiviert. Die Kombination Access + eigener Code bricht den Start ab.
5. **Wie soll die spätere Cloudflare-Integration funktionieren?** Access bestätigt die E-Mail → Server prüft das JWT → frische Anmeldung → Gerät für 30 Tage. Danach folgt die Wiedererkennung ohne Code. Nach Ablauf geht es über „Neu anmelden“ (Access-Logout) zum neuen Code. Die Session-Dauern sind in F2 beschrieben.
6. **Ist Cloudflare Access in Production fail-closed?** **Ja.** Der Start bricht ohne `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` oder bei halber Konfiguration ab. Ausnahme ist nur `ALLOW_WITHOUT_CF_ACCESS=true` (CF1, CF2, CF1/CF2 real, CF4).
7. **Wie wurde die Stale-Lock-Race-Condition behoben?** Ein exklusiver Wiederherstellungs-Lock (`O_EXCL`), dann erneutes Lesen des Locks, dann Löschen und exklusives Neuanlegen. Wer verliert, bricht sauber ab. `close()` löscht nur den eigenen Lock (`server/store.js:172–194`).
8. **Gibt es einen Parallel-Recovery-Test?** **Ja:** LOCK4a (deterministisch verschachtelt) und LOCK4b (6 echte Prozesse × 5 Runden, synchronisierter Start). Gegen den alten Code schlägt LOCK4b nachweislich fehl (4 Besitzer gleichzeitig).
9. **Wie werden externe Bilder jetzt behandelt?** Standardmäßig gar nicht, nur Uploads. Optional per `IMAGE_HOST_ALLOWLIST` von exakten öffentlichen Hosts über https. Altdaten werden beim Ausliefern gefiltert, und die CSP lässt nur diese Hosts zu.
10. **Werden private und lokale Netzwerkziele blockiert?** **Ja, immer**, auch mit Allowlist: localhost, 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, 0/8, Multicast/reserviert, IPv6 `::1`, `fc00::/7`, `fe80::/10`, `::ffff:`-Formen, interne Namen (IMAGE1–7).
11. **Was passiert mit öffentlichen Aufträgen bei der Löschung eines Kontos?** Sie bleiben für den Admin erhalten, werden aber `isPublic=false` und verschwinden aus „Öffentliche Modelle“ (DELETE1–3).
12. **Sind eigene öffentliche Modelle wieder in „Öffentliche Modelle“ sichtbar?** **Ja**, als Allowlist-Eintrag (PUBLIC1). Fremde sehen sie ebenfalls (PUBLIC2), private bleiben privat (PUBLIC3).
13. **Wie funktioniert der Origin-Check jetzt?** Bei jeder ändernden Anfrage muss `Origin` exakt in `{PUBLIC_BASE_URL-Origin} ∪ ALLOWED_ORIGINS` enthalten sein (`server/app.js:86`).
14. **Werden fehlende Origins bei Mutationen abgelehnt?** **Ja**, mit 403 `origin_required` (ORIGIN3).
15. **Wird der Host-Header nicht mehr automatisch übernommen?** **Ja.** Ein gefälschter `Host` + passender `Origin` ergibt 403 (ORIGIN4).
16. **Wie funktioniert Trusted Device?** Nach erfolgreicher Anmeldung (E-Mail-Code in Preview/Test oder frische Access-Identität) gibt es einen 256-Bit-Token im HttpOnly-Cookie. Serverseitig liegt nur der HMAC-Hash. Die Sitzung ist getrennt (12 h) und an das Gerät gebunden.
17. **Wie lange ist es gültig?** Exakt 30 × 24 Stunden ab Anmeldung, absolut.
18. **Wird `expiresAt` nicht verlängert?** **Richtig**, er wird nie verlängert (AH). Nur `lastUsedAt` ändert sich.
19. **Erzeugen E-Mail-Links kein neues Gerät?** **Richtig** (AC/AD/AE, E-Mail-Links A–G, E2E E5). Im Cloudflare-Modus stellt `access-session` bei vorhandenem Gerät nur die Sitzung wieder her (`restored:true`, CF-E2).
20. **Wird nur der Token-Hash gespeichert?** **Ja**, HMAC-SHA256 mit Server-Pepper. Ein Test durchsucht die Datendatei nach dem Klartext-Token.
21. **Wie werden Sperre und Löschung geprüft?** Bei **jeder** Wiederherstellung prüft der Server, ob der Benutzer existiert, welchen Status er hat, ob das Gerät widerrufen ist und ob es abgelaufen ist. Eine Sperre widerruft alle Geräte. Eine Löschung entfernt Geräte, Sitzungen und Codes. Gilt auch im Cloudflare-Modus (AS, AT, DELETE4/5, „Cloudflare-Modus: Sperre …“).
22. **Wie funktioniert die Admin-Sicherheit?** Die Rolle kommt nur aus `ADMIN_EMAILS`. Zusätzlich ist das Admin-Passwort (scrypt) pro Sitzung nötig. Weder Access noch ein wiederhergestelltes Gerät geben Admin-Rechte (AU, Cloudflare-Modus-Test).
23. **Wie funktionieren DP-Nummern für Ideen?** `DP-JJJJ-NNNNNN`, vergeben in derselben Transaktion wie das Speichern. „Idee“ ist nur Typ bzw. Badge.
24. **Nutzen Idee und normaler Auftrag denselben Zähler?** **Ja** (J/K/L/M).
25. **Ist der Zähler race-safe?** **Ja**: synchrone Copy-on-Write-Transaktionen und die Eindeutigkeitsprüfung (N/O mit 40 parallelen Einreichungen, P für Rollback). Einen zweiten Prozess verhindert der atomare Lock (LOCK4b).
26. **Wie viele bestehende Ideen ohne DP wurden in der Preview gefunden?** **2**, die bewusst angelegten Alt-Ideen „Schlüsselbrett Flur“ und „Deko-Mond Lampe“ (Dry-Run heute erneut ausgeführt: „Ohne DP: 2“).
27. **Wurde nur Dry Run / Preview gemacht?** **Ja.** Dry-Run und Anwendung liefen nur auf Preview- bzw. Testdaten.
28. **Wurde die Produktion NICHT migriert?** **Richtig**, keine Produktionsmigration. Produktionsdaten waren nicht erreichbar.
29. **Warum darf das Support-Modul nicht in Produktion übernommen werden?** Es löscht Einträge beim Erledigen und hat kein REP/SUP, keinen Verlauf, kein Archiv und kein „Wieder öffnen“. Die Produktion hat dafür ein vollständiges eigenes System (F1).
30. **Welche Module sind für einen selektiven Port geeignet?** Privacy-Projektion, Trusted-Device-Logik, DP-Ideen-Logik und die passenden Tests, plus einzelne Härtungen als Muster (F1).
31. **Welche Dateien wurden geändert?** Siehe Teil H.
32. **Welche Tests wurden ergänzt?** Siehe C3 (27 neue Server-Tests, 6 neue bzw. erweiterte E2E-Schritte).
33. **Tests total/pass/fail?** `npm test`: 91 / 91 / 0 (skip 0). E2E: 19 / 19 / 0 (skip 0). Zusammen 110 / 110 / 0 / 0.
34. **Wurden echte Mails gesendet?** **NEIN.** Es gibt nur den Dev-Postausgang, der Produktions-Mailtransport ist gesperrt.
35. **Wurde ein echter Druck gestartet?** **NEIN.** Dieser Build hat keine Druckeranbindung.
36. **Wurde Produktion verändert?** **NEIN.** Es gab keinen Zugriff auf Produktivsystem, Produktionsdaten, Cloudflare, Mail oder Bambu. Gepusht wurde nur auf diesen Feature-Branch.

---

## Teil H – Dateien (Punkt 36)

**Geändert:**

| Datei | Warum |
|---|---|
| `server/config.js` | fail-closed, `AUTH_MODE`, `ALLOW_WITHOUT_CF_ACCESS`, `ALLOWED_ORIGINS`, `IMAGE_HOST_ALLOWLIST`, `CF_ACCESS_MAX_LOGIN_AGE_MINUTES`, Validierungen |
| `server/app.js` | `access-session`, `registerLogin`/`finishLogin`, strikte Origin-Prüfung, Abmelden mit Reauth-Grenze, Rate-Limit, 400 bei kaputter Kodierung, lokale Schriften, dynamische CSP, Dev-Postausgang nur direkt lokal |
| `server/store.js` | atomare Stale-Lock-Übernahme, nur eigenen Lock löschen |
| `server/domain/images.js` | Bild-URL-Richtlinie (Allowlist, private und lokale Ziele) |
| `server/domain/privacy.js` | Factory mit Allowlist, eigene öffentliche Modelle, nur MakerWorld-Links, Bild-URL-Nachprüfung |
| `server/domain/users.js` | Löschung → `isPublic=false`; `requireReauth` bei Sicherheitsreset |
| `server/domain/support.js` | Kennzeichnung „PROTOTYP – nicht portieren“ |
| `server/auth/cfAccess.js` | liefert zusätzlich `iat` |
| `server/util/http.js` | `buildHtmlCsp` (ohne externe Hosts) |
| `public/index.html` | lokale `@font-face` statt Google Fonts, Access-Hinweisbereich, URL-Feld nur mit Allowlist, `.btn` ohne Unterstreichung, Untertitel „Öffentliche Modelle“ (enthält jetzt auch eigene) |
| `public/app.js` | Cloudflare-Anmeldung ohne Code, Hinweise „Neu anmelden“/„Abgemeldet“, keine automatische Neuregistrierung nach Abmelden, Bild-URL-Richtlinie |
| `scripts/preview.js` | `ALLOWED_ORIGINS` für `127.0.0.1` in der Preview |
| `README.md` | neue Variablen, Cloudflare-Modell, Härtungen, Status |
| `docs/ABSCHLUSSBERICHT.md` | Hinweis auf diesen Bericht, überholte Aussagen markiert |
| `test/api.test.js`, `test/privacy.test.js`, `test/helpers.js`, `test/e2e/run-e2e.js` | siehe C4 |

**Neu:**

| Datei | Zweck |
|---|---|
| `test/review-fixes.test.js` | Pflichttests CF/LOCK/DELETE/PUBLIC/ORIGIN/IMAGE + Zusatztests |
| `public/fonts/*.woff2` (6 Dateien) + `LICENSE-*-OFL.txt` (3) | lokal ausgelieferte Schriften (Inter, Space Grotesk, JetBrains Mono; SIL Open Font License) |
| `docs/REVIEW-BERICHT.md` | dieser Bericht |

---

## STOPP

Umgesetzt wurden nur Arbeiten in diesem Branch, in der Preview und in Tests. **Nicht angefasst:** Produktivsystem, Produktionsdaten und -dienste, Produktions-Cloudflare, Produktions-Mail, Bambu/A2L. Nächster Schritt erst nach deiner ausdrücklichen Freigabe: der separate Portierungsauftrag (Punkt 42).

**Dieser Branch ist NICHT direkt produktionskompatibel und wurde NICHT deployt.**
