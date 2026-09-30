#!/usr/bin/env node
'use strict';

/**
 * Gibt eine Aufgabe an ChatGPT (OpenAI API) ab und gibt die Antwort aus.
 * Wird von Claude Code über /chatgpt genutzt, wenn der Nutzer das ausdrücklich möchte.
 *
 *   node tools/chatgpt.js "Aufgabe …"                      Aufgabe als Text
 *   node tools/chatgpt.js --datei pfad/zur/datei "Aufgabe"  Datei(en) als Kontext mitschicken
 *   echo "Aufgabe" | node tools/chatgpt.js                  Aufgabe über stdin
 *   node tools/chatgpt.js --modelle                         verfügbare Modelle anzeigen
 *
 * Umgebung: OPENAI_API_KEY (Pflicht, nie ins Repo/Chat), OPENAI_MODEL (Pflicht),
 *           OPENAI_BASE_URL (optional, Standard https://api.openai.com/v1).
 * Schutz: Dateien, die nach Geheimnissen aussehen (.env, Schlüssel, Zertifikate), werden nie gesendet.
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_FILE_BYTES = 200 * 1024;
const BLOCKED_FILE = /(^|\/)(\.env(\..*)?|.*\.(key|pem|p12|pfx|crt|sqlite3?|db)|auth-pepper\.key|id_(rsa|ed25519).*)$/i;

function fail(message) {
  process.stderr.write(`chatgpt: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const files = [];
  const words = [];
  let listModels = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--datei') {
      if (!argv[i + 1]) fail('--datei braucht einen Pfad');
      files.push(argv[(i += 1)]);
    } else if (argv[i] === '--modelle') listModels = true;
    else words.push(argv[i]);
  }
  return { files, task: words.join(' ').trim(), listModels };
}

function readStdin() {
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8').trim();
  } catch {
    return '';
  }
}

function fileContext(files) {
  return files
    .map((file) => {
      const resolved = path.resolve(file);
      if (BLOCKED_FILE.test(resolved)) fail(`${file} sieht nach Geheimnissen/Daten aus und wird nicht gesendet`);
      const stat = fs.statSync(resolved, { throwIfNoEntry: false });
      if (!stat || !stat.isFile()) fail(`${file} nicht gefunden`);
      if (stat.size > MAX_FILE_BYTES) fail(`${file} ist größer als ${MAX_FILE_BYTES / 1024} KB – bitte nur den relevanten Ausschnitt senden`);
      return `--- Datei: ${file} ---\n${fs.readFileSync(resolved, 'utf8')}`;
    })
    .join('\n\n');
}

async function request(baseUrl, key, route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keine JSON-Antwort */
  }
  if (!res.ok) fail(`OpenAI antwortet mit HTTP ${res.status}: ${(json && json.error && json.error.message) || text.slice(0, 300)}`);
  return json;
}

async function main() {
  const { files, task: argTask, listModels } = parseArgs(process.argv.slice(2));
  const key = process.env.OPENAI_API_KEY;
  if (!key) fail('OPENAI_API_KEY ist nicht gesetzt (in den Umgebungs-Einstellungen hinterlegen, nie in den Chat kopieren)');
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');

  if (listModels) {
    const data = await request(baseUrl, key, '/models');
    const ids = (data.data || []).map((m) => m.id).sort();
    process.stdout.write(`${ids.join('\n')}\n`);
    return;
  }

  const model = process.env.OPENAI_MODEL;
  if (!model) fail('OPENAI_MODEL ist nicht gesetzt (verfügbare Modelle: node tools/chatgpt.js --modelle)');
  const task = argTask || readStdin();
  if (!task) fail('keine Aufgabe angegeben');

  const context = fileContext(files);
  const data = await request(baseUrl, key, '/chat/completions', {
    model,
    messages: [
      {
        role: 'system',
        content: 'Du arbeitest als zweiter Helfer neben Claude an einem Softwareprojekt. Antworte auf Deutsch, knapp und konkret. Code als vollständige, einsetzbare Blöcke.',
      },
      { role: 'user', content: context ? `${task}\n\n${context}` : task },
    ],
  });
  const answer = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
  if (!answer) fail('leere Antwort von OpenAI');
  process.stdout.write(`${answer.trim()}\n`);
  if (data.usage) process.stderr.write(`chatgpt: ${data.model || model} · Tokens ein ${data.usage.prompt_tokens} / aus ${data.usage.completion_tokens}\n`);
}

main().catch((err) => fail(err.message));
