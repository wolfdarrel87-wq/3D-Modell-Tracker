# Hinweise für Claude (Claude Code)

Sprache: Deutsch. **Keine Secrets** (Passwörter, Tokens, Schlüssel, `.env`) und keine internen Infrastruktur-Details (IPs, Pfade, Benutzernamen) ins Repo. Nichts in Produktion deployen ohne ausdrückliche Freigabe.

## Modellwahl und Token sparen

Grundsatz: so klein wie möglich, so groß wie nötig. Entscheidend sind die Kosten pro erledigter Aufgabe, nicht pro Nachricht.

| Modell | Wofür | relativ |
|---|---|---|
| Haiku 4.5 | Suchen, Lesen, Zusammenfassen, einfache Einträge | 1× |
| Sonnet 5.5 | Klar umrissene Routine-Änderungen, Tests ergänzen, Doku | 2× |
| Opus 5.5 | Architektur, Sicherheit, Datenschutz, große Umbauten, alles mit Produktionsbezug | 4× |
| Fable 5.1 | Nur wenn Opus nicht reicht | 10× |

Nenne am Anfang jeder neuen Aufgabe in einem Satz das passende Modell. Ist das Hauptmodell deutlich zu groß oder zu klein, empfiehl den Wechsel (`/model`). Kurz antworten, nichts wiederholen, keine unnötigen Tool-Aufrufe.

## Selbst entscheiden: Teilaufgaben an günstigere Modelle abgeben

Der Nutzer erlaubt ausdrücklich, dass du **selbst entscheidest**, wann du Teilaufgaben an die Projekt-Agenten abgibst:

- `schnell-leser` (Haiku): breite Suchen über viele Dateien, lange Logs/Testausgaben/Dokumente lesen und zusammenfassen – wenn nur das Ergebnis gebraucht wird.
- `alltags-coder` (Sonnet): vollständig beschriebene Routine-Änderungen in wenigen bekannten Dateien.

Abgeben lohnt sich nur, wenn die Teilaufgabe **groß genug** ist (viel Lesen, mehrere Dateien) und **ohne das bisherige Gespräch** verständlich beschrieben werden kann – jeder Agent startet ohne Vorwissen, das kostet zusätzlich. Nicht abgeben:

- kleine Aufgaben mit wenigen Tool-Aufrufen (selbst erledigen ist billiger),
- alles zu Sicherheit, Authentifizierung, Datenschutz, Migrationen, Produktion – das bleibt beim Hauptmodell,
- Aufgaben, die laufende Rückfragen an den Nutzer brauchen.

Ergebnisse von Agenten prüfst du selbst (Diff lesen, Tests/Prüfung laufen lassen), bevor du sie dem Nutzer meldest. Erfolge nie ungeprüft übernehmen.

Mehr Kontext (wenn Notion verbunden ist): Seite „🤖 Claude – Zuerst lesen“ im „Zweiten Gehirn“.

## Projekt: 3D-Modell-Tracker (Druckplatte)

- Auf `main` liegt der ursprüngliche Prototyp „Druckplatte 3.0“ (`index.html`, eine einzelne Datei). Öffentliches Repo.
- Die isolierte Preview mit Server, Datenschutz, DP-Nummern, vertrauenswürdigen Geräten und Tests liegt auf dem Branch `claude/amazing-galileo-jq5avw` (Bericht: `docs/REVIEW-BERICHT.md`, Tests: `npm test`, `npm run test:e2e`).
- Die echte Druckplatte (v146) läuft woanders; dieses Repo ist nicht die Produktion. Kein Deploy.
- Design der Original-Druckplatte beibehalten; neue Funktionen als Pop-ups im gleichen Stil.
