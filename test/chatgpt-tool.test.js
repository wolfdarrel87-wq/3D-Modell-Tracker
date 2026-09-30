'use strict';

// Prüft tools/chatgpt.js gegen einen lokalen Nachbau der OpenAI-API (kein Netzwerk, kein echter Schlüssel).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'tools', 'chatgpt.js');

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

async function mockOpenAI(t) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'modell-b' }, { id: 'modell-a' }] }));
      res.end(JSON.stringify({ model: 'modell-a', choices: [{ message: { content: 'Antwort von ChatGPT' } }], usage: { prompt_tokens: 12, completion_tokens: 4 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

test('ChatGPT-Anbindung: Aufgabe + Datei gehen an OpenAI, Antwort kommt zurück', async (t) => {
  const api = await mockOpenAI(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-test-'));
  const file = path.join(dir, 'beispiel.js');
  fs.writeFileSync(file, 'function summe(a, b) { return a + b; }');
  const res = await run(['--datei', file, 'Schreib einen Test für summe'], { OPENAI_API_KEY: 'test-schluessel', OPENAI_MODEL: 'modell-a', OPENAI_BASE_URL: api.baseUrl });
  assert.equal(res.code, 0, res.err);
  assert.equal(res.out.trim(), 'Antwort von ChatGPT');
  assert.equal(api.requests.length, 1);
  const sent = api.requests[0];
  assert.equal(sent.url, '/v1/chat/completions');
  assert.equal(sent.auth, 'Bearer test-schluessel');
  assert.equal(sent.body.model, 'modell-a');
  const user = sent.body.messages.find((m) => m.role === 'user').content;
  assert.match(user, /Schreib einen Test für summe/);
  assert.match(user, /function summe/);
  assert.ok(!res.out.includes('test-schluessel') && !res.err.includes('test-schluessel'), 'Schlüssel wird nie ausgegeben');
});

test('ChatGPT-Anbindung: Geheimnis-Dateien werden nie gesendet, fehlender Schlüssel/Modell stoppt', async (t) => {
  const api = await mockOpenAI(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-test-'));
  for (const name of ['.env', 'server.key', 'auth-pepper.key', 'druckplatte.sqlite']) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'GEHEIM=1');
    const res = await run(['--datei', file, 'Aufgabe'], { OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm', OPENAI_BASE_URL: api.baseUrl });
    assert.equal(res.code, 1, name);
    assert.match(res.err, /nicht gesendet/, name);
  }
  assert.equal(api.requests.length, 0, 'keine Anfrage an OpenAI');

  const noKey = await run(['Aufgabe'], { OPENAI_MODEL: 'm', OPENAI_BASE_URL: api.baseUrl });
  assert.equal(noKey.code, 1);
  assert.match(noKey.err, /OPENAI_API_KEY ist nicht gesetzt/);
  const noModel = await run(['Aufgabe'], { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: api.baseUrl });
  assert.equal(noModel.code, 1);
  assert.match(noModel.err, /OPENAI_MODEL ist nicht gesetzt/);

  const models = await run(['--modelle'], { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: api.baseUrl });
  assert.equal(models.code, 0, models.err);
  assert.deepEqual(models.out.trim().split('\n'), ['modell-a', 'modell-b']);
});
