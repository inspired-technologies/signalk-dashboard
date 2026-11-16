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
const cache = require('./cache');
const convert = require("./skunits")
const grafana = require('./grafana');
const screen = require('./screen');
const log = require('debug')('signalk-dashboard')

const NAVSTATE = 'navigation.state'
const SUNRISE = 'environment.sunlight.times.sunrise'
const SUNSET = 'environment.sunlight.times.sunset'
const SUN_SOURCE = 'derived-data'           // signalk-derived-data computes sunrise / sunset from position and time
const SUN_UPLOAD = 60 * 60 * 1000           // sunrise / sunset uploaded on change, otherwise hourly
const BACKLIGHT_CHECK = 10 * 60 * 1000      // backlight read back - restored when something else changed it
const START_DELAY = 5000                    // kiosk launch and first upload after start

const config = [
  { metric: "label.vessel.description.name", path: "name" },
  { metric: "label.vessel.description.mmsi", path: "mmsi" },
  { metric: "label.vessel.description.callsign", path: "communication", key: "callsignVhf" }
]
const hosts = [
  { metric: "label.host.description.signalk", path: "signalk" },
  { metric: "label.host.description.influx", path: "influx" }
]
const buckets = [
  { metric: "label.bucket.description.signalk", path: "signalk" },
  { metric: "label.bucket.description.telegraf", path: "telegraf" }
]

function source(update) {
  if (update['$source']) {
    return update['$source']
  } else if (update['source']) {
    return getSourceId(update['source'])
  }
  return ''
}

// ISO string of a sun time - strings as published, Date objects (derived-data) converted
function isoTime(value) {
  if (value instanceof Date)
    return isNaN(value.getTime()) ? undefined : value.toISOString()
  if (typeof value === 'string' && DateTime.fromISO(value).isValid)
    return value
  return undefined
}

// sunrise / sunset as { value, $source } - derived-data first, otherwise the value selected by the server
function sunTime(selfPath) {
  if (!selfPath)
    return undefined
  const derived = selfPath.values && selfPath.values[SUN_SOURCE]
  const candidates = derived ? [Object.assign({ $source: SUN_SOURCE }, derived), selfPath] : [selfPath]
  for (const candidate of candidates) {
    const value = isoTime(candidate.value)
    if (value)
      return { value, $source: source(candidate) }
  }
  return undefined
}

