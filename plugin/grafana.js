const remote = require('./remote');
const yaml = require('js-yaml');
const log = require('debug')('signalk-dashboard:grafana')

let err = console.error
let setStatus
let setError
let configFile
// commands run unquoted on the kiosk host - locally or over ssh (remote.js), no local shell in between
const checkchrom = "pgrep chromium | head -1"
const checkkiosk = "sudo systemctl status grafana-kiosk | grep 'Active:' | awk '{print $2}'"
const closebrowser = "kill {pid}"
const setbrightness = "echo {val} | sudo tee /sys/class/backlight/*/brightness"
const getbrightness = "cat /sys/class/backlight/*/brightness | head -1"
const chromium = "chromium-browser {uri} {params}"
const tabbed  = "chromium-browser [tabs] {params}"
const nexttab = "wtype -M ctrl -P Tab"
const kiosk = "sudo systemctl restart {service}"
const background = "nohup {cmd} >/dev/null 2>&1 </dev/null &"
let command
let boards = {
    default: {}
}
let current = {
    board: undefined,
    brightness: undefined
}

function failed (error, stderr) {
    if (setError)
        setError(`grafana error: ${error || stderr}`)
    err( `exec error: ${error ? error : stderr}` );
}

function init (config, logger, set, error) {
    // store content to file
    setStatus = set
    setError = error
    command = undefined
    boards = { default: {} }
    current.board = undefined
    try {
        remote.configure(config && config.launch && config.launch.remote, config && config.launch && config.launch.keyFile)
    } catch (e) {
        failed(`invalid remote command - ${e.message}`)
        return false
    }
    if (config && config.launch)
    {
        boards.default = {
            tab: 0,
            id: config.dashboard.idle,
            params: config.dashboard.params
        }
        if (config.boards && config.boards.length>0)
        {
            if (config.launch.command.includes('chromium'))
                config.launch.command = "chromium-tabbed"
            let i=1
            config.boards.forEach(b => {
                boards[b.state] = {
                    tab: i++,
                    id: b.uid,
                    params: b.params
                }
            })
        }
        switch (config.launch.command)
        {
            case "chromium-browser":
                let url = `'${config.dashboard.server}/d/${boards.default.id}?kiosk${(boards.default.params ? `&${boards.default.params}` : '')}'`
                command = chromium.replace("{uri}", url).replace("{params}", config.launch.params)
                break;
            case "chromium-tabbed":
                let urls = []
                Object.keys(boards).forEach(b => {
                    urls.push(`'${config.dashboard.server}/d/${boards[b].id}?kiosk${(boards[b].params ? `&${boards[b].params}` : '')}'`)
                })
                command = tabbed.replace("[tabs]", urls.join(' ')).replace("{params}", config.launch.params)
                break;
            case "grafana-kiosk":
                configFile = config.launch.params
                Object.keys(boards).forEach(b => {
                    boards[b].url = `${config.dashboard.server}/d/${boards[b].id}?kiosk${(boards[b].params ? `&${boards[b].params}` : '')}`
                })
                updateConfig(configFile, boards.default.url, () => { log(`Configured launch URL: ${boards.default.url}`) })
                command = kiosk.replace("{service}", config.launch.command)
                break;
            default:
                if (config.autostart)
                    setError && setError('invalid grafana configuration')
                return false;
        }
    }
    log(`Grafana autostart: ${!config || !config.launch ? "none" : `${command} (${remote.describe()})`}`)
    return command && command !== ""
}

function check(msg, callback) {
    remote.run(command.includes("chromium") ? checkchrom : checkkiosk, (error,stdout,stderr) => {
        if (error) {
            failed(error, stderr)
            return;
        }
        setStatus(`Started: ${msg.replace("{pid}", stdout.replace("\n", ""))}`)
        callback(stdout.replace("\n", ""))
    })
}

function launch (status, callback) {
    if (status==='') {
        let msg = command.includes("chromium") ? chromium.replace("uri","pid").replace("{params}",`${Object.keys(boards).length} tab(s)`) : kiosk
        setTimeout( () => {
            check(msg, callback)
            current.board = 0
        }, 15000)
        // chromium in the background - the command returns, the browser stays
        remote.run(command.includes("chromium") ? background.replace("{cmd}", command) : command, (error,stdout,stderr) => {
            if (error)
                failed(error, stderr)
        })
    } else if (!command.includes("chromium")) {
        log(`Grafana kiosk service is ${status}`)
        remote.run(status==='active' ? command : command.replace("restart", "start"), (error,stdout,stderr) => {
            if (error) {
                failed(error, stderr)
                return;
            }
            check("Grafana kiosk-service {pid}", callback)
        })
    } else {
        log(`Status check: ${status}`)
        remote.run(closebrowser.replace("{pid}", status), (error,stdout,stderr) => {
            if (error) {
                failed(error, stderr)
                return;
            }
            launch('', callback)
        })
    }
}

