// const fs = require('fs')
const Proc = require('child_process').exec;

let log
let err = console.error
let setStatus
let setError
const checkchrom = "pgrep chromium | head -1"
const checkkiosk = "sudo systemctl status grafana-kiosk | grep Active:"
const env = "export XDG_RUNTIME_DIR=/run/user/10000"
const closebrowser = "kill {pid}"
const chromium = "chromium-browser {uri} {params}"
const tabbed  = "chromium-browser [tabs] {params}"
const nexttab = "wtype -M ctrl -P Tab"
const kiosk = "grafana-kiosk"
let command
let exec
let boards = {
    default: {}
}
let current

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
        exec = config.launch.remote && config.launch.remote!=="" ? config.launch.remote+' "{cmd}"' : '{cmd}'
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
                command = exec.replace("{cmd}", `sudo systemctl restart ${kiosk}`)
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
    Proc(exec.replace("{cmd}", command.includes("chromium") ? checkchrom : checkkiosk), (error,stdout,stderr) => {
        if (error) {
            setError(`grafana error: ${error || stderr}`)
            err( `exec error: ${error ? error : stderr}` );
            return;
        }
        setStatus(`Started: ${msg.replace("{pid}", stdout.replace("\n", ""))}`)
        callback(command.includes("chromium") ? stdout.replace("\n", "") : stdout.replace("Active: ", ""))
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
        log('Grafana Kiosk not yet implemented!')
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
    let next = 0
    let length = Object.keys(boards).length
    let steps = 0
    if (!boards.hasOwnProperty(state) && current !== 0)
        next = 0
    else
        next = boards[state].tab
    if (current !== next)
        steps = next > current ? next-current : (next+length-current) % length
    if (steps !== 0)
    {
        let cmd = nexttab
        for (i=1; i<steps; i++)
            cmd += ` sleep 1 && ${nexttab} `

        Proc(exec.replace("{cmd}", cmd), (error,stdout,stderr) => {
            if (error) {
                err( `exec error: ${error ? error : stderr}` );
                return;
            }
            log(`Switched board from ${current} to ${next}`)
            current = next
            callback()
        })
    }
}

/* function exists (dir, log) {
    // joining path of directory 
    const fileArray = []
    files = fs.readdirSync(dir)
    Object.keys(boards).forEach((b) => {
        let file = path.join(boards.dir, b)
        if (b!=="folder" && fs.existsSyncSync(file))
        {
            boards[b].valid = true
            log(b)
        }
    })
}

function send (filenames, cacheDir) {
    var input = []
    filenames.forEach(function (file) {
        if (file.includes(REQUEUED)) {
            const thisfile = fs.readFileSync(`${cacheDir}/${file}`, 'utf8')
            input.push(...JSON.parse(thisfile));
        }
    });
    
    for (const file of filenames) {
        if (file.includes(REQUEUED))
            fs.unlink((`${cacheDir}/${file}`), err => {
                if (err) throw err;
        });
    };

    return input
} */

module.exports = {
    init,       // initialize environment
    check,      // check kiosk service is already runnning
    launch,     // launch kiosk service
    next        // switch visible board to new state
    // load,
    // change
}