const Proc = require('child_process').exec;
const { Client } = require('ssh2');
const fs = require('fs');
const yaml = require('js-yaml');

let log
let err = console.error
let setStatus
let setError
let configFile
const checkchrom = "pgrep chromium | head -1"
const checkkiosk = "sudo systemctl status grafana-kiosk | grep 'Active:' | awk '{print $2}'"
// const env = "export XDG_RUNTIME_DIR=/run/user/10000"
const closebrowser = "kill {pid}"
const chromium = "chromium-browser {uri} {params}"
const tabbed  = "chromium-browser [tabs] {params}"
const nexttab = "wtype -M ctrl -P Tab"
const kiosk = "sudo systemctl restart {service}"
let command
let exec
let boards = {
    default: {}
}
// const states = []
let current
let rl = {
    host: '',
    port: 22,
    user: '',
    key: null
}

function init (config, logger, set, err) {
    // store content to file
    log = logger
    setStatus = set
    setError = err
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
        if (config.launch.remote)
        {
            exec = config.launch.remote!=="" ? config.launch.remote+' "{cmd}"' : '{cmd}'
            let login = config.launch.remote.split(" ")
            if (login.length>0)
            {
                rl.host = login[login.length-1].split("@")[1]
                rl.user = login[login.length-1].split("@")[0]
                rl.key = fs.readFileSync(config.launch.keyFile)
            }
        }
        else
            exec = '{cmd}'
        switch (config.launch.command)
        {
            case "chromium-browser":
                let url = `'${config.dashboard.server}/d/${boards.default.id}?kiosk${(boards.default.params ? `&${boards.default.params}` : '')}'`                
                command = exec.replace("{cmd}", chromium.replace("{uri}", url).replace("{params}", config.launch.params) + ' &')
                break;
            case "chromium-tabbed":
                let urls = []
                Object.keys(boards).forEach(b => {
                    urls.push(`'${config.dashboard.server}/d/${boards[b].id}?kiosk${(b.params ? `&${boards[b].params}` : '')}'`)
                })
                command = exec.replace("{cmd}", tabbed.replace("[tabs]", urls.join(' ')).replace("{params}", config.launch.params) + ' &')
                break;
            case "grafana-kiosk":
                configFile = config.launch.params
                Object.keys(boards).forEach(b => {
                    boards[b].url = `${config.dashboard.server}/d/${boards[b].id}?kiosk${(boards[b].params ? `&${boards[b].params}` : '')}`
                }) 
                updateConfig(configFile, boards.default.url, () => { log(`Configured launch URL: ${boards.default.url}`) })
                command = exec.replace("{cmd}", kiosk.replace("{service}", config.launch.command))
                break;
            default:
                if (config.autostart)
                    err('invalid grafana configuration')              
                return false;            
        }
    }
    log(`Grafana autostart: ${!config || !config.launch ? "none" : command}`)
    return command && command !== ""
}

function check(msg, callback) {
    // Proc(exec.replace("{cmd}", command.includes("chromium") ? checkchrom : '"'+checkkiosk+'"'), (error,stdout,stderr) => {
    Proc(exec.replace("{cmd}", command.includes("chromium") ? checkchrom : checkkiosk), (error,stdout,stderr) => {
            if (error) {
            setError(`grafana error: ${error || stderr}`)
            err( `exec error: ${error ? error : stderr}` );
            return;
        }
        setStatus(`Started: ${msg.replace("{pid}", stdout.replace("\n", ""))}`)
        callback(stdout.replace("\n", ""))
    })
}

