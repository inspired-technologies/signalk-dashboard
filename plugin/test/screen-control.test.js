const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pluginFactory = require('../index');
const grafana = require('../grafana');
const { createInfluxStub, createApp, waitFor, sleep, lines } = require('./helpers/stubs');

const HOUR = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();

function settings(uri, screen) {
  return {
    hosts: { signalk: 'sk-host', influx: 'influx-host' },
    upload: { pathConfig: 'pathconfig.json', frequency: 1 },
    influx: { uri, token: 'test-token', org: 'test-org', signalk: 'signalk_metrics', telegraf: 'infra_metrics', retention: 24 },
    grafana: { autostart: false, screen },
    descriptions: [],
  };
}

// grafana.set / get replaced - no shell commands in tests
function stubScreen() {
  const calls = { set: [], get: 0, backlight: undefined };
  const original = { set: grafana.set, get: grafana.get };
  grafana.set = (param, value, callback, force) => {
    calls.set.push({ value, force: !!force });
    calls.backlight = value;
    callback(value);
  };
  grafana.get = (param, callback) => {
    calls.get += 1;
    callback(calls.backlight);
  };
  calls.restore = () => Object.assign(grafana, original);
  return calls;
}

describe('screen control', () => {
  const recorded = { writes: [], unexpected: [] };
  let dataDir;
  let server;
  let plugin;
  let calls;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-dashboard-'));
    fs.writeFileSync(path.join(dataDir, 'pathconfig.json'), '[]');
    server = createInfluxStub(recorded, 'fail');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(() => {
    if (plugin) plugin.stop();
    plugin = null;
    if (calls) calls.restore();
    calls = null;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('sets the brightness without influx and restores a backlight changed by something else', async () => {
    calls = stubScreen();
    const now = Date.now();
    // daylight from an hour ago to an hour ahead - daytime brightness
    const selfPaths = {
      'environment.sunlight.times.sunrise': { value: iso(now - HOUR), $source: 'openweather-signalk' },
      'environment.sunlight.times.sunset': { value: iso(now + HOUR), $source: 'openweather-signalk' },
    };
    const app = createApp({ dataDir, selfPaths });
    plugin = pluginFactory(app);
    plugin.start(settings(`http://127.0.0.1:${server.address().port}`, { brightness: true, daytime: 200, nighttime: 20 }), () => {});

    await waitFor(() => calls.set.length > 0, 'the brightness to be set');
    assert.deepEqual(calls.set[0], { value: 200, force: false });
    await waitFor(() => app.errors.length > 0, 'the influx error');
    assert.match(app.errors[0], /Failed to connect to Influx.*screen control only/);
    assert.equal(app.subscription, null);

    // the backlight is reset by something else - restored at the next read back (every 10 minutes)
    calls.backlight = 255;
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 11 * 60 * 1000;
      await waitFor(() => calls.set.length > 1, 'the brightness to be restored');
    } finally {
      Date.now = realNow;
    }
    assert.equal(calls.get >= 1, true);
    assert.deepEqual(calls.set[1], { value: 200, force: true });
  });

  it('keeps the brightness without sunrise / sunset', async () => {
    calls = stubScreen();
    const app = createApp({ dataDir, selfPaths: {} });
    plugin = pluginFactory(app);
    plugin.start(settings(`http://127.0.0.1:${server.address().port}`, { brightness: true, daytime: 200, nighttime: 20 }), () => {});
    await sleep(7000);
    assert.deepEqual(calls.set, []);
  });

  it('does not subscribe when stopped before the influx health check completed', async () => {
    const ok = createInfluxStub({ writes: [], unexpected: [] }, 'pass');
    await new Promise((resolve) => ok.listen(0, '127.0.0.1', resolve));
    try {
      const app = createApp({ dataDir });
      plugin = pluginFactory(app);
      plugin.start(settings(`http://127.0.0.1:${ok.address().port}`), () => {});
      plugin.stop();
      await sleep(6500);
      assert.equal(app.subscription, null);
      assert.deepEqual(app.statuses, ['starting']);
    } finally {
      await new Promise((resolve) => ok.close(resolve));
    }
  });
});

describe('sunrise / sunset upload', () => {
  const recorded = { writes: [], unexpected: [] };
  let dataDir;
  let server;
  let plugin;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-dashboard-'));
    fs.writeFileSync(path.join(dataDir, 'pathconfig.json'), '[]');
    server = createInfluxStub(recorded, 'pass');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    if (plugin) plugin.stop();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('prefers derived-data and uploads on change only', async () => {
    const derived = new Date('2026-11-16T06:20:00.000Z');
    const selfPaths = {
      // several sources: the server selects openweather, derived-data is preferred
      'environment.sunlight.times.sunrise': {
        value: '2026-11-16T06:25:00.000Z', $source: 'openweather-signalk',
        values: { 'openweather-signalk': { value: '2026-11-16T06:25:00.000Z' }, 'derived-data': { value: derived } },
      },
    };
    const app = createApp({ dataDir, selfPaths });
    plugin = pluginFactory(app);
    plugin.start(settings(`http://127.0.0.1:${server.address().port}`), () => {});

    const sunrises = () => lines(recorded).filter((line) => line.includes('sunrise='));
    await waitFor(() => sunrises().length > 0, 'sunrise to be written');
    assert.ok(sunrises()[0].includes('source=derived-data'));
    assert.ok(sunrises()[0].includes(`sunrise="${derived.toISOString()}"`), sunrises()[0]);

    // unchanged - not uploaded again on the following ticks
    await sleep(3000);
    assert.equal(sunrises().length, 1);

    // changed - uploaded
    selfPaths['environment.sunlight.times.sunrise'].values['derived-data'] = { value: new Date('2026-11-17T06:21:00.000Z') };
    await waitFor(() => sunrises().length === 2, 'the new sunrise to be written');
  });
});

describe('board switching', () => {
  it('shows the default board for a state without board instead of throwing', () => {
    grafana.init({
      launch: { command: 'chromium-browser', params: '' },
      dashboard: { server: 'http://grafana', idle: 'idle', params: '' },
      boards: [{ state: 'moored', uid: 'moored', params: '' }],
    }, () => {}, () => {}, () => {});
    let switched = false;
    // on the default board (tab 0) - nothing to switch, no shell command
    assert.doesNotThrow(() => grafana.next('anchored', () => { switched = true; }));
    assert.equal(switched, false);
  });
});
