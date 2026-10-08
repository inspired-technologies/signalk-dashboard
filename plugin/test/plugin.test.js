const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const pluginFactory = require('../index');
const { createApp } = require('./helpers/stubs');

// Baseline checks: everything the SignalK server expects from a plugin module
// has to be in place without touching InfluxDB, Grafana or the file system.
describe('plugin', () => {
  it('exposes the required plugin interface', () => {
    const plugin = pluginFactory(createApp());

    assert.equal(plugin.id, 'signalk-dashboard');
    assert.equal(typeof plugin.name, 'string');
    assert.ok(plugin.name.length > 0);
    assert.equal(typeof plugin.start, 'function');
    assert.equal(typeof plugin.stop, 'function');
    assert.equal(typeof plugin.schema, 'object');
  });

  it('describes all configuration groups in its schema', () => {
    const { schema } = pluginFactory(createApp());

    assert.equal(schema.type, 'object');
    assert.deepEqual(
      Object.keys(schema.properties),
      ['hosts', 'upload', 'influx', 'grafana', 'descriptions']
    );
    assert.deepEqual(schema.properties.hosts.required, ['signalk', 'influx']);
    assert.deepEqual(schema.properties.upload.required, ['pathConfig', 'frequency']);
    assert.deepEqual(
      schema.properties.influx.required,
      ['uri', 'token', 'org', 'signalk', 'telegraf']
    );
    assert.equal(schema.properties.upload.properties.pathConfig.default, 'pathconfig.json');
    assert.equal(schema.properties.upload.properties.frequency.default, 30);
    assert.equal(schema.properties.grafana.properties.autostart.default, false);
    assert.equal(schema.properties.descriptions.type, 'array');
  });

  it('stops cleanly when it was never started', () => {
    const app = createApp();
    const plugin = pluginFactory(app);

    plugin.stop();

    assert.deepEqual(app.errors, []);
    assert.equal(app.unsubscribed, 0);
  });
});
