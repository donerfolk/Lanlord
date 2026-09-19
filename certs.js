// HTTPS for Lanlord, so the browser's clipboard/share APIs actually exist on a phone.
// (navigator.clipboard.write only works in a secure context; over plain http on the LAN it
// is simply absent, which is why "Copy image" could never work from an iPhone.)
//
// Two certs, not one self-signed cert: iOS only trusts a chain rooted in a CA you installed
// by hand, so the CA lives 10 years (install it on the phone once) while the server cert is
// short-lived and regenerated whenever the PC's LAN addresses change - trust survives DHCP.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, 'certs');
const CA_KEY = path.join(DIR, 'ca.key');
const CA_CRT = path.join(DIR, 'ca.crt');
const KEY = path.join(DIR, 'server.key');
const CRT = path.join(DIR, 'server.crt');
const RENEW_BEFORE_MS = 30 * 24 * 3600 * 1000;

// The Windows service doesn't inherit a shell PATH, so look where Git for Windows puts it.
function findOpenssl() {
  const candidates = [
    process.env.LANLORD_OPENSSL,
    'openssl',
    'C:/Program Files/Git/usr/bin/openssl.exe',
    'C:/Program Files/Git/mingw64/bin/openssl.exe',
    'C:/Program Files (x86)/Git/usr/bin/openssl.exe',
  ].filter(Boolean);
  for (const bin of candidates) {
    try { execFileSync(bin, ['version'], { stdio: 'ignore' }); return bin; } catch (e) { /* next */ }
  }
  return null;
}

// Every name this PC can be reached by. hostname.local is the one that survives an IP change.
function sanNames() {
  const host = os.hostname();
  const names = new Set([`${host}.local`, host, 'localhost']);
  const ips = new Set(['127.0.0.1']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) if (net.family === 'IPv4' && !net.internal) ips.add(net.address);
  }
  return { names: [...names], ips: [...ips] };
}

function certCovers(file, san) {
  try {
    const x = new crypto.X509Certificate(fs.readFileSync(file));
    if (Date.parse(x.validTo) - Date.now() < RENEW_BEFORE_MS) return false;
    // subjectAltName looks like: DNS:pc.local, DNS:localhost, IP Address:192.168.1.5
    const have = new Set(String(x.subjectAltName || '').split(',').map((s) => s.split(':').pop().trim()));
    return [...san.names, ...san.ips].every((n) => have.has(n));
  } catch (e) { return false; }
}

function ensureCerts() {
  const load = () => {
    try { return { key: fs.readFileSync(KEY), cert: fs.readFileSync(CRT), caPath: CA_CRT }; }
    catch (e) { return null; }
  };
  const san = sanNames();
  if (certCovers(CRT, san) && fs.existsSync(KEY)) return load();

  const openssl = findOpenssl();
  if (!openssl) return load(); // nothing to regenerate with - use whatever is on disk, if any
  const run = (args) => execFileSync(openssl, args, { stdio: 'pipe' });

  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(CA_CRT) || !fs.existsSync(CA_KEY)) {
    run(['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
      '-keyout', CA_KEY, '-out', CA_CRT, '-subj', `/CN=Lanlord CA (${os.hostname()})`,
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      // A phone that trusts this CA would otherwise trust it for every site on the internet, and
      // its key sits on this PC's disk. Limit it to the names and private ranges this server uses.
      '-addext', 'nameConstraints=critical,' + [
        `DNS:${os.hostname()}`, 'DNS:local', 'DNS:localhost',
        'IP:10.0.0.0/255.0.0.0', 'IP:172.16.0.0/255.240.0.0', 'IP:192.168.0.0/255.255.0.0',
        'IP:100.64.0.0/255.192.0.0', 'IP:127.0.0.0/255.0.0.0', 'IP:169.254.0.0/255.255.0.0',
      ].map((n) => 'permitted;' + n).join(',')]);
  }

  const altNames = [...san.names.map((n) => `DNS:${n}`), ...san.ips.map((ip) => `IP:${ip}`)].join(',');
  const csr = path.join(DIR, 'server.csr');
  const ext = path.join(DIR, 'server.ext');
  // 397 days: Apple rejects TLS server certs valid for longer, however they're issued.
  fs.writeFileSync(ext, [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    `subjectAltName=${altNames}`,
  ].join('\n') + '\n');
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', KEY, '-out', csr,
    '-subj', `/CN=${os.hostname()}.local`]);
  run(['x509', '-req', '-in', csr, '-CA', CA_CRT, '-CAkey', CA_KEY, '-CAcreateserial',
    '-days', '397', '-sha256', '-extfile', ext, '-out', CRT]);
  fs.rmSync(csr, { force: true });
  fs.rmSync(ext, { force: true });
  return load();
}

module.exports = { ensureCerts, sanNames, certCovers, findOpenssl, CA_CRT };
