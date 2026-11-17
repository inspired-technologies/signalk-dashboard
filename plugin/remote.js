// Commands and files on the kiosk host - locally, or remote over a single ssh2 connection
const child = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ssh2 = require('ssh2')
const log = require('debug')('signalk-dashboard:remote')

const READY_TIMEOUT = 10000
const KEEPALIVE = 30000

let login = null        // { host, port, username, keyFile } - null: local execution
let invalid = null      // configuration error - no command runs, neither remote nor locally
let conn = null         // ssh2 client, connecting or ready
let ready = false
let pending = []        // callbacks waiting for the connection
let hostKey             // sha256 of the host key, logged when it changes

const home = (file) => file && file.startsWith('~') ? path.join(os.homedir(), file.slice(1)) : file

// remote host "user@host" with port and key file from the configuration - empty: local.
// The former remote command "ssh [-p port] [-i key file] user@host" is still accepted; nothing is assumed:
// user and key file are required, other ssh options are rejected.
function parse (remote, port, keyFile) {
    if (!remote || !String(remote).trim())
        return null
    const tokens = String(remote).trim().split(/\s+/)
    let legacyPort
    let legacyKey
    let destination
    for (let i = tokens[0]==='ssh' ? 1 : 0; i < tokens.length; i++) {
        const t = tokens[i]
        if (t==='-p' || t==='-i') {
            if (i+1 >= tokens.length)
                throw new Error(`missing value of ${t} in the remote host '${remote}'`)
            if (t==='-p') legacyPort = tokens[++i]
            else legacyKey = tokens[++i]
        } else if (t.startsWith('-'))
            throw new Error(`ssh option ${t} not supported - enter the remote host as user@host, port and key file in their own options`)
        else if (!destination)
            destination = t
        else
            throw new Error(`unexpected '${t}' after the remote host '${destination}'`)
    }
    const at = destination ? destination.lastIndexOf('@') : -1
    if (at<=0 || at===destination.length-1)
        throw new Error(`remote host '${remote}' is not user@host`)
    const result = {
        host: destination.slice(at+1),
        port: port!==undefined && port!==null && port!=='' ? Number(port) : (legacyPort!==undefined ? Number(legacyPort) : 22),
        username: destination.slice(0, at),
        keyFile: home(keyFile || legacyKey || '')
    }
    if (!Number.isInteger(result.port) || result.port<1 || result.port>65535)
        throw new Error(`invalid ssh port ${port!==undefined && port!=='' ? port : legacyPort}`)
    if (!result.keyFile)
        throw new Error(`SSH key file required for the remote host ${result.username}@${result.host}`)
    return result
}

// key of the configured key file - keys with passphrase are not supported
function privateKey (keyFile) {
    let key
    try {
        key = fs.readFileSync(keyFile)
    } catch (e) {
        throw new Error(`SSH key file ${keyFile} not readable: ${e.message}`)
    }
    const parsed = ssh2.utils.parseKey(key)
    if (parsed instanceof Error)
        throw new Error(`SSH key file ${keyFile} not usable${/passphrase/i.test(parsed.message) ? ' - keys with passphrase are not supported' : ''}: ${parsed.message}`)
    return key
}

// configure the kiosk host - closes a connection to a previous host; throws on an invalid configuration
function configure (remote, port, keyFile) {
    end()
    login = null
    invalid = null
    hostKey = undefined
    try {
        login = parse(remote, port, keyFile)
        if (login)
            privateKey(login.keyFile)
    } catch (e) {
        login = null
        invalid = e
        throw e
    }
    return login
}

function isRemote () {
    return login!==null
}

function describe () {
    return login ? `${login.username}@${login.host}:${login.port}` : 'local'
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
        key = privateKey(login.keyFile)                     // re-read: the key may have been replaced
    } catch (e) {
        return flush(e)
    }
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
    try {
        client.connect({
            host: login.host,
            port: login.port,
            username: login.username,
            privateKey: key,
            readyTimeout: READY_TIMEOUT,
            keepaliveInterval: KEEPALIVE,
            hostHash: 'sha256',
            hostVerifier: (hash) => {
                if (hash!==hostKey)
                    log(`Host key of ${login.host} (sha256): ${hash}`)
                hostKey = hash
                return true
            }
        })
    } catch (e) {
        if (reset(client))
            flush(e)
    }
}

// run a shell command - callback(error, stdout, stderr) like child_process.exec, error.code = exit code
function run (cmd, callback) {
    if (invalid)
        return callback(invalid, '', '')
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
    if (invalid)
        return callback(invalid)
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
    if (invalid)
        return callback(invalid)
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
    parse,          // remote host, port, key file → login
    configure,      // set the kiosk host (empty: local)
    isRemote,
    describe,
    run,            // shell command on the kiosk host
    readFile,       // text file on the kiosk host
    writeFile,
    end             // close the connection
}
