const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// sample dashboards of the repository - not part of the npm package
const DIR = path.join(__dirname, '..', '..', 'grafana');
const META_VARS = ['signalk', 'telegraf', 'skhost', 'fhost', 'hosts', 'vessel', 'mmsi', 'state'];
const WINDOW = 'range(start: -${metawindow})';

const dashboards = fs.existsSync(DIR)
  ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => ({ file: f, json: JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) }))
  : [];
const boards = dashboards.filter((d) => d.file.startsWith('signalk-board-'));

// Grafana exports the classic JSON model (`templating`, `panels`) or, from Grafana 12,
// the v2 resource (`apiVersion: dashboard.grafana.app/v2`, `spec.variables`, `spec.elements`)
const isV2 = (d) => typeof d.json.apiVersion === 'string' && d.json.apiVersion.startsWith('dashboard.grafana.app/v2');
const V2_TYPES = { ConstantVariable: 'constant', DatasourceVariable: 'datasource', QueryVariable: 'query' };

// variables as { name, type, query, current }
function variables(d) {
  if (isV2(d))
    return (d.json.spec.variables || []).map((v) => ({
      name: v.spec.name,
      type: V2_TYPES[v.kind] || v.kind,
      query: typeof v.spec.query === 'string' ? v.spec.query : (v.spec.query && v.spec.query.spec && v.spec.query.spec.query) || v.spec.definition || '',
      current: v.spec.current,
    }));
  return ((d.json.templating && d.json.templating.list) || []).map((v) => ({
    name: v.name,
    type: v.type,
    query: typeof v.query === 'string' ? v.query : (v.query && v.query.query) || '',
    current: v.current,
  }));
}

// panel queries as { panel, query }
function targets(d) {
  if (isV2(d))
    return Object.values(d.json.spec.elements || {}).flatMap((e) => {
      const queries = (e.spec && e.spec.data && e.spec.data.spec && e.spec.data.spec.queries) || [];
      return queries.map((q) => ({ panel: e.spec.title, query: (q.spec && q.spec.query && q.spec.query.spec && q.spec.query.spec.query) || '' }));
    });
  const panels = [];
  const walk = (ps) => (ps || []).forEach((p) => { panels.push(p); walk(p.panels); });
  walk(d.json.panels);
  return panels.flatMap((p) => (p.targets || []).map((t) => ({ panel: p.title, query: t.query || '' })));
}

// data source references as "<type>:<uid>" (classic) or "<group>:<name>" (v2)
function datasources(d) {
  const refs = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (isV2(d) && o.datasource && typeof o.datasource.name === 'string') refs.push(`${o.group || 'datasource'}:${o.datasource.name}`);
    if (!isV2(d) && typeof o.uid === 'string' && o.type) refs.push(`${o.type}:${o.uid}`);
    Object.values(o).forEach(walk);
  };
  if (isV2(d)) {
    walk(d.json.spec.elements);
    walk(d.json.spec.variables);
    walk(d.json.spec.annotations);
  } else {
    walk(d.json.panels);
    walk(d.json.templating);
    walk(d.json.annotations);
  }
  return refs;
}

// pipelines of a flux query: range plus the measurement filter right after it
function pipelines(query) {
  return [...query.matchAll(/range\(([^)]*)\)\s*\|> filter\(fn: \(r\) => r(?:\["_measurement"\]|\._measurement) (==|!=) "([^"]+)"\)/g)]
    .map((m) => ({ range: m[1], op: m[2], measurement: m[3] }));
}

describe('sample dashboards', { skip: dashboards.length === 0 && 'grafana/ not available' }, () => {
  it('look up metadata over the metadata window, independent of the selected time range', () => {
    for (const d of boards) {
      assert.ok(variables(d).some((v) => v.name === 'metawindow' && v.type === 'constant'), `${d.file}: no metawindow constant`);
      const meta = variables(d).filter((v) => META_VARS.includes(v.name));
      assert.ok(meta.length > 0, `${d.file}: no metadata variables found`);
      for (const v of meta) {
        assert.ok(v.query.includes(WINDOW), `${d.file} variable ${v.name}: ${v.query}`);
        assert.ok(!v.query.includes('v.timeRangeStart'), `${d.file} variable ${v.name} still on the selected range`);
      }
      for (const t of targets(d))
        for (const p of pipelines(t.query).filter((p) => p.op === '==' && p.measurement === 'description'))
          assert.equal(p.range, 'start: -${metawindow}', `${d.file} panel '${t.panel}': description on ${p.range}`);
    }
  });

  it('keep measurement queries on the selected time range', () => {
    for (const d of boards) {
      const measured = targets(d).flatMap((t) => pipelines(t.query).filter((p) => p.measurement !== 'description').map((p) => ({ ...p, panel: t.panel })));
      assert.ok(measured.length > 0, `${d.file}: no measurement queries found`);
      for (const p of measured)
        assert.ok(!p.range.includes('metawindow'), `${d.file} panel '${p.panel}': ${p.measurement} on the metadata window`);
      assert.ok(measured.filter((p) => p.range.includes('v.timeRangeStart')).length >= measured.length / 2,
        `${d.file}: most measurement queries should follow the selected range`);
      const sources = variables(d).find((v) => v.name === 'sources');
      if (sources)
        assert.ok(sources.query.includes('v.timeRangeStart'), `${d.file}: sources should follow the selected range`);
    }
  });

  it('use the datasource variable and the bucket variables, no hard-coded UIDs or buckets', () => {
    for (const d of dashboards) {
      const refs = datasources(d);
      assert.ok(refs.length > 0, `${d.file}: no data source references found`);
      const hardCoded = refs.filter((u) => !u.endsWith(':${datasource}') && !/^(datasource|grafana):grafana$/.test(u));
      assert.deepEqual(hardCoded, [], `${d.file}: hard-coded data source UIDs`);
      const ds = variables(d).find((v) => v.type === 'datasource');
      assert.ok(!ds || !ds.current || !ds.current.value, `${d.file}: saved data source selection ${ds && JSON.stringify(ds.current)}`);
    }
    for (const d of boards) {
      const text = JSON.stringify(d.json);
      const buckets = [...text.matchAll(/from\(bucket: \\"([^"\\]+)\\"\)/g)].map((m) => m[1]).filter((b) => !b.startsWith('$'));
      assert.deepEqual(buckets, [], `${d.file}: hard-coded buckets`);
    }
  });
});
