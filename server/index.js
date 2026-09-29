'use strict';

const http = require('node:http');
const { loadConfig } = require('./config');
const { createApp } = require('./app');
const { HOUR_MS } = require('./util/time');

const config = loadConfig();
const app = createApp({ config });
const server = http.createServer(app.handler);

app.runMaintenance();
const maintenance = setInterval(() => app.runMaintenance(), HOUR_MS);
maintenance.unref();

server.listen(config.port, config.host, () => {
  console.log(`[info] Druckplatte (${config.env}) läuft auf http://${config.host}:${config.port} – Daten: ${config.dataDir}`);
  console.log('[info] Mailversand: nur lokaler Dev-Postausgang (MAIL_PRODUCTION_ENABLED=false). Keine Druckersteuerung in diesem Build.');
});

function shutdown() {
  server.close(() => {
    app.close();
    process.exit(0);
  });
  setTimeout(() => {
    app.close();
    process.exit(0);
  }, 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