function launch (status, callback) {
    if (status==='') {
        let msg = command.includes("chromium") ? chromium.replace("uri","pid").replace("{params}",`${Object.keys(boards).length} tab(s)`) : kiosk
        let timer = setInterval( () => {
            check(msg, callback)
            current = 0
            clearInterval(timer); 
        }, 15000)
        Proc("nohup " + command + " >/dev/null 2>&1 </dev/null", (error,stdout,stderr) => { return; })
    } else if (!command.includes("chromium")) {
        log(`Grafana kiosk service is ${status}`)
        Proc(status==='active' ? command : command.replace("restart", "start"), (error,stdout,stderr) => {
            if (error) {
                setError(`grafana error: ${error || stderr}`)
                err( `exec error: ${error ? error : stderr}` );
                return;
            }
            check("Grafana kiosk-service {pid}", callback)
        })
    } else {
        log(`Status check: ${status}`)
        Proc(exec.replace("{cmd}", closebrowser.replace("{pid}", status)), (error,stdout,stderr) => {
            if (error) {
                setError(`grafana error: ${error || stderr}`)
                err( `exec error: ${error ? error : stderr}` );
                return;
            }
            launch(stdout, callback)
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
    let next = 0
    let length = Object.keys(boards).length
    let steps = 0
    if (!boards.hasOwnProperty(state) && current !== 0)
        next = 0
    else
        next = boards[state].tab
    if (current !== next)
        steps = next > current ? next - current : length - current + next
    if (steps !== 0)
    {
        let cmd = nexttab
        for (i=1; i<steps; i++)
            cmd += ` && sleep 1 && ${nexttab} `

        log(`Switching tab from ${current} to ${next} ...`)
        Proc(exec.replace("{cmd}", cmd), (error,stdout,stderr) => {
            if (error) {
                err( `exec error: ${error ? error : stderr}` );
                return;
            }
            current = next
            callback()
        })
    }
}

function newBoard (state, callback)
{
    log(`Switching board to ${state} ...`)
    updateConfig(configFile, boards[boards.hasOwnProperty(state) ? state : 'default'].url, () => {
        Proc("sleep 2 && " +command, (error,stdout,stderr) => {
            if (error) {
                err( `exec error: ${error ? error : stderr}` );
                return;
            }
            callback()
        })
    })
}

function updateConfig(configFile, url, callback)
{
    if (exec.includes('ssh'))
        modifyRemoteYaml(configFile, url, callback)
    else {
        modifyLocalYaml(configFile, url)
        callback()
    }
}

function modifyLocalYaml(file, url) {
    try {
        // Read the YAML file
        const fileContents = fs.readFileSync(file, 'utf8');
        const data = yaml.load(fileContents);

        // Modify the URL parameter
        if (data.target && data.target.URL) {
            data.target.URL = url;
        } else {
            throw new Error('URL parameter not found in the YAML file.');
        }

        // Write the updated YAML back to the file
        const newYaml = yaml.dump(data);
        fs.writeFileSync(file, newYaml, 'utf8');

        log('Board URL updated');
    } catch (e) {
        err('Error updating the board URL:', e);
    }
}

function modifyRemoteYaml(file, url, callback) {
    const conn = new Client();
    try
    {
        conn.on('ready', () => {
            // log('SSH Client :: ready');
            conn.sftp((err, sftp) => {
                if (err) throw err;

                // Read the remote YAML file
                sftp.readFile(file, 'utf8', (err, data) => {
                    if (err) throw err;

                    // Parse the YAML file
                    let yamlData = yaml.load(data);

                    // Modify the URL parameter
                    if (yamlData.target && yamlData.target.URL) {
                        yamlData.target.URL = url;
                    } else {
                        throw new Error('URL parameter not found in the YAML file.');
                    }

                    // Convert the modified data back to YAML
                    const newYaml = yaml.dump(yamlData);

                    // Write the modified YAML back to the remote file
                    sftp.writeFile(file, newYaml, 'utf8', (err) => {
                        if (err) throw err;
                        log('Board URL updated on remote');
                        conn.end();
                    });

                    // next action
                    callback()
                });
            });
        }).connect({
            host: rl.host,
            port: rl.port,
            username: rl.user,
            privateKey: rl.key
        });
    } catch (e) {
        err('Error updating the board URL:', e);
    }
}

module.exports = {
    init,       // initialize environment
    check,      // check kiosk service is already runnning
    launch,     // launch kiosk service
    next        // switch visible board to new state
}