function next (state, callback) {
    if (command.includes("chromium"))
        nextTab (state, callback)
    else
        newBoard (state, callback)
}

function nextTab (state, callback) {
    let length = Object.keys(boards).length
    let steps = 0
    // states without a board of their own show the default board (tab 0)
    const next = boards.hasOwnProperty(state) ? boards[state].tab : 0
    const from = current.board || 0
    if (from !== next)
        steps = next > from ? next - from : length - from + next
    if (steps !== 0)
    {
        let cmd = nexttab
        for (let i=1; i<steps; i++)
            cmd += ` && sleep 1 && ${nexttab} `

        log(`Switching tab from ${from} to ${next} ...`)
        remote.run(cmd, (error,stdout,stderr) => {
            if (error) {
                err( `exec error: ${error ? error : stderr}` );
                return;
            }
            current.board = next
            callback()
        })
    }
}

function newBoard (state, callback)
{
    log(`Switching board to ${state} ...`)
    updateConfig(configFile, boards[boards.hasOwnProperty(state) ? state : 'default'].url, () => {
        remote.run("sleep 2 && " + command, (error,stdout,stderr) => {
            if (error) {
                err( `exec error: ${error ? error : stderr}` );
                return;
            }
            callback()
        })
    })
}

// target.URL of the grafana-kiosk yaml - locally or via sftp; callback once written
function updateConfig(file, url, callback)
{
    remote.readFile(file, (error, contents) => {
        let data
        try {
            if (error) throw error;
            data = yaml.load(contents);
            if (data && data.target && data.target.URL) {
                data.target.URL = url;
            } else {
                throw new Error('URL parameter not found in the YAML file.');
            }
        } catch (e) {
            err(`Error updating the board URL in ${file} (${remote.describe()}): ${e.message || e}`);
            return;
        }
        remote.writeFile(file, yaml.dump(data), (error) => {
            if (error) {
                err(`Error writing the board URL to ${file} (${remote.describe()}): ${error.message || error}`);
                return;
            }
            log(`Board URL updated (${remote.describe()})`);
            callback()
        })
    })
}

// force: write even if the value was set before, eg. after something else changed the backlight
function set (param, value, callback, force = false) {
    switch (param) {
        case 'brightness':
            if (!value || value < 0 || value > 255) {
                log(`Invalid brightness value: ${value}`)
                callback(current.brightness)
            } else if (force || value !== current.brightness) {
                // log(`Setting brightness to ${value} ...`)
                remote.run(setbrightness.replace("{val}", value), (error,stdout,stderr) => {
                    if (error) {
                        err( `exec error: ${error ? error : stderr}` );
                        return;
                    }
                    current.brightness = value
                    log(`Brightness set to ${value}`)
                    callback(value)
                })
            } else {
                log(`Brightness already set to ${value}`)
                callback(current.brightness)
            }
            break;
        default:
            log(`Screen configuration - invalid parameter: ${param}`)
            callback(undefined)
            break;
    }
}

// read a screen param - callback(undefined) if it cannot be read
function get (param, callback) {
    switch (param) {
        case 'brightness':
            remote.run(getbrightness, (error,stdout,stderr) => {
                const value = parseInt(String(stdout || '').trim(), 10)
                if (error || Number.isNaN(value)) {
                    log(`Brightness not readable: ${error ? error.message : stderr || stdout}`)
                    callback(undefined)
                    return
                }
                callback(value)
            })
            break;
        default:
            log(`Screen configuration - invalid parameter: ${param}`)
            callback(undefined)
            break;
    }
}

// close the ssh connection to the kiosk host
function stop () {
    remote.end()
}

module.exports = {
    init,       // initialize environment
    check,      // check kiosk service is already runnning
    launch,     // launch kiosk service
    next,       // switch visible board to new state
    set,        // set board param to value (eg. brightness)
    get,        // read board param (eg. brightness)
    stop        // close the connection to the kiosk host
}
