// Commands and files on the kiosk host - locally, or remote over a single ssh2 connection
const child = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ssh2 = require('ssh2')
const log = require('debug')('signalk-dashboard:remote')

const DEFAULT_KEYS = ['id_ed25519', 'id_ecdsa', 'id_rsa']   // tried in this order, like the ssh client
const WITH_VALUE = 'bcDEeFIiJLlmOopQRSWw'                   // ssh options taking a value
const READY_TIMEOUT = 10000
const KEEPALIVE = 30000

let login = null        // { host, port, username, keyFile } - null: local execution
let conn = null         // ssh2 client, connecting or ready
let ready = false
let pending = []        // callbacks waiting for the connection
let hostKey             // sha256 of the host key, logged when it changes

const home = (file) => file && file.startsWith('~') ? path.join(os.homedir(), file.slice(1)) : file

// "ssh [-p port] [-i key file] [-l user] [user@]host", "[user@]host" or "ssh://[user@]host[:port]" - empty: local
function parse (remote, keyFile) {
    if (!remote || !String(remote).trim())
        return null
    const tokens = String(remote).trim().split(/\s+/)
    const result = { host: '', port: 22, username: '', keyFile: home(keyFile || '') }
    let destination
    for (let i = tokens[0]==='ssh' ? 1 : 0; i < tokens.length; i++) {
        const t = tokens[i]
        if (t.startsWith('-') && t.length>1) {
            const option = t[1]
            if (!WITH_VALUE.includes(option))
                continue                                    // flags like -t, -4
            const value = t.length>2 ? t.slice(2) : tokens[++i]
            if (option==='p') result.port = parseInt(value, 10) || 22
            else if (option==='i' && !keyFile) result.keyFile = home(value)
            else if (option==='l') result.username = value
        } else if (!destination)
            destination = t                                 // anything after the destination is a command
        else
            break
    }
    if (!destination)
        throw new Error(`no host in remote command '${remote}'`)
    let uri = false
    if (destination.startsWith('ssh://')) {
        destination = destination.slice(6)
        uri = true
    }
    const at = destination.lastIndexOf('@')
    if (at>=0) {
        result.username = destination.slice(0, at)
        destination = destination.slice(at+1)
    }
    if (uri && /^[^:]+:\d+$/.test(destination)) {
        result.port = parseInt(destination.split(':')[1], 10)
        destination = destination.split(':')[0]
    }
    result.host = destination
    if (!result.username)
        result.username = os.userInfo().username            // like ssh: the user running SignalK
    return result
}

// configure the kiosk host - closes a connection to a previous host
function configure (remote, keyFile) {
    end()
    login = parse(remote, keyFile)
    hostKey = undefined
    return login
}

function isRemote () {
    return login!==null
}

function describe () {
    return login ? `${login.username}@${login.host}:${login.port}` : 'local'
}

// configured key file, otherwise the default keys of the SignalK user
function privateKey () {
    if (login.keyFile)
        return fs.readFileSync(login.keyFile)
    for (const name of DEFAULT_KEYS) {
        const file = path.join(os.homedir(), '.ssh', name)
        if (fs.existsSync(file))
            return fs.readFileSync(file)
    }
    return undefined
}

function reset (client) {
    if (conn!==client)
        return false
    conn = null
    ready = false
    return true
}

function flush (error, client) {
    const waiting = pending
    pending = []
    waiting.forEach(callback => callback(error, client))
}

// one connection for all commands and file transfers, re-established on the next use after a close
function connection (callback) {
    if (conn && ready)
        return callback(null, conn)
    pending.push(callback)
    if (conn)
        return                                              // connecting
    let key
    try {
        key = privateKey()
    } catch (e) {
        return flush(new Error(`ssh key file not readable: ${e.message}`))
    }
    const agent = process.env.SSH_AUTH_SOCK
    if (key && ssh2.utils.parseKey(key) instanceof Error) {
        // passphrase protected keys only through the ssh agent
        log(`SSH key for ${describe()} not usable: ${ssh2.utils.parseKey(key).message}`)
        key = undefined
    }
    if (!key && !agent)
        return flush(new Error(`no usable ssh key for ${describe()} - set the key file (without passphrase) or place a key in ~/.ssh of the SignalK user`))
    const client = new ssh2.Client()
    conn = client
    client.on('ready', () => {
        if (conn!==client)
            return
        ready = true
        log(`Connected to ${describe()}`)
        flush(null, client)
    }).on('error', (e) => {
        log(`SSH ${describe()}: ${e.message}`)
        if (reset(client))
            flush(e)
    }).on('close', () => {
        if (reset(client)) {
            log(`Connection to ${describe()} closed`)
            flush(new Error(`ssh connection to ${describe()} closed`))
        }
    })
    const options = {
        host: login.host,
        port: login.port,
        username: login.username,
        readyTimeout: READY_TIMEOUT,
        keepaliveInterval: KEEPALIVE,
        hostHash: 'sha256',
        hostVerifier: (hash) => {
            if (hash!==hostKey)
                log(`Host key of ${login.host} (sha256): ${hash}`)
            hostKey = hash
            return true
        }
    }
    if (key) options.privateKey = key
    if (agent) options.agent = agent
    try {
        client.connect(options)
    } catch (e) {
        if (reset(client))
            flush(e)
    }
}

// run a shell command - callback(error, stdout, stderr) like child_process.exec, error.code = exit code
function run (cmd, callback) {
    if (!login)
        return child.exec(cmd, callback)
    connection((error, client) => {
        if (error)
            return callback(error, '', '')
        client.exec(cmd, (error, stream) => {
            if (error)
                return callback(error, '', '')
            let stdout = ''
            let stderr = ''
            let code = null
            let signal = null
            stream.on('data', (data) => { stdout += data })
            stream.stderr.on('data', (data) => { stderr += data })
            stream.on('exit', (c, s) => {
                code = c
                signal = s || null
            })
            stream.on('close', () => {
                let failure = null
                if (code || signal) {
                    failure = new Error(`Command failed: ${cmd}${stderr ? `\n${stderr}` : ''}`)
                    failure.code = code
                    failure.signal = signal
                }
                callback(failure, stdout, stderr)
            })
        })
    })
}

function sftp (callback) {
    connection((error, client) => {
        if (error)
            return callback(error)
        client.sftp(callback)
    })
}

// read a text file - callback(error, data)
function readFile (file, callback) {
    if (!login)
        return fs.readFile(file, 'utf8', callback)
    sftp((error, session) => {
        if (error)
            return callback(error)
        session.readFile(file, 'utf8', (error, data) => {
            session.end()
            callback(error, data ? data.toString() : data)
        })
    })
}

// write a text file - callback(error) once written
function writeFile (file, data, callback) {
    if (!login)
        return fs.writeFile(file, data, 'utf8', callback)
    sftp((error, session) => {
        if (error)
            return callback(error)
        session.writeFile(file, data, 'utf8', (error) => {
            session.end()
            callback(error)
        })
    })
}

// close the connection, eg. on plugin stop - the next command connects again
function end () {
    const client = conn
    if (!client)
        return
    reset(client)
    flush(new Error(`ssh connection to ${describe()} ended`))
    client.end()
}

module.exports = {
    parse,          // remote command → login
    configure,      // set the kiosk host (empty: local)
    isRemote,
    describe,
    run,            // shell command on the kiosk host
    readFile,       // text file on the kiosk host
    writeFile,
    end             // close the connection
}
