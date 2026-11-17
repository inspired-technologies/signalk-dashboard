const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ssh2 = require('ssh2');

const remote = require('../remote');
const grafana = require('../grafana');

// stand-in for ssh2.Client - scripted command results, files in memory
function fakeSsh() {
  const host = { clients: [], commands: [], files: {}, results: {}, fail: null, options: [] };
  class FakeClient extends EventEmitter {
    constructor() {
      super();
      host.clients.push(this);
    }
    connect(options) {
      host.options.push(options);
      setImmediate(() => (host.fail ? this.emit('error', new Error(host.fail)) : this.emit('ready')));
    }
    exec(cmd, callback) {
      host.commands.push(cmd);
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      callback(null, stream);
      const match = Object.keys(host.results).find((k) => cmd.includes(k));
      const result = match ? host.results[match] : { stdout: '', code: 0 };
      setImmediate(() => {
        if (result.stdout) stream.emit('data', Buffer.from(result.stdout));
        if (result.stderr) stream.stderr.emit('data', Buffer.from(result.stderr));
        stream.emit('exit', result.code || 0);
        stream.emit('close');
      });
    }
    sftp(callback) {
      callback(null, {
        readFile: (file, encoding, cb) => setImmediate(() =>
          host.files[file] === undefined ? cb(new Error('No such file')) : cb(null, Buffer.from(host.files[file]))),
        writeFile: (file, data, encoding, cb) => setImmediate(() => {
          host.files[file] = data;
          cb(null);
        }),
        end: () => {},
      });
    }
    end() {
      setImmediate(() => this.emit('close'));
    }
  }
  return { host, FakeClient };
}

const run = (cmd) => new Promise((resolve) => remote.run(cmd, (error, stdout, stderr) => resolve({ error, stdout, stderr })));

describe('remote login', () => {
  it('takes user@host, port and key file from the configuration', () => {
    assert.deepEqual(remote.parse('pi@kiosk', undefined, '/keys/id'), { host: 'kiosk', port: 22, username: 'pi', keyFile: '/keys/id' });
    assert.deepEqual(remote.parse('pi@10.0.0.5', 2222, '/keys/id'), { host: '10.0.0.5', port: 2222, username: 'pi', keyFile: '/keys/id' });
    assert.equal(remote.parse(''), null);
    assert.equal(remote.parse(undefined), null);
  });

  it('accepts the former remote command ssh [-p port] [-i key file] user@host', () => {
    assert.deepEqual(remote.parse('ssh pi@kiosk', undefined, '/keys/id'), { host: 'kiosk', port: 22, username: 'pi', keyFile: '/keys/id' });
    assert.deepEqual(remote.parse('ssh -p 2222 -i /keys/legacy pi@kiosk'), { host: 'kiosk', port: 2222, username: 'pi', keyFile: '/keys/legacy' });
    // the options of the configuration win
    assert.deepEqual(remote.parse('ssh -p 2222 -i /keys/legacy pi@kiosk', 2200, '/keys/id'), { host: 'kiosk', port: 2200, username: 'pi', keyFile: '/keys/id' });
  });

  it('assumes nothing - user, key file and supported options are required', () => {
    assert.throws(() => remote.parse('kiosk', undefined, '/keys/id'), /not user@host/);
    assert.throws(() => remote.parse('ssh pi@kiosk'), /SSH key file required/);
    assert.throws(() => remote.parse('ssh -o BatchMode=yes pi@kiosk', undefined, '/keys/id'), /option -o not supported/);
    assert.throws(() => remote.parse('ssh -l pi kiosk', undefined, '/keys/id'), /option -l not supported/);
    assert.throws(() => remote.parse('ssh pi@kiosk uptime', undefined, '/keys/id'), /unexpected 'uptime'/);
    assert.throws(() => remote.parse('ssh -p', undefined, '/keys/id'), /missing value of -p/);
    assert.throws(() => remote.parse('pi@kiosk', 70000, '/keys/id'), /invalid ssh port/);
  });
});

describe('local execution', () => {
  before(() => remote.configure(''));

  it('runs commands with their exit code', async () => {
    const ok = await run('echo hello');
    assert.equal(ok.error, null);
    assert.equal(ok.stdout.trim(), 'hello');
    const failed = await run('exit 3');
    assert.equal(failed.error.code, 3);
  });

  it('reads and writes files', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-dashboard-')), 'kiosk.yaml');
    await new Promise((resolve, reject) => remote.writeFile(file, 'a: 1\n', (e) => (e ? reject(e) : resolve())));
    const data = await new Promise((resolve, reject) => remote.readFile(file, (e, d) => (e ? reject(e) : resolve(d))));
    assert.equal(data, 'a: 1\n');
  });
});

