---
description: Eine Aufgabe separat an ChatGPT (OpenAI) abgeben – nur auf ausdrücklichen Wunsch des Nutzers
argument-hint: <Aufgabe für ChatGPT> [--datei pfad …]
allowed-tools: Bash(node tools/chatgpt.js:*)
---

Der Nutzer möchte, dass ChatGPT diese Aufgabe separat erledigt: $ARGUMENTS

So gehst du vor:

1. Prüfe vor dem Senden, was an OpenAI geht. **Nie** senden: Secrets, Tokens, Passwörter, `.env`, Schlüssel, Produktionsdaten, personenbezogene Daten, interne Infrastruktur-Details. Nur die Dateien/Ausschnitte mitschicken, die für die Aufgabe nötig sind (`--datei pfad`).
2. Führe `node tools/chatgpt.js [--datei …] "<Aufgabe>"` aus. Dauert die Aufgabe länger, starte den Befehl im Hintergrund und arbeite parallel an deinem Teil weiter.
3. Zeige dem Nutzer die Antwort von ChatGPT (klar als „ChatGPT:“ gekennzeichnet).
4. Übernimm Code oder Änderungen von ChatGPT **nicht ungeprüft**: erst lesen, einsetzen nur wenn der Nutzer das möchte, danach Tests laufen lassen.
5. Fehlt `OPENAI_API_KEY` oder ist `api.openai.com` gesperrt, sag das in einem Satz und wie der Nutzer es in den Umgebungs-Einstellungen freigibt – nie nach dem Schlüssel im Chat fragen.
