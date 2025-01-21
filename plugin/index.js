/*
    Copyright © 2025 Inspired Technologies GmbH (www.inspiredtechnologies.eu)
 
    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.
*/

const { DateTime } = require('luxon');
const { getSourceId } = require('@signalk/signalk-schema')
const path = require('path')
const influx = require('./influx');
const convert = require("./skunits")
let initialized = false;
let overwriteTimeWithNow = false;
let metrics = []
let descriptions = []
let unsubscribes = [
  influx.flush
]
influx.buffer(metrics)

let config = [
  { metric: "label.vessel.description.name", path: "name" },
  { metric: "label.vessel.description.mmsi", path: "mmsi" }
]
let hosts = [
  { metric: "label.host.description.signalk", path: "signalk" },
  { metric: "label.host.description.influx", path: "influx" },
]
let buckets = [
  { metric: "label.bucket.description.signalk", path: "signalk" },
  { metric: "label.bucket.description.telegraf", path: "telegraf" }
]

let influxConfig = {}
let updates = {}
let timer

function updateVal(path, time, interval) {
  return updates[path] && updates[path]!==null ? (time-updates[path])>interval : true;
}

function source(update) {
  if (update['$source']) {
    return update['$source']
  } else if (update['source']) {
    return getSourceId(update['source'])
  }
  return ''
}

function addnewpath (path, dynamicpath, log)
{    
  if (influxConfig.pathConfig[dynamicpath] || influxConfig.valueConfig[dynamicpath]) {
    let item = path.replace(dynamicpath.split('*')[0], '').replace(dynamicpath.split('*')[1], '')
    if (influxConfig.pathConfig[dynamicpath])
      influxConfig.pathConfig[path] = influxConfig.pathConfig[dynamicpath].replace('*', item)
    if (influxConfig.valueConfig[dynamicpath])
      influxConfig.valueConfig[path] = influxConfig.valueConfig[dynamicpath].replace('*', item)
    log(`New '${item}' for path '${dynamicpath}' identified and subscribed!`)
  }
}

