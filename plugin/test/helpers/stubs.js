const http = require('node:http');
const assert = require('node:assert/strict');

// Minimal stand-in for InfluxDB 2.x. The plugin only talks to the health
// endpoint (via @influxdata/influxdb-client-apis) and to the line protocol
// write endpoint, so stubbing those two is enough to drive the complete
// plugin lifecycle from the command line without any running service.
function createInfluxStub(recorded, status = 'pass') {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          name: 'influxdb',
          message: status === 'pass' ? 'ready for queries and writes' : 'not ready',
          status,
          version: '2.7.0',
          commit: 'test',
          checks: [],
        }));
      } else if (req.method === 'POST' && url.pathname === '/api/v2/write') {
        recorded.writes.push({
          org: url.searchParams.get('org'),
          bucket: url.searchParams.get('bucket'),
          precision: url.searchParams.get('precision'),
          authorization: req.headers.authorization,
          lines: body.split('\n').filter((line) => line !== ''),
        });
        res.writeHead(204);
        res.end();
      } else {
        recorded.unexpected.push(`${req.method} ${url.pathname}`);
        res.writeHead(404);
        res.end();
      }
    });
  });
}

// Stand-in for the SignalK server app object. Every member used by index.js
// has to be present, otherwise the plugin fails at startup.
function createApp({ dataDir, selfPaths = {} } = {}) {
  const app = {
    statuses: [],
    errors: [],
    savedOptions: [],
    subscription: null,
    onDelta: null,
    unsubscribed: 0,
    debug: () => {},
    error: (msg) => app.errors.push(msg),
    setPluginStatus: (msg) => app.statuses.push(msg),
    setPluginError: (msg) => app.errors.push(msg),
    getDataDirPath: () => dataDir,
    getSelfPath: (p) => selfPaths[p],
    savePluginOptions: (options, callback) => {
      app.savedOptions.push(options);
      if (callback) callback();
    },
    subscriptionmanager: {
      subscribe: (subscription, unsubscribes, onError, onDelta) => {
        app.subscription = subscription;
        app.onDelta = onDelta;
        unsubscribes.push(() => {
          app.unsubscribed += 1;
        });
      },
    },
  };
  return app;
}

async function waitFor(condition, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${description}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delta(path, value, source = 'test.source') {
  return {
    updates: [
      {
        $source: source,
        timestamp: new Date().toISOString(),
        values: [{ path, value }],
      },
    ],
  };
}

// all line protocol lines collected so far, across every recorded write
function lines(recorded) {
  return recorded.writes.flatMap((w) => w.lines);
}

module.exports = {
  createInfluxStub,
  createApp,
  waitFor,
  sleep,
  delta,
  lines,
};
