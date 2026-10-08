const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pluginFactory = require('../index');
const { createInfluxStub, createApp, waitFor, sleep } = require('./helpers/stubs');

// Startup behaviour when no path configuration exists yet and InfluxDB
// reports that it is not ready.
describe('plugin startup', () => {
  const recorded = { writes: [], unexpected: [] };

  let dataDir;
  let server;
  let app;
  let options;
  let plugin;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-dashboard-'));
    server = createInfluxStub(recorded, 'fail');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    app = createApp({ dataDir, selfPaths: { uuid: 'urn:mrn:signalk:uuid:test-vessel' } });
    options = {
      hosts: { signalk: 'sk-host', influx: 'influx-host' },
      upload: { frequency: 1 },
      influx: {
        uri: `http://127.0.0.1:${server.address().port}`,
        token: 'test-token',
        org: 'test-org',
        signalk: 'signalk_metrics',
        telegraf: 'infra_metrics',
        retention: 24,
      },
      grafana: { autostart: false },
      descriptions: [],
    };
    plugin = pluginFactory(app);
    plugin.start(options, () => {});
  });

  after(async () => {
    plugin.stop();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates a default path configuration and persists it in the options', () => {
    assert.equal(options.upload.pathConfig, 'pathconfig.json');

    const configFile = path.join(dataDir, 'pathconfig.json');
    assert.ok(fs.existsSync(configFile));
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), []);

    assert.deepEqual(app.savedOptions, [options]);
    assert.deepEqual(app.statuses, ['starting']);
  });

  it('reports an error and does not subscribe while influx is unhealthy', async () => {
    await waitFor(() => app.errors.length > 0, 'the connection error to be reported');

    assert.ok(app.errors.some((e) => /Failed to connect to Influx/i.test(e)));
    assert.equal(app.subscription, null);
    assert.deepEqual(app.statuses, ['starting']);

    await sleep(1500);
    assert.deepEqual(recorded.writes, []);
    assert.deepEqual(recorded.unexpected, []);
  });

  it('stops cleanly after a failed startup', () => {
    plugin.stop();

    assert.equal(app.unsubscribed, 0);
    assert.ok(fs.existsSync(path.join(dataDir, 'pathconfig.json')));
  });
});