describe('remote execution over ssh2', () => {
  const original = ssh2.Client;
  let host;
  let keyFile;

  let encryptedKeyFile;

  before(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-dashboard-'));
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    keyFile = path.join(dir, 'id_test');
    fs.writeFileSync(keyFile, privateKey);
    const encrypted = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-128-cbc', passphrase: 'secret' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    encryptedKeyFile = path.join(dir, 'id_encrypted');
    fs.writeFileSync(encryptedKeyFile, encrypted.privateKey);
  });

  afterEach(() => {
    remote.configure('');
    ssh2.Client = original;
  });

  after(() => {
    ssh2.Client = original;
  });

  function connect(login = 'ssh pi@kiosk') {
    const fake = fakeSsh();
    host = fake.host;
    ssh2.Client = fake.FakeClient;
    remote.configure(login, undefined, keyFile);
  }

  it('shares one connection, passes the exit code and output', async () => {
    connect();
    host.results = { 'cat ': { stdout: '15\n' }, 'false': { stderr: 'denied', code: 1 } };
    const [a, b] = await Promise.all([run('cat /sys/class/backlight/*/brightness'), run('false')]);
    assert.equal(host.clients.length, 1);
    assert.equal(a.stdout, '15\n');
    assert.equal(a.error, null);
    assert.equal(b.error.code, 1);
    assert.equal(b.stderr, 'denied');
    assert.equal(host.options[0].username, 'pi');
    assert.equal(host.options[0].host, 'kiosk');
    assert.equal(String(host.options[0].privateKey), fs.readFileSync(keyFile, 'utf8'));
  });

  it('reconnects after the connection closed', async () => {
    connect();
    await run('true');
    host.clients[0].emit('close');
    await run('true');
    assert.equal(host.clients.length, 2);
  });

  it('reports connection and key errors to the callback', async () => {
    connect();
    host.fail = 'All configured authentication methods failed';
    const failed = await run('true');
    assert.match(failed.error.message, /authentication/);
  });

  it('rejects missing and passphrase protected keys - and then runs nothing, not even locally', async () => {
    assert.throws(() => remote.configure('pi@kiosk', undefined, path.join(path.dirname(keyFile), 'missing')), /not readable/);
    const missing = await run('echo local');
    assert.match(missing.error.message, /not readable/);
    assert.equal(missing.stdout, '');
    assert.throws(() => remote.configure('pi@kiosk', undefined, encryptedKeyFile), /keys with passphrase are not supported/);
    const written = await new Promise((resolve) => remote.writeFile(path.join(path.dirname(keyFile), 'local.yaml'), 'x', resolve));
    assert.match(written.message, /passphrase/);
    assert.equal(fs.existsSync(path.join(path.dirname(keyFile), 'local.yaml')), false);
  });

  it('reports a key removed after the start on the next connection', async () => {
    const replaced = path.join(path.dirname(keyFile), 'id_replaced');
    fs.copyFileSync(keyFile, replaced);
    const fake = fakeSsh();
    host = fake.host;
    ssh2.Client = fake.FakeClient;
    remote.configure('pi@kiosk', undefined, replaced);
    fs.unlinkSync(replaced);
    const failed = await run('true');
    assert.match(failed.error.message, /not readable/);
    assert.equal(host.clients.length, 0);
  });

  it('closes the connection on end', async () => {
    connect();
    await run('true');
    remote.end();
    await run('true');
    assert.equal(host.clients.length, 2);
  });

  it('grafana-kiosk: yaml via sftp before the restart, commands without local quoting', async () => {
    connect();
    host.files['/home/pi/kiosk.yaml'] = 'target:\n  URL: http://grafana/d/old\n';
    host.results = { 'systemctl status': { stdout: 'active\n' } };
    const statuses = [];
    const ok = grafana.init({
      autostart: true,
      launch: { command: 'grafana-kiosk', remote: 'ssh pi@kiosk', keyFile, params: '/home/pi/kiosk.yaml' },
      dashboard: { server: 'http://grafana', idle: 'idle' },
      boards: [{ state: 'sailing', uid: 'sail' }],
    }, null, (s) => statuses.push(s), (e) => statuses.push(`error ${e}`));
    assert.ok(ok);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(host.files['/home/pi/kiosk.yaml'], /URL: http:\/\/grafana\/d\/idle\?kiosk/);

    const status = await new Promise((resolve) => grafana.check('kiosk {pid}', resolve));
    assert.equal(status, 'active');
    assert.ok(host.commands.includes("sudo systemctl status grafana-kiosk | grep 'Active:' | awk '{print $2}'"));

    await new Promise((resolve) => grafana.next('sailing', resolve));
    assert.match(host.files['/home/pi/kiosk.yaml'], /URL: http:\/\/grafana\/d\/sail\?kiosk/);
    assert.equal(host.commands.at(-1), 'sleep 2 && sudo systemctl restart grafana-kiosk');
    assert.equal(host.clients.length, 1);
    grafana.stop();
  });

  it('grafana: brightness over the same connection', async () => {
    connect();
    host.results = { 'cat ': { stdout: '200\n' } };
    grafana.init({
      launch: { command: 'chromium-browser', remote: 'pi@kiosk', port: 2222, keyFile, params: '--kiosk' },
      dashboard: { server: 'http://grafana', idle: 'idle' },
    }, null, () => {}, () => {});
    const value = await new Promise((resolve) => grafana.set('brightness', 15, resolve, true));
    assert.equal(value, 15);
    assert.equal(host.commands.at(-1), 'echo 15 | sudo tee /sys/class/backlight/*/brightness');
    assert.equal(await new Promise((resolve) => grafana.get('brightness', resolve)), 200);
    assert.equal(host.clients.length, 1);
    assert.equal(host.options[0].port, 2222);
  });

  it('grafana: remote host without key file reported, no launch and no local brightness', async () => {
    const errors = [];
    const ok = grafana.init({
      autostart: true,
      launch: { command: 'chromium-browser', remote: 'pi@kiosk', params: '' },
      dashboard: { server: 'http://grafana', idle: 'idle' },
    }, null, () => {}, (e) => errors.push(e));
    assert.equal(ok, false);
    assert.match(errors[0], /remote host - SSH key file required/);
    const result = await run('echo local');
    assert.match(result.error.message, /SSH key file required/);
  });
});
