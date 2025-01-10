/* 
    Copyright © 2025 Inspired Technologies. All Rights Reserved.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/

const { InfluxDB, Point } = require('@influxdata/influxdb-client')
const { HealthAPI } = require('@influxdata/influxdb-client-apis')
const { DateTime } = require('luxon')
const fs = require('fs') 
const path = require('path')
const cache = require('./cache')

let log
let cacheDir = ''
let cacheBuffer = []
function buffer(metrics) {
    cacheBuffer = metrics
}

function flush(metrics) {
    if (metrics) {
      buffer(metrics)
      cache.push(cacheBuffer, cacheDir, log)
    }
    return []
  }

function config(configfile, interval) {
    if (interval<1000) interval = 1000
    if (fs.existsSync(configfile))
        try
        {
            let configPaths = require(configfile)
            return configPaths
        } catch {
            return []
        }
    else 
        return []
}

function reconfig (path, config) {
    if (config.includes(':')){
      const param = config.split(':')
      const res = reconfig(path, param[0])
      return reconfig(res, param[1]) 
    }
    else if (config.includes('|>')) {
      // replace
      const param = config.split('|>')
      return path.replace(param[0], param[1])
    } else if (config.includes('+>')) {
      // add
      const param = config.split('+>')
      return param[0]+path+"."+param[1]
    } else if (config.includes('~')) {
      // switch+embed
      const param = config.split('~')
      const rotate = '*.'+path.split('.*')[0]+path.split('.*')[1]
      return param[0]+rotate+param[1]
    }
    return null
}

function match(paths, actual)
{
    if (!Array.isArray(paths))
        return ''

    let found = ''
    paths.forEach(p => {
        let p1 = p.split('.')
        let p2 = actual.split('.')
        let i = 0

        while (i<p1.length)
        {
            if (p1[i]!=='*' && p1[i]!==p2[i])
                break;
            if (i===p1.length-1)
                found = p;
            i++
        }
    })

    return found
}

function save(dir, file, content) {
    fs.writeFileSync(
        path.join(dir, file),
        JSON.stringify(content).concat("\n"), (err) => {
          if (err) throw err;
          return null
        }
      )
    return file
}

function check(dir, file) {
    return fs.existsSync(path.join(dir, file));
}

function login(clientOptions, cachedir, debug) {
    try {
        const influxDB = new InfluxDB(clientOptions)
        let cacheDir = cachedir
        let log = debug
        log ("Influx Login successful")
        return influxDB
    } catch (err) {
        log ("Error logging into influx: "+err)         
    }
}

async function health (influxDB, log, callback) {
    log("Determining influx health")
    const healthAPI = new HealthAPI(influxDB)
    
    await healthAPI
    .getHealth()
    .then((result /* : HealthCheck */) => {
        log('Influx healthCheck: ' + (result.status === 'pass' ? 'OK' : 'NOT OK'))
        return callback(influxDB, result) 
   })
    .catch(error => {
        log("HealthCheck Error: "+error)
        return false
    })
}

function post (influxdb, metrics, config, log) {
    // [Required] Organization | Empty for 1.8.x
    // [Required] Bucket | Database/Retention Policy 
    // Precision of timestamp. [`ns`, `us`, `ms`, `s`]. The default would be `ns` for other data
    const writeAPI = influxdb.getWriteApi(config.organization, config.bucket, 'ms')
    writeAPI.useDefaultTags({id: config.id})
    
    // write point with the appropriate (client-side) timestamp
    let measurements = {}
    for (i=0; i<metrics.length; i++)
    {
        writeAPI.writePoint(metrics[i])
        measurements[metrics[i].name] = (measurements[metrics[i].name] ? measurements[metrics[i].name]+1 : 1)
    }
    writeAPI
        .close()
        .then(() => {
            log(measurements)
            /* cacheResult = cache.load(config.cacheDir, log) 
            if (cacheResult === false) {
                return
            }
            else {      
                let cached = cache.send(cacheResult, config.cacheDir)
                log('Sending '+cached.length+' cached data points to be uploaded to influx')
                let points = []
                cached.forEach(p => {
                    let point = new Point(p.name)
                        .tag(Object.keys(p.tags)[0], p.tags[Object.keys(p.tags)[0]])
                        .timestamp(p.timestamp)
                    if (typeof p.fields[Object.keys(p.fields)[0]]==='float' || parseFloat(p.fields[Object.keys(p.fields)[0]]).toString()!=='NaN') 
                        point.floatField(Object.keys(p.fields)[0], parseFloat(p.fields[Object.keys(p.fields)[0]]))
                    else
                        point.stringField(Object.keys(p.fields)[0], p.fields[Object.keys(p.fields)[0]])
                    points.push(point)
                }) 
                post(influxdb, points, config, log)
            } */
        })
        .catch(err => {
            // Handle errors
            // cache.push(cacheBuffer, config.cacheDir, log)
            // cacheBuffer = []
            log(`Metrics not written due to ${err.message}`);
            /* const cacheResult = cache.load(config.cacheDir, log)
            if (cacheResult !== false) {
                log(`${cacheResult.length} files cached`)
            } */
    })
}
 