module.exports = (app) => {
  const plugin = {
    id: 'signalk-dashboard',
    name: 'SignalK to Grafana Dashboard',
    start: (settings, restartPlugin) => {
      // startup -> update InfluxDB
      debug("Plugin starting");
      app.setPluginStatus("starting");
      // init Host & Bucket Metrics from settings
      hosts.forEach(h => {
        const metric = influx.format(h.metric, settings.hosts[h.path], DateTime.utc(), '')
        if (metric!==null)
          metrics.push(metric)
      })
      buckets.forEach(h => {
        const metric = influx.format(h.metric, settings.influx[h.path], DateTime.utc(), '')
        if (metric!==null)
          metrics.push(metric)
      })
      settings.descriptions.forEach(d => {
        let path = `label.${d.measurement}.description.${d.label}`
        let metric = influx.format(`${path}`, d.field, DateTime.utc(), '')
        if (metric!==null)
          metrics.push(metric)
        path = `label.${d.measurement}.${d.label}.description`
        metric = influx.format(`${path}.min`, d.min, DateTime.utc(), '')
        if (typeof d.min==='number' && metric!==null)
          metrics.push(metric)
        metric = influx.format(`${path}.norm`, d.norm, DateTime.utc(), '')
        if (typeof d.norm==='number' && metric!==null)
          metrics.push(metric)
        metric = influx.format(`${path}.max`, d.max, DateTime.utc(), '')
        if (typeof d.max==='number' && metric!==null)
          metrics.push(metric)
      })
      // init Influx connection
      influxConfig = {
        id: app.getSelfPath('mmsi') ? app.getSelfPath('mmsi') : app.getSelfPath('uuid'),
        organization: settings.influx.org,
        bucket: settings.influx.signalk,
        cacheDir: app.getDataDirPath(),
        frequency: settings.upload.frequency,
        retention: settings.influx.retention
      }
      const influxDB = influx.login({
        url: settings.influx.uri,         // get from options
        token: settings.influx.token,     // get from options
        timeout: 10 * 1000,               // 10sec timeout for health check
      }, influxConfig.cacheDir, debug)
      initialized = influx.health(influxDB, debug, (influxDB, result) => {
        if (initialized && result.status === 'pass' ) {
          app.debug({
            influx: settings.influx.uri,
            organization: settings.influx.org,
            buckets: {
              signalk: settings.influx.signalk,
              telegraf: settings.influx.telegraf
            }
          })
          app.setPluginStatus('Initialized');
          app.debug('Plugin initialized - sending metrics');

          config.forEach(c => {
            let value = app.getSelfPath(c.path)
            const metric = influx.format(c.metric, value, DateTime.utc(), '')
            if (metric!==null)
              metrics.push(metric)
          })
      
          timer = setInterval( (debug) => {
              app.debug (`Uploading ${metrics.length} data points to Influx`)
              if (metrics.length !== 0) {
                  influx.post(influxDB, metrics, influxConfig, debug)
                  metrics.forEach(m => descriptions.push(m))
                }
              updates["descriptions"] = DateTime.utc().toMillis()
              metrics = []
              clearInterval(timer); 

              // Restart time for uploading to influx
              timer = setInterval(() => {
                app.debug (`Sending ${metrics.length} data points to be uploaded to influx`)
                if (metrics.length !== 0) {
                    influx.post(influxDB, metrics, influxConfig, app.debug)
                    influx.buffer(metrics)
                    metrics = []
                }
              }, influxConfig.frequency*1000)
              app.debug (`Interval started, upload frequency: ${influxConfig.frequency}s`)
              
              // Get data only for self context
              app.subscriptionmanager.subscribe (
                {
                  context: 'vessels.self', 
                  subscribe: influxConfig.paths
                },
                unsubscribes,
                subscriptionError => {
                    app.error('Error:' + subscriptionError);
                },
                delta => {
                    if (!delta.updates) 
                      return;
                    delta.updates.forEach(u => {
                        // ignore undefined or null value
                        if (!u.values || !u.values[0].path || u.values[0].value===null || 
                            (typeof u.values[0].value==="object" && Object.keys(u.values[0].value)===0)) {
                            return;
                        }
                        // copy new paths configs
                        if (!influxConfig.pathConfig[u.values[0].path])
                        {
                          let dynpath = influx.match(influxConfig.paths.map(p => p.path), u.values[0].path)
                          addnewpath(u.values[0].path, dynpath, app.debug)
                        }
                        // read delta
                        const path = influxConfig.pathConfig[u.values[0].path] ? influxConfig.pathConfig[u.values[0].path] : u.values[0].path
                        const values = !influxConfig.valueConfig[u.values[0].path] ? u.values[0].value : 
                            convert.toTarget(influxConfig.valueConfig[u.values[0].path].split('|>')[0], u.values[0].value, influxConfig.valueConfig[u.values[0].path].split('|>')[1]).value
                        let timestamp = overwriteTimeWithNow ? DateTime.utc() : DateTime.fromISO(u.timestamp).toUTC()
                        // decide on descriptions to be updated
                        if (initialized && descriptions.length>0 && updateVal("descriptions", timestamp.toMillis(), 
                            influxConfig.retention*3600*1000-2*influxConfig.frequency*1000))
                            {
                              descriptions.forEach(d => metrics.push(d))
                              updates["descriptions"] = DateTime.utc().toMillis()                      
                            }
                        // decide on metrics to be recorded
                        if (initialized && values!==null && updateVal(path, timestamp.toMillis(), 1000))
                        {
                            updates[path] = timestamp.toMillis()
                            if (influxConfig.valueConfig[u.values[0].path] && influxConfig.valueConfig[u.values[0].path].split('|>')[1]==='latLng') {
                              const metric = influx.format(path, JSON.stringify(values), timestamp, source(u))
                              const longitude = influx.format(path+'.lon', values[0], timestamp, source(u))
                              const latitude = influx.format(path+'.lat', values[1], timestamp, source(u))
                              if (metric!==null && latitude!==null && longitude!==null) {
                                metrics.push(metric)
                                metrics.push(latitude)
                                metrics.push(longitude)
                              }
                            } else {
                              const metric = influx.format(path, values, timestamp, source(u))
                              if (metric!==null)
                                metrics.push(metric)
                            }
                        }
                    })
                }
              );
              app.setPluginStatus('Started');
              app.debug('Plugin started');
            }, 5000, debug);        

          return true
        }
        else
        {
          app.setPluginError('Failed to connect to Influx');
          return false
        }
      })
      // init path configuration          
      influxConfig.pathConfig = {}
      influxConfig.valueConfig = {}
      if (!settings.upload.pathConfig || !influx.check(app.getDataDirPath(), settings.upload.pathConfig)) 
      {   
        settings.upload.pathConfig = 'pathconfig.json'
        configFile = influx.save(app.getDataDirPath(), settings.upload.pathConfig, [])
        app.savePluginOptions(settings, () => {app.debug('Plugin options saved')});
      }
      influxConfig.paths = influx.config(
        settings.upload.pathConfig.includes('/') ? settings.upload.pathConfig : 
        path.join(app.getDataDirPath(), settings.upload.pathConfig), 
        settings.upload.frequency)
      influxConfig.paths.forEach(p => {
        if (p.hasOwnProperty('config'))
            influxConfig.pathConfig[p.path] = influx.reconfig(p.path, p.config)
        if (p.hasOwnProperty('convert'))
            influxConfig.valueConfig[p.path] = p.convert
        updates[influxConfig.pathConfig[p.path] ? influxConfig.pathConfig[p.path] : p.path] = null
      })
    },
    stop: () => {
      unsubscribes.forEach(f => f());
      unsubscribes = [];
      // shutdown -> remove ???
      debug("stopping");
      timer && clearInterval(timer);
      debug("stopped");
    },
    schema: {
      type: 'object',
      title: 'Export to InfluxDB & Grafana',
      description: "Provide configuration information",
      properties: {
          hosts: {
            type: "object",
            title: "Host Configuration",
            required: ['signalk', 'influx'],
            properties: {
              signalk: {
                type: 'string',
                title: 'SignalK Server',
                description: 'Hostname as captured by Telegraf'
              },
              influx: {
                type: 'string',
                title: 'InfluxDB Server',
                description: 'Hostname as captured by Telegraf'
              }
            },
          },
          upload: {
            type: "object",
            title: "Upload Configuration",
            required: ['pathConfig', 'frequency'],
            properties: {
              pathConfig: {
                type: 'string',
                title: 'Path Configuration',
                description: 'config file in plugin data directory',
                default: 'pathconfig.json'
              },
              frequency: {
                type: 'number',
                title: 'Write Interval',
                description: 'frequency of batched write to InfluxDB in s',
                default: 30
              },
            },
          },
          influx: {
            type: "object",
            title: "InfluxDB Connection",
            required: ['uri', 'token', 'org', 'signalk', 'telegraf'],
            properties: {
              uri: {
                type: 'string',
                title: 'InfluxDB URI'
              },
              token: {
                  type: 'string',
                  title: 'InfluxDB Token',
                  description: 'v2.x: [token]; V1.11.x: [username:password]'
              },
              org: {
                  type: 'string',
                  title: 'InfluxDB Organisation',
                  description: 'v2.x: [required]; V1.11.x: [empty]'
              },
              signalk: {
                  type: 'string',
                  title: 'SignalK Metrics Bucket',
                  description: 'v2.x: [bucket]; v1.11.x: [database/retentionpolicy]',
                  default: 'signalk_metrics'
              },
              telegraf: {
                  type: 'string',
                  title: 'Telegraf Metrics Bucket',
                  description: 'v2.x: [bucket]; v1.11.x: [database/retentionpolicy]',
                  default: 'infra_metrics'
              },
              retention: {
                  type: 'number',
                  title: 'SignalK Bucket Retention',
                  description: 'Configured retention period in hours',
                  default: 24
              }
            },
          },
          descriptions: {
            type: 'array',
            default: [],
            title: 'Meta data for measurements',
            items: {
              type: 'object',
              required: ['measurement', 'label', 'field'],
              properties: {
                measurement: {
                  title: 'Measurement',
                  type: 'string',
                  enum: [
                    'engines',
                    'sails',
                    'batteries',
                    'tanks',
                    'solars',
                    'anchors'                 
                  ]
                },
                label: {
                  title: 'Label',
                  type: 'string',                  
                },
                field: {
                  title: 'Field',
                  type: 'string',
                  default: 'value'
                },
                min: {
                  title: 'Minimum Value',
                  type: 'number',     
                  default: 0             
                },
                norm: {
                  title: 'Target Value',
                  type: 'number',
                },
                max: {
                  title: 'Max Value',
                  type: 'number',
                },
              }
            }
          }
      }
    }
  };

  const debug = require("debug")(plugin.id);
  
  return plugin;
};


