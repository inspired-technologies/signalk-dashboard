// const fs = require('fs')
const Proc = require('child_process').exec;

let log
let err = console.error
const checkchrom = "pgrep chromium | head -1"
const checkkiosk = "sudo systemctl status grafana-kiosk | grep Active:"
const env = "export XDG_RUNTIME_DIR=/run/user/10000"
const closecbrowser = "kill {pid}"
const chromium = "chromium-browser {uri} {params}"
const tabbed  = "chromium-browser [tabs] {params}"
const nexttab = "wtype -M ctrl -P Tab"
const kiosk = "grafana-kiosk"
let command
let exec
let boards = {
    default: {}
}

function init (config, logger) {
    // store content to file
    log = logger
    if (config && config.launch)
    {
        boards.default = {
            id: config.dashboard.idle,
            params: config.dashboard.params
        }
        exec = config.launch.remote && config.launch.remote!=="" ? config.launch.remote+' "{cmd}"' : '{cmd}' 
        switch (config.launch.command)
        {
            case "chromium-browser":
                let url = `'${config.dashboard.server}/d/${boards.default.id}?kiosk${(boards.default.params ? `&${boards.default.params}` : '')}'`
                command = exec.replace("{cmd}", chromium.replace("{uri}", url).replace("{params}", config.launch.params))
                break;
            case "grafana-kiosk":
                command = exec.replace("{cmd}", `sudo systemctl restart ${kiosk}`)
                break;
            default:                
                return false;            
        }
    }
    log(`Grafana autostart: ${!config || !config.launch ? "none" : command}`)
    return command && command !== ""
}

function check(callBack, setStatus) {
    Proc(exec.replace("{cmd}", command.includes("chromium") ? checkchrom : checkkiosk), (error,stdout,stderr) => {
        if (error || stderr) {
            err( `exec error: ${error ? error : stderr}` );
            return;
        }
        callBack(`${command.includes("chromium") ? stdout : stdout.replace("Active: ", "")}`, setStatus)
    })
}

function launch(status, setStatus) {
    log(`Check returned ${status}`)
    let syslog = `${command.includes("chromium") ? chromium.replace("uri","pid").replace("{params}",`${Object.keys(boards).length} tab(s)`) : kiosk}`
    if (status==='') {       
        log(`Launching ${syslog}`)
        Proc(command+" &", (error,stdout,stderr) => {
            if (error || stderr) {
                err( `exec error: ${error ? error : stderr}` );
                return;
            }
            setStatus(`Started: ${syslog.replace("{pid}", stdout)}`)
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
    // load,
    // change
}