function format (path, values, timestamp, skSource) {
    if (values === null){
        values = 0
    }

    //Set variables for metric
    let point = null

    // Get correct measurement based on path based on path config
    const skPath = path.split('.')

    switch (skPath.length) {
        case 5:
            // extended - use double tagging
            switch (typeof values) {
                case 'string':
                    point = new Point(skPath[3])
                    .tag(skPath[0], skPath[1])
                    .tag(skPath[1], skPath[2])
                    .stringField(skPath[4], values)    
                    break;
                case 'object':
                    point = new Point(skPath[3])
                    .tag(skPath[0], skPath[1])
                    .tag(skPath[1], skPath[2])
                    .stringField(skPath[4], JSON.stringify(values))  
                    break;
                case 'boolean':
                    point = new Point(skPath[3])
                    .tag(skPath[0], skPath[1])
                    .tag(skPath[1], skPath[2])
                    .booleanField(skPath[4], values)
                    break;
                default:
                    point = new Point(skPath[3])
                    .tag(skPath[0], skPath[1])
                    .tag(skPath[1], skPath[2])
                    .floatField(skPath[4], values)
                    break;
            }
            break;
        case 4:
            // default
            switch (typeof values) {
                case 'string':
                    point = new Point(skPath[2])
                    .tag(skPath[0], skPath[1])
                    .stringField(skPath[3], values)    
                    break;
                case 'object':
                    point = new Point(skPath[2])
                    .tag(skPath[0], skPath[1])
                    .stringField(skPath[3], JSON.stringify(values))  
                    break;
                case 'boolean':
                    point = new Point(skPath[2])
                    .tag(skPath[0], skPath[1])
                    .booleanField(skPath[3], values)
                    break;
                default:
                    point = new Point(skPath[2])
                    .tag(skPath[0], skPath[1])
                    .floatField(skPath[3], values)
                    break;
            }
            break;
        case 3:
            // default
            switch (typeof values) {
                case 'string':
                    point = new Point(skPath[2])
                    .tag(skPath[0], skPath[1])
                    .stringField('value', values)    
                    break;
                case 'object':
                    point = new Point(skPath[2])
                    .tag(skPath[0], skPath[1])
                    .stringField('value', JSON.stringify(values))  
                    break;
                case 'boolean':
                    point = new Point(skPath[2])
                    .tag(skPath[0], skPath[1])
                    .booleanField('value', values)
                    break;
                default:
                    point = new Point(skPath[2])
                    .tag(skPath[0], skPath[1])
                    .floatField('value', values)
                    break;
            }
            break;
        case 2:
            // to be verified
            switch (typeof values) {
                case 'string':
                    point = new Point(skPath[1])
                    .tag(skPath[0], '')
                    .stringField('value', values)    
                    break;
                case 'object':
                    point = new Point(skPath[1])
                    .tag(skPath[0], '')
                    .stringField('value', JSON.stringify(values))  
                    break;
                case 'boolean':
                    point = new Point(skPath[1])
                    .tag(skPath[0], '')
                    .booleanField('value', values)
                    break;
                default:
                    point = new Point(skPath[1])
                    .tag(skPath[0], '')
                    .floatField('value', values)
                    break;
            }
            break;
        case 1:
        default:
            // invalid
            fields = null
            break;
    }
   
    if (skSource && skSource!=='')
        point.tag('source', skSource)
    point.timestamp = (timestamp ? timestamp.toMillis() : DateTime.utc().toMillis())
    return point
}

module.exports = {
    login,      // login to InfluxDB
    health,     // check InfluxDB health
    config,     // create default configuration
    reconfig,   // modify config  record
    match,      // find dynamics path matching actual config path
    check,      // check if config file exists
    save,       // save configuration to file
    buffer,     // load cache if post can be complete
    flush,      // flush the buffer to cache
    post,       // post to InfluxDB
    format      // format measurement before sending
}