// function log(msg) { app.debug(msg); }

  /*
  if (sails.init(props.sails, pluginId, props.putToken, props.deltaInterval, log))
  {
    sails.update(props, app.savePluginOptions, restartPlugin)
    registered = sails.register(app.registerPutHandler, props.sails, { read: app.getSelfPath, publish: sendDelta }, { delta: sendDelta, meta: sendMeta}, app.setPluginStatus)
  }
  else
    app.setPluginError('Error initializing plugin');


    timer = setInterval(_ => {
      const values = registered ? sails.config(sails.list(true)) : 
      (props.sails || []).map(sail => {
        return {
          path: "sails." + sail.label,
          value: sail.state && sail.state > 0 ? 
            {
              reduced: sail.states[sail.state-1].value!=0,
              reefs: sail.state-1,
              furledRatio: 1-sail.states[sail.state-1].value
            }
          : null
        };
      });
      sendDelta(values);
    }, props.deltaInterval * 1000);
    */

   /*
   * 
   * @param {Array<[{path:path, value:value}]>} values 
   *
     function sendDelta(values) {
      app.handleMessage(pluginId, {
          updates: [
              {
                  values: values
              }
          ]
      });
  }

  function sendMeta(units) {
      app.handleMessage(pluginId, {
          updates: [
              {
                  meta: units
              }
          ]   
      })
  }
  */