module.exports = (app) => {
  let metrics = []
  let descriptions = []
  let unsubscribes = []
  let influxConfig = {}
  let screenConfig = {}
  let valueCache = {}
  let updates = {}
  let uploaded = {}
  let currentState
  let kiosk = false
  let uploadTimer
  let screenTimer
  let startTimers = []
  let running = false         // guards the asynchronous influx health check against an early stop ...
  let generation = 0          // ... and against a check of a previous start completing after a restart
  let reported = ''
  let backlightChecked = 0

  function updateVal(path, time, interval) {
    return updates[path] && updates[path]!==null ? (time-updates[path])>interval : true;
  }

  function addnewpath (path, dynamicpath)
  {
    if (influxConfig.pathConfig[dynamicpath] || influxConfig.valueConfig[dynamicpath])
    {
      let item = path.replace(dynamicpath.split('*')[0], '').replace(dynamicpath.split('*')[1], '')
      if (influxConfig.pathConfig[dynamicpath])
        influxConfig.pathConfig[path] = influxConfig.pathConfig[dynamicpath].replace('*', item)
      if (influxConfig.valueConfig[dynamicpath])
        influxConfig.valueConfig[path] = influxConfig.valueConfig[dynamicpath].replace('*', item)
      log(`'${item}' for path '${dynamicpath}' identified and subscribed!`)
    } else if (dynamicpath!==path) {
      influxConfig.pathConfig[path] = path
      let item = path.replace(dynamicpath.split('*')[0], '').replace(dynamicpath.split('*')[1], '')
      log(`'${item}' for path '${dynamicpath}' identified!`)
    } else {
      influxConfig.pathConfig[path] = path
    }
  }

  // timer started for the current start only - cleared on stop
  function later(started, callback, delay) {
    const timer = setTimeout(() => {
      startTimers = startTimers.filter(t => t!==timer)
      if (running && started===generation)
        callback()
    }, delay)
    startTimers.push(timer)
  }

  // offline cache on the plugin state - from half of a limit (or once data was dropped) as error
  function reportCache() {
    const state = cache.usage(influxConfig.cacheDir)
    const message = state.files===0 ? 'Started' :
      (state.warning ? `Influx writes failing - offline cache ${state.message}` : `Started - offline cache ${state.message}`)
    if (message===reported)
      return
    reported = message
    if (state.warning)
      app.setPluginError(message)
    else
      app.setPluginStatus(message)
  }

  // last known sunrise / sunset - the server value may be missing for a while (source restarted, timeout)
  function sunTimes() {
    const sunrise = sunTime(app.getSelfPath(SUNRISE)) || valueCache[SUNRISE]
    const sunset = sunTime(app.getSelfPath(SUNSET)) || valueCache[SUNSET]
    if (sunrise) valueCache[SUNRISE] = sunrise
    if (sunset) valueCache[SUNSET] = sunset
    return { sunrise, sunset }
  }

  // sunrise / sunset to influx - on change, otherwise hourly
  function uploadSun(key, time) {
    if (!time)
      return
    const now = DateTime.utc()
    const path = influxConfig.pathConfig[key] ? influxConfig.pathConfig[key] : key
    if (uploaded[key]===time.value && !updateVal(path, now.toMillis(), SUN_UPLOAD))
      return
    const values = !influxConfig.valueConfig[key] ? time.value :
      convert.toTarget(influxConfig.valueConfig[key].split('|>')[0], time.value, influxConfig.valueConfig[key].split('|>')[1]).value
    const metric = influx.format(path, values, now, source(time))
    if (metric!==null) {
      metrics.push(metric)
      uploaded[key] = time.value
      updates[path] = now.toMillis()
    }
  }

  // navigation state → board, sunrise / sunset → brightness; independent of influx
  function screenTick() {
    const state = app.getSelfPath(NAVSTATE) || { value: 'default' }
    if (state && currentState && currentState !== state.value && state.value!==null) {
      const current = currentState
      grafana.next(state.value, () => {
        log(`Switched board from ${current} to ${state.value}`)
      })
      currentState = state.value
    }
    if (!screenConfig.enabled)
      return
    const { sunrise, sunset } = sunTimes()
    // sunrise / sunset of the local day - unknown times keep the current brightness
    const value = screen.brightness(DateTime.now(), sunrise && sunrise.value, sunset && sunset.value, screenConfig)
    if (value===undefined) {
      log('Screen brightness unchanged - no sunrise / sunset available')
      return
    }
    if (value!==screenConfig.brightness) {
      grafana.set('brightness', value, (val) => {
        log(`Screen brightness set to ${val}`)
        screenConfig.brightness = val
      })
      backlightChecked = Date.now()
    } else if (Date.now() - backlightChecked >= BACKLIGHT_CHECK) {
      // something else (display wake, kiosk restart) may have reset the backlight
      backlightChecked = Date.now()
      grafana.get('brightness', (actual) => {
        if (actual!==undefined && actual!==screenConfig.brightness) {
          log(`Backlight changed to ${actual} by something else - restoring ${screenConfig.brightness}`)
          grafana.set('brightness', screenConfig.brightness, () => {}, true)
        }
      })
    }
  }

  function startScreen(started) {
    if (kiosk) {
      grafana.check("launching grafana dashboard...", (status) => {
        grafana.launch(status, (pid) => {
          if (!running || started!==generation)
            return
          currentState = 'default'
          log(`Grafana dashboard launched with status: ${pid}`)
        })
      })
    }
    if (kiosk || screenConfig.enabled) {
      screenTimer = setInterval(screenTick, influxConfig.frequency*1000)
      log(`Screen control started, interval: ${influxConfig.frequency}s`)
    }
  }

  function uploadTick(influxDB) {
    if (metrics.length !== 0) {
      log(`Sending ${metrics.length} data points to be uploaded to influx`)
      influx.post(influxDB, metrics, influxConfig)
      influx.buffer(metrics)
      metrics = []
    }
    reportCache()
    const { sunrise, sunset } = sunTimes()
    uploadSun(SUNRISE, sunrise)
    uploadSun(SUNSET, sunset)
  }

  function onDelta(delta) {
    if (!Array.isArray(delta.updates))
      return;
    delta.updates.forEach(u => {
      // ignore undefined or null value and empty objects
      if (!Array.isArray(u.values) || u.values.length===0 || !u.values[0].path ||
          u.values[0].value===null || u.values[0].value===undefined ||
          (typeof u.values[0].value==="object" && Object.keys(u.values[0].value).length===0)) {
        return;
      }
      // copy new paths configs
      if (!influxConfig.pathConfig[u.values[0].path])
      {
        let dynpath = influx.match(influxConfig.paths.map(p => p.path), u.values[0].path)
        addnewpath(u.values[0].path, dynpath)
      }
      // read delta
      const path = influxConfig.pathConfig[u.values[0].path] ? influxConfig.pathConfig[u.values[0].path] : u.values[0].path
      const values = !influxConfig.valueConfig[u.values[0].path] ? u.values[0].value :
          convert.toTarget(influxConfig.valueConfig[u.values[0].path].split('|>')[0], u.values[0].value, influxConfig.valueConfig[u.values[0].path].split('|>')[1]).value
      let timestamp = DateTime.fromISO(u.timestamp).toUTC()
      // decide on descriptions to be updated
      if (descriptions.length>0 && updateVal("descriptions", timestamp.toMillis(),
          influxConfig.retention*3600*1000-2*influxConfig.frequency*1000))
      {
        descriptions.forEach(d => metrics.push(d))
        updates["descriptions"] = DateTime.utc().toMillis()
      }
      // decide on metrics to be recorded
      if (values!==null && updateVal(path, timestamp.toMillis(), 1000) && influxConfig.pathConfig[path]!=='ignore')
      {
        updates[path] = timestamp.toMillis()
        if (influxConfig.valueConfig[u.values[0].path] && influxConfig.valueConfig[u.values[0].path].split('|>')[1]==='latLng') {
          const metric = influx.format(path, JSON.stringify(values), timestamp, source(u))
          const latitude = influx.format(path+'.lat', values[0], timestamp, source(u))
          const longitude = influx.format(path+'.lon', values[1], timestamp, source(u))
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

  function startUpload(influxDB, result, started, settings) {
    if (!running || started!==generation) {
      log('Plugin stopped before influx health check completed - not subscribing')
      return false
    }
    if (!result || result.status !== 'pass') {
      const screenOnly = kiosk || screenConfig.enabled
      app.setPluginError(`Failed to connect to Influx${result && result.message ? ` (${result.message})` : ''}` +
        (screenOnly ? ' - dashboards and screen control only' : ''))
      return false
    }
    log({
      organization: settings.influx.org,
      buckets: {
        signalk: settings.influx.signalk,
        telegraf: settings.influx.telegraf
      }
    })
    app.setPluginStatus('Initialized');
    log('Plugin initialized - sending metrics');

    config.forEach(c => {
      let value = !c.hasOwnProperty("key") || !app.getSelfPath(c.path) ? app.getSelfPath(c.path) : app.getSelfPath(c.path)[c.key]
      if (value===undefined || value===null) {
        log(`No value for ${c.path} found, skipping config metric`)
        return
      }
      const metric = influx.format(c.metric, value, DateTime.utc(), '')
      if (metric!==null)
        metrics.push(metric)
    })

    later(started, () => {
      // first upload: host, bucket, vessel and measurement descriptions - republished within the retention
      log(`Uploading ${metrics.length} data points to Influx`)
      if (metrics.length !== 0) {
        influx.post(influxDB, metrics, influxConfig)
        metrics.forEach(m => descriptions.push(m))
      }
      updates["descriptions"] = DateTime.utc().toMillis()
      metrics = []

      uploadTimer = setInterval(() => uploadTick(influxDB), influxConfig.frequency*1000)
      log(`Interval started, upload frequency: ${influxConfig.frequency}s`)

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
        onDelta
      );
      app.setPluginStatus('Started');
      reported = 'Started'
      log('Plugin started');
    }, START_DELAY)
    return true
  }

  const plugin = {
    id: 'signalk-dashboard',
    name: 'SignalK to Grafana Dashboard',
    start: (settings, restartPlugin) => {
      log("Plugin starting");
      app.setPluginStatus("starting");
      running = true
      const started = ++generation
      metrics = []
      descriptions = []
      valueCache = {}
      updates = {}
      uploaded = {}
      currentState = undefined
      reported = ''
      backlightChecked = 0
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
      const measurements = settings.descriptions || []
      measurements.forEach(d => {
        let path = `label.${d.label}.description.${d.measurement}`
        let metric = influx.format(`${path}`, d.field, DateTime.utc(), '')
        if (metric!==null)
          metrics.push(metric)
        path = `type.${d.measurement}.label.${d.label}.description`
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
        frequency: settings.upload.frequency || 30,
        retention: settings.influx.retention
      }
      // init Screen configuration
      const screenSettings = (settings.grafana && settings.grafana.screen) || {}
      screenConfig = {
        enabled: !!screenSettings.brightness,
        brightness: undefined,
        daytime: screenSettings.daytime || 225,
        nighttime: screenSettings.nighttime || 15,
      }
      // init path configuration
      influxConfig.pathConfig = {}
      influxConfig.valueConfig = {}
      if (!settings.upload.pathConfig || !influx.check(app.getDataDirPath(), settings.upload.pathConfig))
      {
        settings.upload.pathConfig = 'pathconfig.json'
        influx.save(app.getDataDirPath(), settings.upload.pathConfig, [])
        app.savePluginOptions(settings, () => {log('Plugin options saved')});
      }
      // re-read on every start - a restart from the server UI picks up changes of the file
      influxConfig.paths = influx.config(
        settings.upload.pathConfig.includes('/') ? settings.upload.pathConfig :
        path.join(app.getDataDirPath(), settings.upload.pathConfig),
        settings.upload.frequency)
      influxConfig.paths.forEach(p => {
        if (p.hasOwnProperty('config'))
            influxConfig.pathConfig[p.path] = influx.reconfig(p.path, p.config)
        if (p.hasOwnProperty('convert'))
            influxConfig.valueConfig[p.path] = p.convert
      })
      // kiosk and brightness do not depend on influx
      kiosk = grafana.init(settings.grafana, log, app.setPluginStatus, app.setPluginError) && !!(settings.grafana && settings.grafana.autostart)
      later(started, () => startScreen(started), START_DELAY)

      const influxDB = influx.login({
        url: settings.influx.uri,         // get from options
        token: settings.influx.token,     // get from options
        timeout: 10 * 1000,               // 10sec timeout for health check
      }, influxConfig.cacheDir)
      influx.health(influxDB, (db, result) => startUpload(db, result, started, settings))
    },
    stop: () => {
      running = false
      unsubscribes.forEach(f => f());
      unsubscribes = [];
      startTimers.forEach(t => clearTimeout(t))
      startTimers = []
      uploadTimer && clearInterval(uploadTimer);
      screenTimer && clearInterval(screenTimer);
      uploadTimer = undefined
      screenTimer = undefined
      // persist any metrics still buffered, also when influx was never configured
      metrics = influx.flush(metrics, influxConfig.cacheDir ? influxConfig.cacheDir : app.getDataDirPath());
      log("stopped");
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
          grafana: {
            type: "object",
            title: "Grafana Configuration",
            required: ['autostart'],
            properties: {
              autostart: {
                type: 'boolean',
                title: 'Grafana Kiosk',
                description: 'launch grafana kiosk with plugin start',
                default: false
              },
              launch: {
                type: "object",
                title: "Launch Configuration",
                properties: {
                  command: {
                    type: 'string',
                    title: 'Launch command',
                    description: 'base command: chromium-browser or grafana-kiosk',
                    enum: ["chromium-browser", "grafana-kiosk"],
                    default: ''
                  },                  
                  remote: {
                    type: 'string',
                    title: 'Remote command',
                    description: 'remote execution, pwd-free login required',
                    default: ''
                  }, 
                  params: {
                    type: 'string',
                    title: 'Configuration params',
                    description: 'command params resp. full path to config-file',
                    default: ''
                  },                    
                }
              },
              dashboard: {
                type: "object",
                title: "Dashboard Configuration",
                required: ['idle'],
                properties: {
                  server: {
                    type: 'string',
                    title: 'Grafana Server',
                    description: 'URI of the Grafana-server',
                    default: ''
                  },
                  idle: {
                    type: 'string',
                    title: 'Idle dashboard',
                    description: 'url id of the default dashboard, eg. signalk-dashboard/idle',
                    default: ''
                  },
                  params: {
                    type: 'string',
                    title: 'Dashboard params',
                    description: 'configuration params on dashboard launch',
                    default: ''
                  },
                }
              },
              screen: {
                type: "object",
                title: "Screen Configuration",
                properties: {
                  brightness: {
                    type: 'boolean',
                    title: 'Adapt screen brightness',
                    description: 'change brightness according to time of day',
                    default: false
                  },                  
                  daytime: {
                    type: 'number',
                    title: 'Daytime brightness',
                    description: 'value between 0 and 255',
                    default: 225
                  }, 
                  nighttime: {
                    type: 'number',
                    title: 'Nighttime brightness',
                    description: 'value between 0 and 255',
                    default: 15
                  },                    
                }
              },
              boards: {
                type: 'array',
                default: [],
                title: 'Switchboards according to navigation state',
                items: {
                  type: 'object',
                  required: ['state', 'uid'],
                  properties: {
                    state: {
                      type: 'string',
                      title: 'State',
                      description: 'according to @meri-imperiumi/signalk-autostate plugin',
                      enum: ["moored", "sailing", "motoring", "anchored"],
                      default: ''
                    },                  
                    uid: {
                      type: 'string',
                      title: 'Dashboard ID',
                      description: 'url id of the dashboard, eg. signalk-dashboard/moored',
                      default: ''
                    },
                    params: {
                      type: 'string',
                      title: 'Dashboard params',
                      description: 'configuration params for dashboard launch',
                      default: ''
                    }
                  }
                }
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
          },
      }
    }
  };

  return plugin;
};
