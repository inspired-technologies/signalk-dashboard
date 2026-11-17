const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const pluginFactory = require('../index');
const { createApp, waitFor } = require('./helpers/stubs');

const MMSI = '211234567';

// influx stand-in: health passes, the first `failures` writes are rejected
function influxStub(recorded, failures = 0) {
  let rejected = 0;
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: 'influxdb', message: 'ready', status: 'pass', version: '2.7.0', checks: [] }));
        return;
      }
      const lines = body.split('\n').filter((l) => l !== '');
      if (rejected < failures) {
        rejected += 1;
        recorded.rejected.push(lines);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'internal error', message: 'test failure' }));
        return;
      }
      recorded.writes.push({ bucket: url.searchParams.get('bucket'), lines });
      res.writeHead(204);
      res.end();
    });
  });
}

const time = (line) => Number(line.split(' ').pop());
const bucketLines = (writes) => writes.flatMap((w) => w.lines).filter((l) => l.startsWith('description,') && l.includes('label=bucket') && l.includes('signalk='));

describe('descriptions (metadata for the dashboards)', () => {
  let server;
  let plugin;
  let dataDir;

  async function start(recorded, influx, selfPaths, failures = 0) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-dashboard-'));
    fs.writeFileSync(path.join(dataDir, 'pathconfig.json'), '[]');
    server = influxStub(recorded, failures);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const app = createApp({ dataDir, selfPaths });
    plugin = pluginFactory(app);
    plugin.start({
      hosts: { signalk: 'sk-host', influx: 'influx-host' },
      upload: { pathConfig: 'pathconfig.json', frequency: 1 },
      influx: Object.assign({ uri: `http://127.0.0.1:${server.address().port}`, token: 't', org: 'o' }, influx),
      grafana: { autostart: false },
      descriptions: [{ measurement: 'batteries', label: 'house', field: 'House Battery', norm: 12.8 }],
    }, () => {});
    return app;
  }

  afterEach(async () => {
    if (plugin) plugin.stop();
    plugin = null;
    if (server) await new Promise((resolve) => server.close(resolve));
    server = null;
  });

  it('republishes fresh points periodically without any incoming delta, to custom buckets', async () => {
    const recorded = { writes: [], rejected: [] };
    // retention of 1.8 s: republished every 0.45 s, ie. on every upload tick of 1 s
    const app = await start(recorded, { signalk: 'boat_data', telegraf: 'boat_infra', retention: 0.0005 }, { mmsi: MMSI, name: 'Test Vessel' });
    await waitFor(() => bucketLines(recorded.writes).length >= 3, 'three description uploads', 20000);

    assert.equal(app.onDelta !== null, true);
    assert.ok(recorded.writes.every((w) => w.bucket === 'boat_data'));
    const buckets = bucketLines(recorded.writes);
    assert.ok(buckets.every((l) => l.includes('signalk="boat_data"')));
    const times = buckets.map(time);
    for (let i = 1; i < times.length; i++)
      assert.ok(times[i] > times[i - 1], `timestamps not increasing: ${times}`);
    const lines = recorded.writes.flatMap((w) => w.lines);
    assert.ok(lines.filter((l) => l.includes('label=bucket') && l.includes('telegraf=')).every((l) => l.includes('telegraf="boat_infra"')));
    assert.ok(lines.some((l) => l.includes('label=vessel') && l.includes('name="Test Vessel"')));
    assert.ok(lines.some((l) => l.includes('type=batteries') && l.includes('norm=12.8')));
  });

  it('publishes hourly with the default retention and reports it on the plugin state', async () => {
    const recorded = { writes: [], rejected: [] };
    const app = await start(recorded, { signalk: 'signalk_metrics', telegraf: 'infra_metrics', retention: 24 }, { mmsi: MMSI });
    await waitFor(() => bucketLines(recorded.writes).length >= 1, 'first description upload', 20000);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(bucketLines(recorded.writes).length, 1);
    const status = app.statuses.at(-1);
    assert.match(status, /^Started - metadata published \d\d:\d\d \(no vessel name \/ callsign\)$/);
  });

  it('keeps the timestamp of queued points - the next upload carries new points', async () => {
    const recorded = { writes: [], rejected: [] };
    await start(recorded, { signalk: 'signalk_metrics', telegraf: 'infra_metrics', retention: 0.0005 }, { mmsi: MMSI }, 1);
    await waitFor(() => recorded.rejected.length === 1, 'first upload rejected', 20000);
    const failed = recorded.rejected[0].filter((l) => l.includes('label=bucket') && l.includes('signalk='));
    assert.equal(failed.length, 1);
    // the cached point is replayed unchanged, fresh points follow
    await waitFor(() => bucketLines(recorded.writes).length >= 2, 'replay and a fresh upload', 20000);
    const written = bucketLines(recorded.writes).map(time);
    assert.ok(written.includes(time(failed[0])), `cached point not replayed with its time: ${written} / ${time(failed[0])}`);
    assert.ok(written.some((t) => t > time(failed[0])), 'no fresh description after the failed upload');
  });
});
