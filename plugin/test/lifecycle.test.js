const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pluginFactory = require('../index');
const {
  createInfluxStub,
  createApp,
  waitFor,
  sleep,
  delta,
  lines,
} = require('./helpers/stubs');

const MMSI = '211234567';

// Subset of pathconfig.sample.json, covering a plain path, a renamed path,
// a wildcard path, a value conversion and a position conversion.
const PATHCONFIG = [
  { path: 'navigation.position', policy: 'instant', config: 'navigation.position|>navigation.vessel.position', convert: '{lon,lat}|>latLng', minPeriod: 10000 },
  { path: 'environment.sunlight.times.sunrise', policy: 'fixed', period: 3600000, convert: 'dt|>influx', config: 'sunlight.times|>forecast.time' },
  { path: 'environment.sunlight.times.sunset', policy: 'fixed', period: 3600000, convert: 'dt|>influx', config: 'sunlight.times|>forecast.time' },
  { path: 'environment.*.temperature', policy: 'instant', minPeriod: 10000 },
  { path: 'environment.*.relativeHumidity', policy: 'instant', config: 'relativeHumidity|>humidity', minPeriod: 10000 },
  { path: 'electrical.batteries.*.voltage', policy: 'instant', config: 'label.~:electrical.batteries|>batteries', minPeriod: 10000 },
];

