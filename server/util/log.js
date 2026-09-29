'use strict';

// Tokens, Codes und Cookies werden nie bewusst geloggt. Als zusätzliches Sicherheitsnetz
// werden lange base64url-Zeichenketten (Token-Format) vor der Ausgabe geschwärzt.
const TOKEN_LIKE = /[A-Za-z0-9_-]{40,}/g;

function redact(value) {
  return String(value).replace(TOKEN_LIKE, '[redacted]');
}

function createLogger(sink = console) {
  function write(level, msg, meta) {
    const line = meta ? `${msg} ${JSON.stringify(meta)}` : msg;
    sink[level === 'error' ? 'error' : 'log'](`[${level}] ${redact(line)}`);
  }
  return {
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
  };
}

const silentLogger = { info() {}, warn() {}, error() {} };

module.exports = { createLogger, silentLogger, redact };
