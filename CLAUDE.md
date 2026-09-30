# Hinweise für Claude (Claude Code)

Sprache: Deutsch. Dies ist ein Referenz-Branch/Preview der Druckplatte – **kein Produktions-Deploy**, keine Secrets, keine internen Infrastruktur-Details (IPs, Pfade, Benutzernamen) ins Repo – es ist öffentlich.

## Modellwahl und Token sparen

Grundsatz: so klein wie möglich, so groß wie nötig. Entscheidend sind die Kosten pro erledigter Aufgabe, nicht pro Nachricht.

| Modell | Wofür | relativ |
|---|---|---|
| Haiku 4.5 | Suchen, Lesen, Zusammenfassen, einfache Einträge | 1× |
| Sonnet 5.5 | Klar umrissene Routine-Änderungen, Tests ergänzen, Doku | 2× |
| Opus 5.5 | Architektur, Sicherheit, Datenschutz, große Umbauten, alles mit Produktionsbezug | 4× |
| Fable 5.1 | Nur wenn Opus nicht reicht | 10× |

Nenne am Anfang jeder neuen Aufgabe in einem Satz das passende Modell. Ist das Hauptmodell deutlich zu groß oder zu klein, empfiehl den Wechsel (`/model`).

## Selbst entscheiden: Teilaufgaben an günstigere Modelle abgeben

Der Nutzer erlaubt ausdrücklich, dass du **selbst entscheidest**, wann du Teilaufgaben an die Projekt-Agenten abgibst:

- `schnell-leser` (Haiku): breite Suchen über viele Dateien, lange Logs/Testausgaben/Dokumente lesen und zusammenfassen – wenn nur das Ergebnis gebraucht wird.
- `alltags-coder` (Sonnet): vollständig beschriebene Routine-Änderungen in wenigen bekannten Dateien.

Abgeben lohnt sich nur, wenn die Teilaufgabe **groß genug** ist (viel Lesen, mehrere Dateien) und **ohne das bisherige Gespräch** verständlich beschrieben werden kann – jeder Agent startet ohne Vorwissen, das kostet zusätzlich. Nicht abgeben:

- kleine Aufgaben mit wenigen Tool-Aufrufen (selbst erledigen ist billiger),
- alles zu Sicherheit, Authentifizierung, Datenschutz-Projektionen, Migrationen, Produktion – das bleibt beim Hauptmodell,
- Aufgaben, die laufende Rückfragen an den Nutzer brauchen.

Ergebnisse von Agenten prüfst du selbst (Diff lesen, Tests laufen lassen), bevor du sie dem Nutzer meldest. Erfolge nie ungeprüft übernehmen.

## ChatGPT als zweiter Helfer (nur auf Anweisung des Nutzers)

Sagt der Nutzer, dass ChatGPT eine Aufgabe übernehmen soll (oder nutzt `/chatgpt …`), gibst du genau diese Aufgabe mit `node tools/chatgpt.js [--datei pfad …] "Aufgabe"` an ChatGPT ab. Selbst entscheidest du das nicht.

- Lange Aufgaben im Hintergrund starten und parallel am eigenen Teil weiterarbeiten.
- An OpenAI geht nur das Nötige: **nie** Secrets, `.env`, Schlüssel, Produktionsdaten, personenbezogene Daten oder interne Infrastruktur-Details (das Skript blockiert Geheimnis-Dateien zusätzlich).
- Antworten klar als „ChatGPT:“ kennzeichnen, nicht ungeprüft übernehmen; nach dem Einsetzen Tests laufen lassen.
- Voraussetzungen: `OPENAI_API_KEY` und `OPENAI_MODEL` als Umgebungsvariablen, Netzwerkfreigabe für `api.openai.com`. Fehlt etwas, das in einem Satz sagen – nie nach dem Schlüssel im Chat fragen.

## Projekt

- Node ≥ 20, keine Abhängigkeiten: `npm test` (Server/Integration, inkl. ChatGPT-Anbindung gegen lokalen Nachbau), `npm run test:e2e` (Playwright/Chromium), `npm run preview` (isolierte Preview auf localhost:8080).
- Berichte: `docs/REVIEW-BERICHT.md` (aktuell), `docs/ABSCHLUSSBERICHT.md`.
- `server/domain/support.js` ist ein Prototyp und wird **nicht** in die echte Druckplatte portiert.
- Testzahlen immer echt angeben (total/pass/fail/skip), Tests nie löschen oder abschwächen.