describe('plugin lifecycle', () => {
  const recorded = { writes: [], unexpected: [] };
  // the server returns plain values for vessel identifiers and value objects for data paths
  const selfPaths = {
    mmsi: MMSI,
    name: 'Test Vessel',
    communication: { callsignVhf: 'DX1234' },
    'environment.sunlight.times.sunrise': { value: '2026-10-08T05:30:00.000Z', $source: 'sun.almanac' },
    'environment.sunlight.times.sunset': { value: '2026-10-08T17:45:00.000Z', $source: 'sun.almanac' },
  };

  let dataDir;
  let server;
  let baseUrl;
  let app;
  let options;
  let plugin;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-dashboard-'));
    fs.writeFileSync(path.join(dataDir, 'pathconfig.json'), JSON.stringify(PATHCONFIG));
    server = createInfluxStub(recorded);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    options = {
      hosts: { signalk: 'sk-host', influx: 'influx-host' },
      upload: { pathConfig: 'pathconfig.json', frequency: 1 },
      influx: {
        uri: baseUrl,
        token: 'test-token',
        org: 'test-org',
        signalk: 'signalk_metrics',
        telegraf: 'infra_metrics',
        retention: 24,
      },
      grafana: { autostart: false },
      descriptions: [
        { measurement: 'batteries', label: 'house', field: 'House Battery', min: 11.5, norm: 12.8, max: 14.4 },
      ],
    };
    app = createApp({ dataDir, selfPaths });
    plugin = pluginFactory(app);
  });

  after(async () => {
    plugin.stop();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('starts, connects to influx and subscribes to self', async () => {
    plugin.start(options, () => {});

    assert.deepEqual(app.statuses.slice(0, 1), ['starting']);
    await waitFor(() => app.subscription !== null, 'subscription to be registered');

    assert.deepEqual(app.statuses.slice(0, 2), ['starting', 'Initialized']);
    assert.match(app.statuses[2], /^Started - metadata published \d\d:\d\d$/);
    assert.equal(app.statuses.length, 3);
    assert.deepEqual(app.errors, []);
    // an existing path configuration is used as is
    assert.deepEqual(app.savedOptions, []);
    assert.equal(app.subscription.context, 'vessels.self');

    const subscribed = app.subscription.subscribe.map((p) => p.path);
    assert.deepEqual(subscribed, PATHCONFIG.map((p) => p.path));
    assert.equal(typeof app.onDelta, 'function');
  });

  it('uploads host, bucket, description and vessel metrics', async () => {
    await waitFor(() => recorded.writes.length > 0, 'metrics to be written to influx');

    const write = recorded.writes[0];
    assert.equal(write.org, 'test-org');
    assert.equal(write.bucket, 'signalk_metrics');
    assert.equal(write.precision, 'ms');
    assert.equal(write.authorization, 'Token test-token');

    const find = (tag, field) => write.lines.find(
      (line) => line.startsWith('description,') && line.includes(tag) && line.includes(field)
    );
    // hosts and buckets come straight from the plugin options
    assert.ok(find('label=host', 'signalk="sk-host"'));
    assert.ok(find('label=host', 'influx="influx-host"'));
    assert.ok(find('label=bucket', 'signalk="signalk_metrics"'));
    assert.ok(find('label=bucket', 'telegraf="infra_metrics"'));
    // vessel identity is read from the server
    assert.ok(find('label=vessel', 'name="Test Vessel"'));
    assert.ok(find('label=vessel', `mmsi="${MMSI}"`));
    assert.ok(find('label=vessel', 'callsign="DX1234"'));
    // measurement meta data is double tagged
    assert.ok(find('label=house', 'batteries="House Battery"'));
    const min = find('type=batteries', 'min=11.5');
    assert.ok(min, `no minimum description in ${write.lines.join(' | ')}`);
    assert.ok(min.includes('label=house'));
    assert.ok(find('type=batteries', 'norm=12.8'));
    assert.ok(find('type=batteries', 'max=14.4'));
    // the vessel id is tagged onto every single point
    assert.ok(write.lines.every((line) => line.includes(`id=${MMSI}`)));
  });

  it('uploads sunrise and sunset converted to influx timestamps', async () => {
    await waitFor(
      () => lines(recorded).some((line) => line.startsWith('time,')),
      'sunlight times to be written to influx'
    );

    const sunrise = lines(recorded).find((line) => line.includes('sunrise='));
    assert.ok(sunrise.startsWith('time,'));
    assert.ok(sunrise.includes('environment=forecast'));
    assert.ok(sunrise.includes('source=sun.almanac'));
    assert.ok(sunrise.includes(`sunrise=${new Date('2026-10-08T05:30:00.000Z').getTime() * 1000 * 1000}`));

    const sunset = lines(recorded).find((line) => line.includes('sunset='));
    assert.ok(sunset.includes(`sunset=${new Date('2026-10-08T17:45:00.000Z').getTime() * 1000 * 1000}`));
  });

  it('forwards subscribed deltas to influx', async () => {
    app.onDelta(delta('environment.outside.temperature', 288.15));
    app.onDelta(delta('electrical.batteries.house.voltage', 12.6));

    await waitFor(
      () => lines(recorded).some((line) => line.startsWith('temperature,')),
      'delta values to be written to influx'
    );
    await waitFor(
      () => lines(recorded).some((line) => line.startsWith('batteries,')),
      'battery values to be written to influx'
    );

    // a wildcard path is resolved into a tagged measurement
    const temperature = lines(recorded).find((line) => line.startsWith('temperature,'));
    assert.ok(temperature.includes('environment=outside'));
    assert.ok(temperature.includes('source=test.source'));
    assert.ok(temperature.includes(`id=${MMSI}`));
    assert.match(temperature, /value=288.15/);

    // the configured rotation turns the battery instance into a label tag
    const battery = lines(recorded).find((line) => line.startsWith('batteries,'));
    assert.ok(battery.includes('label=house'));
    assert.match(battery, /voltage=12.6/);
    assert.deepEqual(app.errors, []);
  });

  it('applies the configured path and value conversions', async () => {
    app.onDelta(delta('environment.outside.relativeHumidity', 0.56));
    app.onDelta(delta('navigation.position', { latitude: 54.3, longitude: 10.15 }));

    await waitFor(
      () => lines(recorded).some((line) => line.startsWith('humidity,')),
      'remapped humidity to be written to influx'
    );
    await waitFor(
      () => lines(recorded).filter((line) => line.startsWith('position,')).length >= 3,
      'position to be written to influx'
    );

    // relativeHumidity is remapped to humidity by the path configuration
    const humidity = lines(recorded).find((line) => line.startsWith('humidity,'));
    assert.ok(humidity.includes('environment=outside'));
    assert.match(humidity, /value=0.56/);

    // a position is written as a pair plus separate latitude and longitude
    const position = lines(recorded).filter((line) => line.startsWith('position,'));
    assert.ok(position.every((line) => line.includes('navigation=vessel')));
    assert.ok(position.some((line) => line.includes('value="[54.3,10.15]"')));
    assert.ok(position.some((line) => /lat=54.3/.test(line)));
    assert.ok(position.some((line) => /lon=10.15/.test(line)));
  });

  it('ignores deltas without a usable value', async () => {
    const before = lines(recorded).length;

    app.onDelta(delta('environment.inside.temperature', null));
    app.onDelta(delta('', 123));
    app.onDelta({ updates: [{ $source: 'test.source', timestamp: new Date().toISOString() }] });
    app.onDelta({});

    await sleep(2500);

    const written = lines(recorded).slice(before);
    assert.deepEqual(written.filter((line) => line.includes('environment=inside')), []);
    assert.deepEqual(app.errors, []);
    assert.deepEqual(recorded.unexpected, []);
  });

  it('stops, unsubscribes and no longer uploads', async () => {
    plugin.stop();
    assert.equal(app.unsubscribed, 1);

    // let any request that was still in flight arrive before counting
    await sleep(250);
    const before = recorded.writes.length;
    app.onDelta(delta('environment.outside.temperature', 290.15));
    await sleep(2500);

    assert.equal(recorded.writes.length, before);
    assert.deepEqual(app.errors, []);
  });
});
