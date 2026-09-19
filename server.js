const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const archiver = require('archiver');
const { ensureCerts, CA_CRT } = require('./certs.js');

const PORT = Number(process.env.LANLORD_PORT) || 8811;
const HTTPS_PORT = Number(process.env.LANLORD_HTTPS_PORT) || PORT + 1;
// LANLORD_DIR moves the share somewhere else (a bigger disk, an existing folder). Relative
// values resolve against this folder, so the default is exactly the old ./shared. Everything
// else - trash, previews, .meta.json, the watcher, uploads - is derived from this one constant.
const SHARED_DIR = path.resolve(__dirname, process.env.LANLORD_DIR || 'shared');
const TRASH_DIR = path.join(SHARED_DIR, '.trash');
const TRASH_TTL_MS = 7 * 24 * 3600 * 1000;
const META_FILE = path.join(SHARED_DIR, '.meta.json');
const CLIPBOARD_FILE = path.join(SHARED_DIR, '.clipboard.json');
const DEVICES_FILE = path.join(__dirname, 'devices.json');
const AUTH_FILE = path.join(__dirname, 'auth.json');
// A share that contains the app folder would let a paired device replace server.js (and read
// auth.json and the certificate keys): the next restart would run their code as SYSTEM.
{
  const r = path.relative(SHARED_DIR, __dirname);
  if (r === '' || (!r.startsWith('..') && !path.isAbsolute(r))) throw new Error('LANLORD_DIR must not contain the Lanlord folder itself: ' + SHARED_DIR);
}
fs.mkdirSync(SHARED_DIR, { recursive: true });

// A share inside a cloud-synced folder quietly breaks the one promise Lanlord makes -
// that files stay in the house. Nothing here can stop it (it's the owner's folder), so say so.
// Segment-aware, or C:\OneDriveBackups would read as OneDrive.
const CLOUD_SEGMENTS = [
  [/^onedrive(\s*-\s*.+)?$/i, 'OneDrive'], // "OneDrive - Contoso" is the work/school one
  [/^(icloud ?drive|com~apple~clouddocs)$/i, 'iCloud Drive'],
  [/^dropbox(\s*\(.+\))?$/i, 'Dropbox'],
  [/^(google ?drive|my drive)$/i, 'Google Drive'],
];
const ONEDRIVE_ENV = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'];
// Name-based, so a folder synced by some other tool (or a junction into one) slips
// through. Covers the four services people actually have.
function cloudSyncService(dir, env) {
  const segments = String(dir).split(/[\\/]+/);
  for (const [re, name] of CLOUD_SEGMENTS) if (segments.some((s) => re.test(s))) return name;
  // OneDrive can be redirected anywhere ("Move folder"), and then the path says nothing -
  // but it always exports its root in the environment.
  const slashed = (p) => String(p).replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
  const here = slashed(dir);
  for (const key of ONEDRIVE_ENV) {
    const root = slashed((env && env[key]) || '');
    if (root && (here === root || here.startsWith(root + '/'))) return 'OneDrive';
  }
  return null;
}
const CLOUD_SYNC = cloudSyncService(SHARED_DIR, process.env);
const CLOUD_SYNC_WARNING = CLOUD_SYNC
  ? `The shared folder is inside ${CLOUD_SYNC}, so everything put in it is uploaded to ${CLOUD_SYNC}.`
  : null;

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
// Windows Defender (and other scanners) open a new file to scan it right after it lands, and a
// rename in that moment fails with EBUSY/EPERM/EACCES - an upload finishing, a move, a restore.
// Wait it out briefly instead of reporting an error for a file that is fine.
// A synchronous sleep, so the server stalls for at most ~1s in the rare case it fires;
// make the callers async if that ever matters.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function renameSync(from, to, tries = 6) {
  for (let i = 1; ; i++) {
    try { return fs.renameSync(from, to); } catch (e) {
      if (i >= tries || !['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e;
      pause(50 * 2 ** (i - 1)); // 50, 100, 200, 400, 800 ms
    }
  }
}

function saveJson(file, data) {
  // Write beside the file and rename over it: a crash or power cut mid-write would otherwise
  // leave truncated JSON, which loses metadata and - for auth.json - locks the owner out.
  // The temp name keeps the leading dot of state files so listings and the watcher skip it.
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
  } catch (e) {
    console.error('save failed:', file, e.message);
    try { fs.unlinkSync(tmp); } catch {}
  }
}
// Coalesce a burst of writes into one. The pending write must always be able to go out
// synchronously (flush), because half a second of metadata is still data. The timers are
// injectable so selftest.js can drive the window without waiting for it.
function debounced(write, waitMs, timers = { setTimeout, clearTimeout }) {
  let timer = null;
  const soon = () => {
    // Already on its way: the write serialises whatever the state is when it fires, so
    // there is nothing for a second timer to carry.
    if (timer) return;
    timer = timers.setTimeout(() => { timer = null; write(); }, waitMs);
  };
  soon.flush = () => {
    if (!timer) return false;
    timers.clearTimeout(timer);
    timer = null;
    write();
    return true;
  };
  soon.pending = () => timer !== null;
  return soon;
}

// No prototype on the maps keyed by client-supplied strings: a file or device named "__proto__"
// would otherwise write into Object.prototype for the whole process.
const dict = (o) => Object.assign(Object.create(null), o);
let meta = dict(loadJson(META_FILE, {})); // { filename: { addedBy, addedAt } }
let clipboard = loadJson(CLIPBOARD_FILE, []); // [{ id, text, at, from }]
let devices = dict(loadJson(DEVICES_FILE, {})); // { deviceId: { name, kind } }
const lastSeen = dict({}); // deviceId -> ms timestamp (transient, not persisted)
// What the page generates (genId). Anything else - markup, "__proto__" - is refused before it
// can be stored and rendered in everyone's Devices tab.
const DEVICE_ID = /^dev-[\w-]{4,96}$/;

const saveMeta = () => saveJson(META_FILE, meta);
// A 2000-photo upload rewrote the whole of .meta.json once per photo. This coalesces that
// burst into one write - and only that burst: every other caller pairs one metadata change
// with a filesystem change that is already on disk, and its attribution must not be able to
// outlive it. Flushed before the process goes down (see the exit hooks), so the last half
// second of a long upload is never the part that goes missing.
const saveMetaSoon = debounced(saveMeta, 500);
const saveClipboard = () => saveJson(CLIPBOARD_FILE, clipboard);
const saveDevices = () => saveJson(DEVICES_FILE, devices);

const HOST_ID = 'host';
const HOST_NAME = os.hostname();
const ONLINE_WINDOW_MS = 20000;

function detectKind(ua = '') {
  if (/iPad/i.test(ua)) return 'iPad';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/Android/i.test(ua)) return 'Android';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows PC';
  return 'Device';
}

function nameForDevice(req) {
  const id = req.headers['x-device-id'];
  // Only a request from the PC itself counts as the PC: any paired device could otherwise send
  // no id (or "host") and make its upload look like the PC added it.
  if (!id || id === HOST_ID) return isLoopback(req) ? HOST_NAME : detectKind(req.headers['user-agent']);
  return (devices[id] && devices[id].name) || detectKind(req.headers['user-agent']);
}
// A browser on this PC (localhost) IS the host - don't register it as a separate "Windows PC" device.
// A loopback address alone isn't enough: any web page open on this PC can DNS-rebind its own
// name to 127.0.0.1 (the Host header then still says evil.example), and a reverse proxy on
// this PC makes every outside request arrive from 127.0.0.1 (it adds X-Forwarded-For).
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', HOST_NAME.toLowerCase(), HOST_NAME.toLowerCase() + '.local']);
function isLoopback(req) {
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  return /^(::1$|::ffff:127\.|127\.)/.test(req.socket.remoteAddress || '') && LOCAL_HOSTS.has(host) && !req.headers['x-forwarded-for'];
}

// ---------- passcode gate ----------
// Being on the wifi is not the same as being trusted: everyone on the network can reach
// this port, so a shared passcode is the actual gate. It rides in a cookie once entered,
// so a paired phone never sees the unlock page again.
const TOKEN = (() => {
  if (process.env.LANLORD_TOKEN) return process.env.LANLORD_TOKEN;
  const saved = loadJson(AUTH_FILE, {}).token;
  if (saved) return saved;
  // 8 chars of unambiguous base32 (~40 bits): short enough to read off the screen and type,
  // far past brute-forcing over a LAN HTTP connection.
  const t = Array.from(crypto.randomBytes(8), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
  saveJson(AUTH_FILE, { token: t });
  return t;
})();

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
const sameToken = (v) => crypto.timingSafeEqual(sha(v), sha(TOKEN)); // constant time, and equal length whatever the input

function cookieToken(req) {
  const m = /(?:^|;\s*)ls_key=([^;]*)/.exec(req.headers.cookie || '');
  try { return m ? decodeURIComponent(m[1]) : ''; } catch (e) { return ''; }
}
// Drop the ?k=... once it's in the cookie, so the passcode stops riding in the address bar
// (and out of history / screenshots). Anything not a plain local path becomes '/'.
function stripKey(url) {
  const clean = String(url).replace(/([?&])k=[^&]*&?/, '$1').replace(/[?&]$/, '');
  return /^\/($|[^/])/.test(clean) ? clean : '/';
}
const LOGIN_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lanlord</title><style>
body{font:16px system-ui,-apple-system,sans-serif;background:#14161a;color:#e7e9ee;display:grid;place-items:center;height:100vh;margin:0}
form{display:grid;gap:12px;width:min(300px,84vw);text-align:center}
h1{font-size:19px;font-weight:600;margin:0}p{margin:0;color:#9aa2b1;font-size:13.5px}
input,button{font:inherit;padding:11px 13px;border-radius:11px;border:1px solid #2b3140}
input{background:#1c1f26;color:inherit;text-align:center;letter-spacing:3px;text-transform:uppercase}
button{background:#2569d6;color:#fff;border-color:transparent;font-weight:600}
</style><form method="get"><h1>Lanlord</h1><p>Enter the passcode shown on the PC.</p>
<input name="k" autofocus autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="passcode">
<button>Unlock</button></form>`;
const BLOCKED_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lanlord</title><style>body{font:16px system-ui,-apple-system,sans-serif;background:#14161a;color:#e7e9ee;display:grid;place-items:center;height:100vh;margin:0;padding:24px;text-align:center}</style>
<p>Too many wrong passcodes. Try again in a few minutes.`;

// 40 bits is far past guessing by hand, but nothing stopped a script on the wifi from
// trying the whole keyspace at LAN speed. Only a credential that was *presented and wrong*
// counts: a visitor with no cookie is just seeing the login page, and counting that would
// let the owner's own browser lock the phone out by reloading.
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_FAILS = 10;
const authFails = new Map(); // ip -> { n, until }
// The host PC can never lock itself out, even if this is ever called before the gate's own
// loopback check (::ffff: forms are normalised away by the caller, matched here anyway).
const LOOPBACK_IP = /^(::1$|::ffff:127\.|127\.)/;
function authBlocked(ip, now = Date.now()) {
  if (LOOPBACK_IP.test(ip)) return false;
  const hit = authFails.get(ip);
  return !!hit && hit.n >= AUTH_MAX_FAILS && now < hit.until;
}
// Returns whether this IP is now blocked. A correct passcode forgives the earlier misses.
function noteAuthAttempt(ip, ok, now = Date.now()) {
  if (LOOPBACK_IP.test(ip)) return false;
  if (ok) { authFails.delete(ip); return false; }
  // Swept only on a failure, so the ceiling is one small entry per IP that has
  // ever guessed wrong, held until the next wrong guess from anyone. A household LAN has
  // tens of addresses; a spoofed-source flood could grow it until then.
  for (const [k, v] of authFails) if (v.until <= now) authFails.delete(k);
  if (authFails.size > 10000) authFails.clear(); // a flood of made-up addresses mustn't grow it forever
  const hit = authFails.get(ip);
  const open = hit && now < hit.until;
  const n = open ? hit.n + 1 : 1;
  authFails.set(ip, { n, until: open ? hit.until : now + AUTH_WINDOW_MS });
  return n >= AUTH_MAX_FAILS;
}
function tooManyAttempts(req, res) {
  res.status(429).set('Retry-After', String(AUTH_WINDOW_MS / 1000));
  if (req.path.startsWith('/api/') || !req.accepts('html')) return res.json({ error: 'too many attempts' });
  res.type('html').send(BLOCKED_PAGE);
}

// Windows won't write these; leading dots would hide the file from the listing (and could
// clobber .meta.json / .clipboard.json). Trailing dots/spaces are dropped last, because
// Windows drops them silently on write - the file would land under a name we never recorded
// in .meta.json, so its attribution would be lost.
function safeFileName(name) {
  // NFC: an iPhone/Mac spells "é" as e + combining accent, Windows as one character - the same
  // name typed on each would otherwise be two different files that look identical.
  // Right-to-left and other direction marks go too: "invoice\u202Efdp.exe" displays as "invoiceexe.pdf".
  const cleaned = path.basename(String(name).normalize('NFC')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/^\.+/, '').trim().replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)\s*(\..*)?$/i.test(cleaned)) return '_' + cleaned; // reserved device names
  // Explorer acts on these just by showing the folder (a .url or .scf can make it connect to
  // another machine and send your Windows password hash), so they arrive as plain text.
  if (/\.(url|lnk|scf|library-ms|searchconnector-ms)$/i.test(cleaned) || /^desktop\.ini$/i.test(cleaned)) return cleaned + '.txt';
  return cleaned || 'file';
}
const IGNORED = /^(thumbs\.db|desktop\.ini)$/i;
// The stats run in parallel on libuv's threads rather than one by one on the thread every request
// shares: a 2000-photo folder stood the whole server still for 130-270ms per listing (~40ms this
// way, and the server keeps answering) - per device, on every change, all through a bulk upload.
async function listShared(dir) {
  const names = (await fs.promises.readdir(dir)).filter((n) => !n.startsWith('.') && !IGNORED.test(n));
  const stats = await Promise.all(names.map((n) => fs.promises.stat(path.join(dir, n)).catch(() => null))); // null: vanished between readdir and stat
  const out = [];
  names.forEach((name, i) => {
    const stat = stats[i];
    if (stat && (stat.isFile() || stat.isDirectory())) out.push({ name, stat, isDir: stat.isDirectory() });
  });
  return out;
}
// Recursive file count + bytes - a folder's "size" in the listing, and the whole-share totals.
// Subfolders come out of the cache, so after a change only the folders on its path are re-read.
function walkStats(dir, now) {
  let files = 0, bytes = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return { files, bytes }; }
  for (const e of entries) {
    if (e.name.startsWith('.') || IGNORED.test(e.name)) continue;
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) { const s = walkStatsCached(p, now); files += s.files; bytes += s.bytes; }
      else { files++; bytes += fs.statSync(p).size; }
    } catch (err) { /* vanished */ }
  }
  return { files, bytes };
}
// A listing shows every subfolder's recursive size and /api/stats the whole share's, and every
// connected device asks for both on every change and every couple of seconds. On Windows a stat
// is ~50µs (more while Defender scans a new file), so a 20k-file share was a 1-9 second walk -
// synchronous, so uploads and every other request stood still for it, every 5s even when idle.
// So a size is kept until something under that folder changes: changed() drops exactly the
// folders a change can move, and the watcher calls it for whatever Explorer does.
// The TTL is only the backstop for what neither sees - a recursive fs.watch this platform
// doesn't support, or a path that reached the cache spelled in different case.
// Those cases show a stale folder size for up to the TTL, and an open page pays one
// full walk per TTL; shorten it if one of them ever becomes the normal case, or make the walk
// async if that one walk ever shows.
const WALK_TTL_MS = 5 * 60 * 1000;
// One entry per folder, and the recursive walk visits them all, so the ceiling is the
// folder count of the share. Cleared outright past this, rather than evicting cleverly - the
// next listing just walks again.
const WALK_CACHE_MAX = 20000;
const walkCache = new Map(); // absolute dir -> { at, val }
function walkStatsCached(dir, now = Date.now()) {
  const hit = walkCache.get(dir);
  if (hit && now - hit.at < WALK_TTL_MS) return hit.val;
  const val = walkStats(dir, now);
  if (walkCache.size >= WALK_CACHE_MAX) walkCache.clear();
  walkCache.set(dir, { at: now, val });
  return val;
}
// Something at `abs` was added, removed, renamed or rewritten: every folder above it has a new
// size, and so does anything cached below it (a renamed folder's old name can come back later
// holding something else). Siblings keep theirs.
function changed(abs) {
  for (const k of walkCache.keys()) if (k.startsWith(abs + path.sep)) walkCache.delete(k);
  for (let d = abs; d.startsWith(SHARED_DIR); d = path.dirname(d)) {
    walkCache.delete(d);
    if (d === SHARED_DIR || d === path.dirname(d)) break;
  }
}
const sharedTotals = () => walkStatsCached(SHARED_DIR);

// ---------- free space ----------
function diskSpace(dir) {
  const st = fs.statfsSync(dir);
  return { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
}
// An upload used to run until the disk was full, fail, and leave the partial file behind -
// and a system disk filled to the last byte takes Windows down with it. So an upload has to
// fit with a margin to spare: 1 GB, or 2% of a small disk (a USB stick shouldn't lose a
// whole gigabyte of itself to the margin).
const SPACE_MARGIN_BYTES = 1024 ** 3;
function roomFor(freeBytes, neededBytes, diskBytes) {
  return freeBytes - Math.min(SPACE_MARGIN_BYTES, diskBytes * 0.02) >= neededBytes;
}
// null = go ahead, else the 507 body to refuse with. A disk that can't be asked is let through.
// Asks about the share's own disk, so a subfolder that is a junction to another
// drive is judged by the wrong one; statfs the upload's own folder if anyone ever does that.
function noRoom(neededBytes) {
  let d;
  try { d = diskSpace(SHARED_DIR); } catch (e) { return null; }
  return roomFor(d.free, neededBytes, d.total) ? null : { error: 'not enough space', freeBytes: d.free, neededBytes };
}
// Multer can't know the size up front, so the multipart routes go by Content-Length (none:
// let it through). Before countBytesOnRequest, so a refused body isn't counted as a transfer.
// Hanging up at once doesn't work: closing a socket with unread bytes in it sends a reset, and
// the client, still sending, never reads the 507 (measured). So the rest is read and thrown
// away for a moment, and only a body still arriving after that gets the connection cut.
// A client that reads nothing until it has sent everything still sees a reset.
const REFUSED_LINGER_MS = 2000;
function checkRoom(req, res, next) {
  const len = Number(req.headers['content-length']);
  const full = len > 0 && noRoom(len);
  if (!full) return next();
  req.resume();
  res.status(507).json(full);
  setTimeout(() => { if (!req.complete) req.socket.destroy(); }, REFUSED_LINGER_MS).unref();
}

// ---------- transfer speed / daily total tracking ----------
let bytesToday = 0;
let todayKey = new Date().toDateString();
const recentBytes = []; // ring buffer of { t, n } for the last few seconds

// ---------- keep the PC awake while something is transferring ----------
// Windows sleeping halfway through a 4K upload drops it. While bytes are moving, a small
// PowerShell holds a "system required" power request; two quiet minutes later it's killed,
// which releases the request (it belongs to that process). Screen-off is still allowed.
const AWAKE_IDLE_MS = 2 * 60 * 1000;
const AWAKE_PS = "Add-Type -Name P -Namespace W -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'; " +
  "[void][W.P]::SetThreadExecutionState([uint32]2147483649); [void][Console]::In.ReadLine()"; // ES_CONTINUOUS|ES_SYSTEM_REQUIRED, then wait to be killed
let awakeProc = null, lastTransfer = 0;
function keepAwake() {
  lastTransfer = Date.now();
  if (awakeProc || process.platform !== 'win32' || require.main !== module) return;
  try {
    awakeProc = require('child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', AWAKE_PS], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  } catch (e) { awakeProc = null; return; }
  const proc = awakeProc;
  proc.on('error', () => { if (awakeProc === proc) awakeProc = null; });
  proc.on('exit', () => { if (awakeProc === proc) awakeProc = null; });
  const t = setInterval(() => {
    if (awakeProc !== proc) return clearInterval(t);
    if (Date.now() - lastTransfer > AWAKE_IDLE_MS) { clearInterval(t); proc.kill(); }
  }, 15000);
  t.unref();
}
process.on('exit', () => { if (awakeProc) awakeProc.kill(); });

function recordBytes(n) {
  if (!n) return;
  keepAwake();
  const now = Date.now();
  const key = new Date().toDateString();
  if (key !== todayKey) { todayKey = key; bytesToday = 0; }
  bytesToday += n;
  recentBytes.push({ t: now, n });
  while (recentBytes.length && now - recentBytes[0].t > 4000) recentBytes.shift();
}
function currentSpeedBps() {
  const now = Date.now();
  const windowMs = 4000;
  let sum = 0;
  for (const r of recentBytes) if (now - r.t <= windowMs) sum += r.n;
  return sum / (windowMs / 1000);
}
function countBytesOnResponse(req, res, next) {
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  res.write = (chunk, ...args) => { if (chunk) recordBytes(chunk.length); return origWrite(chunk, ...args); };
  res.end = (chunk, ...args) => { if (chunk && Buffer.isBuffer(chunk)) recordBytes(chunk.length); return origEnd(chunk, ...args); };
  next();
}
function countBytesOnRequest(req, res, next) {
  req.on('data', (chunk) => recordBytes(chunk.length));
  next();
}

// Clean a client-supplied relative path to "a/b/c", '' for the share root, or null if any
// segment is bogus. No segment may start with a dot, which rules out "." and ".." (so it
// can't escape) and the .meta.json / .clipboard.json state files.
function normRel(rel) {
  if (typeof rel !== 'string' || !rel) return '';
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  // ':' would name an NTFS alternate data stream (photo.jpg:Zone.Identifier), never a real file.
  if (!parts.length || parts.some((p) => p.startsWith('.') || p.includes(':'))) return null;
  return parts.join('/');
}
// Resolve a client-supplied name inside SHARED_DIR, or null if it tries to escape.
// (path.join alone isn't enough: "../shared-other/x" still startsWith(SHARED_DIR).)
function safeSharedPath(name) {
  const rel = normRel(name);
  if (!rel) return null; // '' is the root folder, never a file/folder target
  const p = path.resolve(SHARED_DIR, rel);
  return p.startsWith(SHARED_DIR + path.sep) && realInside(p) ? p : null;
}
// The names a client sends aren't the whole story on Windows: "TRASH~1" is the 8.3 short name of
// .trash and "META~1.JSO" of .meta.json, and neither starts with a dot. A junction can also point
// out of the share. So resolve what exists of the path on disk and check that again.
const SHARED_REAL = (() => { try { return fs.realpathSync.native(SHARED_DIR); } catch (e) { return SHARED_DIR; } })();
function realInside(p) {
  let base = p;
  const rest = [];
  while (!fs.existsSync(base)) { // a new file or folder: check the part that already exists
    const up = path.dirname(base);
    if (up === base) return false;
    rest.unshift(path.basename(base));
    base = up;
  }
  let real;
  try { real = fs.realpathSync.native(base); } catch (e) { return false; }
  const rel = path.relative(SHARED_REAL, path.join(real, ...rest));
  if (rel === '') return true; // the share itself
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return !rel.split(path.sep).some((seg) => seg.startsWith('.'));
}
// Same, but '' / missing means the share root itself.
function safeDir(rel) {
  const r = normRel(rel);
  if (r === null) return null;
  return r === '' ? SHARED_DIR : safeSharedPath(r);
}
// Follow a rename/move in the metadata, including everything inside a moved folder.
// save=false is for a caller moving many things in one go, which then saves once itself.
function moveMeta(fromRel, toRel, save = true) {
  for (const k of Object.keys(meta)) {
    if (k !== fromRel && !k.startsWith(fromRel + '/')) continue;
    meta[toRel + k.slice(fromRel.length)] = meta[k];
    delete meta[k];
  }
  if (save) saveMeta();
}

// Turn "photo (1).jpg" collisions into "photo (2).jpg" instead of overwriting.
function uniqueName(dir, originalName) {
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext);
  let candidate = originalName;
  let n = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base} (${n})${ext}`;
    n++;
  }
  return candidate;
}

// ---------- trash ----------
// Deleting moves into .trash rather than unlinking, so a mis-tap on a phone is undoable.
// The original location rides in the entry name (the dot folder is hidden from every
// listing and from the totals, so nothing else has to know it exists).
function trashName(rel) { return Date.now() + '__' + encodeURIComponent(rel); }
function trashStamp(entry) { return Number(String(entry).slice(0, String(entry).indexOf('__'))); }
function trashOrigin(entry) {
  const i = String(entry).indexOf('__');
  if (i === -1 || !(trashStamp(entry) > 0)) return null; // no stamp -> not something we wrote
  try { return normRel(decodeURIComponent(String(entry).slice(i + 2))) || null; } catch (e) { return null; }
}
function pruneTrash() {
  let entries = [];
  try { entries = fs.readdirSync(TRASH_DIR); } catch (e) { return; } // no trash yet
  for (const e of entries) {
    // NaN stamp -> not something we wrote -> goes too.
    if (!(Date.now() - trashStamp(e) < TRASH_TTL_MS)) fs.rm(path.join(TRASH_DIR, e), { recursive: true, force: true }, () => {});
  }
}

// ---------- phone-friendly video ----------
// Phones won't play (or save to Photos) an MKV/AVI/etc. ffmpeg rewraps it as MP4 - a
// copy of the same streams, instant and lossless, when they're already H.264/HEVC + AAC
// (e.g. OBS recordings), a real re-encode otherwise. The original goes to the trash, unless
// the MP4 had to leave something behind (see mp4Args) - then it stays put as the only copy.
const CONVERT_EXTS = /\.(mkv|avi|flv|wmv|webm|ts|mpg|mpeg|3gp)$/i;
// The service runs as LocalSystem, whose PATH doesn't have a per-user winget install.
// Only this account's own WinGet folder. Searching every profile under C:\Users let any other
// Windows account (or anyone who can write C:\ProgramData, which "All Users" points at) plant
// an ffmpeg.exe that the service would then run as SYSTEM. The service's own account has no
// WinGet install, so install-service.js resolves the path as the owner and pins it in
// LANLORD_FFMPEG.
function findFfmpeg(env = process.env) {
  if (env.LANLORD_FFMPEG) return env.LANLORD_FFMPEG;
  const local = env.LOCALAPPDATA;
  if (!local) return 'ffmpeg';
  const ls = (dir) => { try { return fs.readdirSync(dir); } catch (e) { return []; } };
  const found = [path.join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe')];
  const pkgs = path.join(local, 'Microsoft', 'WinGet', 'Packages');
  for (const pkg of ls(pkgs).filter((d) => /ffmpeg/i.test(d)))
    for (const build of ls(path.join(pkgs, pkg))) found.push(path.join(pkgs, pkg, build, 'bin', 'ffmpeg.exe'));
  return found.find((f) => fs.existsSync(f)) || 'ffmpeg'; // fall back to PATH
}
const FFMPEG = findFfmpeg();
// ffmpeg picks a demuxer from a file's content, not its name, and some demuxers (HLS, DASH,
// concat) are playlists that open other files. An uploaded "video" that is really a playlist
// pointing at C:\Users\... would get that file converted into the share - as SYSTEM. So every
// input is limited to plain containers: everything Lanlord handles (mov/mp4/HEIC, mkv/webm,
// avi, ts, flv, wmv, mpg, jpg/png/webp/bmp/gif) and nothing that references other files.
const MEDIA_ONLY = ['-format_whitelist', 'mov,matroska,avi,mpegts,flv,asf,mpeg,image2,gif,jpeg_pipe,png_pipe,webp_pipe,bmp_pipe'];
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    require('child_process').execFile(cmd, args, { windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}
// Subtitles MP4 can hold, once converted to mov_text. The image-based ones (PGS on a Blu-ray
// rip, dvdsub, ...) it cannot hold at all, so they are the reason an original gets kept.
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
// streams: ffprobe's [{ index, codec_type, codec_name }, ...] -> { args, dropped }: the ffmpeg
// args between input and output, and how many streams carrying content had to be left out.
// Every audio track is kept (an MKV's second track is usually the original-language dub, and
// losing it was silent data loss once the trashed original purged); text subtitles come along.
function mp4Args(streams) {
  const ofType = (t) => streams.filter((s) => s.codec_type === t);
  const video = ofType('video')[0]; // first video stream only, as before - the rest is cover art
  const audio = ofType('audio');
  const subs = ofType('subtitle');
  const text = subs.filter((s) => TEXT_SUBS.has(s.codec_name));
  const maps = [];
  for (const s of [...(video ? [video] : []), ...audio, ...text]) maps.push('-map', `0:${s.index}`);
  const v = !video ? [] : video.codec_name === 'h264' ? ['-c:v', 'copy'] : video.codec_name === 'hevc' ? ['-c:v', 'copy', '-tag:v', 'hvc1'] // hvc1 tag or iOS refuses it
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'];
  const a = audio.length ? [] : ['-an'];
  // Output-stream numbering, not input: -c:a:1 is the second audio track of the MP4.
  audio.forEach((s, i) => a.push(...(s.codec_name === 'aac' ? [`-c:a:${i}`, 'copy'] : [`-c:a:${i}`, 'aac', `-b:a:${i}`, '192k'])));
  // Only unusable subtitles count as lost content. Attachments (ASS fonts) and the
  // data streams every .ts carries are dropped silently - counting them would leave an
  // original next to nearly every converted file.
  return { args: [...maps, ...v, ...a, ...(text.length ? ['-c:s', 'mov_text'] : []), '-movflags', '+faststart'], dropped: subs.length - text.length };
}

// ---------- has it finished arriving? ----------
// A copy from a phone or a slow network share can stall for longer than any fixed settle wait.
// Converting a half-written file loses the tail of the video for good, because the original
// then goes to the trash and purges. So two independent signals have to agree first: the file
// held still, and nothing else has it open for writing. Files the server wrote itself are
// exempt - see needsSettle.
const CONVERT_SETTLE_MS = 4000;
const CONVERT_MAX_WAIT_MS = 10 * 60 * 1000;
const CONVERT_DELAY_CAP_MS = 60 * 1000;
// The wait before check `attempt` (1-based) and what the waits add up to by then: doubling from
// CONVERT_SETTLE_MS up to a one-minute ceiling, so a long stall is still re-checked often
// enough. giveUp once the total would pass the budget - a copy that hasn't finished in ten
// minutes is stalled, not slow, and the retry timer must not run forever. The schedule is
// 4+8+16+32 then 9x60 = exactly 600s over 13 checks.
function convertBackoff(attempt) {
  let delayMs = 0, totalMs = 0;
  for (let i = 1; i <= attempt; i++) {
    delayMs = Math.min(CONVERT_SETTLE_MS * 2 ** (i - 1), CONVERT_DELAY_CAP_MS);
    totalMs += delayMs;
  }
  return { delayMs, totalMs, giveUp: totalMs > CONVERT_MAX_WAIT_MS };
}
// Two { size, mtimeMs } snapshots -> did the file hold still between them? A missing snapshot
// (first check, or the file vanished) is never stability.
function sameSnap(a, b) {
  return !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs;
}
function statSnap(abs) {
  try { const s = fs.statSync(abs); return { size: s.size, mtimeMs: s.mtimeMs, mode: s.mode }; } catch (e) { return null; }
}
// Windows reports 0o444 for a file with the read-only attribute and 0o666 otherwise. Such a
// file can never be opened for writing, so the exclusive probe below would call it locked
// forever and the retry loop would give up on a perfectly finished video.
function isReadOnly(mode) {
  return (mode & 0o200) === 0;
}
// Size and mtime can both sit still mid-stall, so this is the honest half of the answer:
// Windows gives the copying process an exclusive handle, and an open for writing fails until
// it lets go. Only asked about files that aren't read-only - see stableEnough for those.
function unlocked(abs) {
  let fd = null;
  try {
    fd = fs.openSync(abs, 'r+');
    return true;
  } catch (e) {
    // EBUSY/EPERM/EACCES all mean "someone still has it" here, so they are all a retry. Every
    // other code (ENOENT for a file that vanished) is not ready either, and the existence check
    // at the top of the next attempt is what ends the loop for those.
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd); // our own leaked handle would block the next check
  }
}
// How many checks in a row have to agree before the file counts as finished. A read-only file
// has no exclusive probe to back the answer up (both Explorer and robocopy carry the read-only
// attribute across with the bytes, so the destination is read-only for the whole copy), so it
// has to hold still twice instead. Measured on a 3 GB copy: the destination is created at its
// full final size straight away, so size alone proves nothing - but mtime moves every ~120ms
// until the copy finishes and only then lands on the source's. That moving mtime is what
// catches a copy in progress, and two agreeing intervals is the margin.
// A copy of a read-only file that freezes for two whole intervals and then resumes
// still slips through. Closing that needs a share-mode open Node doesn't expose.
function stableEnough(runs, readOnly) {
  return runs >= (readOnly ? 2 : 1);
}
// Where a file came from decides whether it has to prove it is complete at all.
//   'upload'  - our own /api/upload or /api/share; multer wrote and closed it, so it is
//               complete by construction and waiting would just delay the MP4.
//   'watch'   - an Explorer drop or a copy off a network share: the slow-copy case this whole
//               settle loop exists for.
//   'startup' - already sitting in the share when the service started, which sounds safe but
//               isn't: a reboot or a service restart can interrupt a copy that is still
//               running, and that file looks exactly like a finished one. So it settles too;
//               an idle file passes on the second look, which costs it a few seconds.
// Anything unrecognised settles, because that is the direction that can't lose a video.
function needsSettle(source) {
  return source !== 'upload';
}
// .ts is both an MPEG transport stream and a TypeScript source file. A real one starts with
// the 0x47 sync byte; without this check a source file gets probed, retried and finally
// reported as a video that never finished arriving.
const TS_SYNC_BYTE = 0x47;
// A name plus its first byte (null or empty = we couldn't read one) -> is this ours to convert?
function isConvertible(name, head) {
  if (!CONVERT_EXTS.test(name)) return false;
  if (!/\.ts$/i.test(name)) return true; // every other extension on the list is unambiguous
  return !!head && head.length > 0 && head[0] === TS_SYNC_BYTE;
}
function firstByte(abs) {
  let fd = null;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(1);
    return fs.readSync(fd, buf, 0, 1, 0) === 1 ? buf : Buffer.alloc(0); // an empty file has no first byte
  } catch (e) {
    return Buffer.alloc(0); // unreadable or already gone: "can't tell"
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// One at a time (a re-encode pegs the CPU), each file once.
const convertTimers = new Map();
let convertChain = Promise.resolve();
function queueConvert(abs, source) {
  if (!CONVERT_EXTS.test(abs)) return;
  const settle = needsSettle(source);
  // fs.watch fires once per written chunk. Re-arming the timer on every event used to be the
  // whole settle; now one loop per file is already watching it, and restarting that loop would
  // reset the attempt count, so the ten-minute give-up would never arrive.
  if (settle && convertTimers.has(abs)) return;
  // A .ts still locked by its copier reads as "can't tell" and is skipped here -
  // the next startup's convertExisting() scan picks it up.
  if (!CONVERT_EXTS.test(abs) || !isConvertible(abs, firstByte(abs))) return; // extension first: the watcher reports every file, and most aren't videos
  if (!settle) {
    // The watcher can see multer's write before the request handler gets here; that pending
    // settle loop is waiting on a file we already know is finished.
    clearTimeout(convertTimers.get(abs));
    convertTimers.delete(abs);
    return void convertSoon(abs);
  }
  settleThenConvert(abs, 1, null, 0, CONVERT_SETTLE_MS);
}
function convertSoon(abs) {
  convertChain = convertChain.then(() => convertToMp4(abs)).catch((e) => console.error('convert failed:', abs, e.message));
}
// Check number `attempt` happens delayMs from now; `runs` is how many checks have agreed so
// far. Convert once enough of them agree and nothing holds the file open for writing;
// otherwise back off and look again.
function settleThenConvert(abs, attempt, prev, runs, delayMs) {
  const t = setTimeout(() => {
    convertTimers.delete(abs);
    const snap = statSnap(abs);
    if (!snap) return; // renamed, deleted or already converted while we waited
    const agreed = sameSnap(prev, snap) ? runs + 1 : 0;
    const readOnly = isReadOnly(snap.mode);
    if (stableEnough(agreed, readOnly) && (readOnly || unlocked(abs))) return void convertSoon(abs);
    const next = convertBackoff(attempt + 1);
    if (next.giveUp) {
      console.error('convert gave up after ' + Math.round(CONVERT_MAX_WAIT_MS / 60000) + ' minutes, file never stopped changing:', abs);
      return;
    }
    settleThenConvert(abs, attempt + 1, snap, agreed, next.delayMs);
  }, delayMs);
  t.unref(); // a pending retry must not hold the process open (selftest.js requires this file)
  convertTimers.set(abs, t);
}
async function convertToMp4(abs) {
  if (!fs.existsSync(abs)) return;
  const rel = path.relative(SHARED_DIR, abs).split(path.sep).join('/');
  // Checked here, not in queueConvert: a kept original gets queued again anyway (reading it
  // for the conversion touches its last-access time, which the watcher reports as a change),
  // and that queued run only reaches this point once the conversion ahead of it has finished.
  if (meta[rel] && meta[rel].converted) return;
  const probe = JSON.parse(await run(FFPROBE, [...MEDIA_ONLY, '-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name', '-of', 'json', abs]));
  const streams = probe.streams || [];
  if (!streams.some((s) => s.codec_type === 'video')) return; // audio-only .webm etc. - not ours to touch
  const { args, dropped } = mp4Args(streams);
  const dir = path.dirname(abs);
  const tmp = path.join(dir, `.converting-${Date.now()}.mp4`); // dot name: hidden from listings and the watcher
  try {
    await run(FFMPEG, ['-y', '-v', 'error', ...MEDIA_ONLY, '-i', abs, ...args, tmp]);
    const name = uniqueName(dir, path.basename(abs).replace(CONVERT_EXTS, '.mp4')); // never the kept original's name: different extension, and unique anyway
    renameSync(tmp, path.join(dir, name));
    const newRel = path.relative(SHARED_DIR, path.join(dir, name)).split(path.sep).join('/');
    if (meta[rel]) meta[newRel] = meta[rel];
    if (dropped) {
      // The MP4 can't hold those subtitles, so the original is the only copy left - keeping it
      // in the share beats the trash, which purges after 7 days. The flag is what stops the
      // next startup scan (and the watcher) converting it over and over.
      meta[rel] = Object.assign({}, meta[rel], { converted: true }); // a new object: meta[newRel] may be the old one
      saveMeta();
      console.log('converted to mp4, kept the original (' + dropped + ' subtitle stream(s) MP4 cannot hold):', rel, '->', newRel);
    } else {
      const entry = trashName(rel);
      fs.mkdirSync(TRASH_DIR, { recursive: true });
      renameSync(abs, path.join(TRASH_DIR, entry));
      moveMeta(rel, '.trash/' + entry);
      console.log('converted to mp4:', rel, '->', newRel);
    }
    changed(abs);
    bump();
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
}
// ---------- compress (on request, not automatic) ----------
// quality 10..100 and scale 10..100 (% of width) from the sliders -> ffmpeg args and the
// output extension. JPEG/HEIC/PNG come out as JPEG (PNG has no lossy mode to dial down),
// WebP stays WebP, video becomes H.264 MP4.
const COMPRESS_EXTS = /\.(jpe?g|png|heic|heif|webp|bmp|mov|mp4|m4v|mkv|avi|webm)$/i;
const COMPRESS_VIDEO_EXTS = /\.(mov|mp4|m4v|mkv|avi|webm)$/i;
// HLG (every iPhone video) and PQ. Squeezed straight into 8-bit bt709 the curve is never
// undone, so the result looks washed out - grey where the wall was beige.
const HDR_TRANSFERS = new Set(['arib-std-b67', 'smpte2084']);
// src is what only the file itself can answer, from compressSource: { hdr, zscale }. Kept a
// parameter rather than probed in here so the decision stays pure and testable.
function compressArgs(file, quality, scale, src = {}) {
  const q = Math.min(100, Math.max(10, Math.round(Number(quality) || 75)));
  const s = Math.min(100, Math.max(10, Math.round(Number(scale) || 100))) / 100;
  const ext = path.extname(file).toLowerCase();
  if (COMPRESS_VIDEO_EXTS.test(ext)) {
    const vf = s < 1 ? [`scale=trunc(iw*${s}/2)*2:-2`] : []; // x264 needs even dimensions
    // Scale first, then tone-map: same picture, far fewer pixels through the expensive part.
    // zscale linearises the HDR curve, tonemap squeezes the range into what SDR can hold,
    // the second zscale hands it back as bt709 - which is also how the MP4 ends up tagged
    // bt709 instead of claiming to be HLG. Not every ffmpeg build has zscale; without it the
    // old washed-out encode still beats an encode that fails.
    if (src.hdr && src.zscale) vf.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv', 'format=yuv420p');
    return { ext: '.mp4', args: ['-map', '0:v:0', '-map', '0:a:0?', ...(vf.length ? ['-vf', vf.join(',')] : []), '-c:v', 'libx264', '-preset', 'faster', '-crf', String(Math.round(18 + (100 - q) * 0.24)), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'] };
  }
  // -filter_complex, not -vf: an iPhone HEIC is a grid of tiles, which ffmpeg stitches with a
  // complex filtergraph of its own, and it refuses to put a simple -vf on top of that ("Simple
  // and complex filtering cannot be used together") - so scaling a HEIC failed outright. For a
  // plain JPEG the two forms produce byte-identical output.
  const vf = s < 1 ? ['-filter_complex', `scale=trunc(iw*${s}):-2`] : [];
  // -map_metadata 0 is ffmpeg's own default, said out loud so a future change of that default
  // can't quietly strip a photo. It only carries what the muxer can write, and for a JPEG that
  // turns out to be nothing at all, HEIC source or JPEG - copyExif is what saves the capture date.
  if (ext === '.webp') return { ext, args: [...vf, '-map_metadata', '0', '-c:v', 'libwebp', '-quality', String(q), '-frames:v', '1'] };
  return { ext: '.jpg', args: [...vf, '-map_metadata', '0', '-q:v', String(Math.round(2 + (100 - q) * 0.29)), '-frames:v', '1'] }; // mjpeg q: 2 best .. 31 worst
}

// Checked once, lazily, and only when an HDR file actually turns up: the tone-map chain needs
// zscale, which the Gyan full build has but a bare `ffmpeg` on PATH may not.
let zscalePromise = null;
function hasZscale() {
  if (!zscalePromise) zscalePromise = run(FFMPEG, ['-hide_banner', '-filters']).then((out) => /\bzscale\b/.test(out), () => false);
  return zscalePromise;
}

// One ffprobe of the stream header - no decoding - for the two things the args depend on.
// Images get no probe at all: they have no duration and cannot be HDR here.
async function compressSource(abs) {
  if (!COMPRESS_VIDEO_EXTS.test(path.extname(abs))) return {};
  const probe = JSON.parse(await run(FFPROBE, [...MEDIA_ONLY, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_transfer:format=duration', '-of', 'json', abs]));
  const hdr = HDR_TRANSFERS.has(((probe.streams || [])[0] || {}).color_transfer);
  return { duration: Number(probe.format && probe.format.duration) || 0, hdr, zscale: hdr ? await hasZscale() : false };
}

// ffmpeg reads EXIF - ffprobe even prints "EXIF metadata: (2600 bytes)" for an iPhone HEIC -
// but it cannot write one back (its `exif` side data is decode-only), so a compressed photo used
// to come out with no capture date, camera or GPS whatever the source was. Lift the source's
// EXIF across ourselves. Two halves, and they must not both rotate the photo: ffmpeg's autorotate
// has already turned the *pixels* the right way up (from the EXIF tag in a JPEG, from the
// container's irot in a HEIC - ffprobe reports that one as a display matrix), so the copied
// orientation tag is reset to 1 ("as stored"). Left as 6 the viewer would rotate it again.
// The EXIF pixel-dimension tags keep the source's numbers after a scale (viewers use
// the real JPEG dimensions). Any surprise in either file and we return false having written
// nothing: losing the tags is a bug, a corrupt photo is a disaster.
const EXIF_SIG = Buffer.from('Exif\0\0', 'latin1');
function jpegExifSegment(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let p = 2;
  while (p + 4 <= buf.length && buf[p] === 0xff && buf[p + 1] !== 0xda) { // header segments only; EXIF is never past the scan
    const end = p + 2 + buf.readUInt16BE(p + 2);
    if (end > buf.length) return null;
    if (buf[p + 1] === 0xe1 && buf.slice(p + 4, p + 10).equals(EXIF_SIG)) return Buffer.from(buf.slice(p, end));
    p = end;
  }
  return null;
}
// A HEIC keeps its EXIF as an ISOBMFF item, and finding it by the book means walking
// meta/iinf/iloc. The lazy way: Apple - like the spec's own example - prefixes the item with the
// very same 'Exif\0\0' a JPEG segment uses, so scan for that and wrap the TIFF block behind it in
// an APP1 segment of our own. The one thing iloc would have told us is the block's length, so
// measure it instead (tiffLength) and keep everything else shared with the JPEG path.
// First match wins, and the measured length can overshoot by a few bytes of whichever
// item sits next in the file - inert, because readers follow the TIFF offsets. A writer that
// leaves the 'Exif\0\0' prefix off gets no metadata carried over; parse iinf/iloc if one turns up.
function heicExifSegment(buf) {
  for (let at = buf.indexOf(EXIF_SIG); at >= 0; at = buf.indexOf(EXIF_SIG, at + EXIF_SIG.length)) {
    const tiff = at + EXIF_SIG.length;
    const magic = buf.slice(tiff, tiff + 4).toString('latin1');
    if (magic !== 'II*\0' && magic !== 'MM\0*') continue; // a stray 'Exif' in some other item
    const len = tiffLength(buf, tiff, Math.min(buf.length - tiff, 65527)); // what still fits in an APP1
    if (!len) continue;
    const head = Buffer.alloc(4 + EXIF_SIG.length);
    head[0] = 0xff; head[1] = 0xe1;
    head.writeUInt16BE(2 + EXIF_SIG.length + len, 2); // segment length counts itself, JPEG-style big-endian
    EXIF_SIG.copy(head, 4);
    return Buffer.concat([head, buf.slice(tiff, tiff + len)]);
  }
  return null;
}
// How far the TIFF block at `tiff` reaches: the end of the furthest byte any IFD entry points at.
// 0 if anything points outside `limit`, which is also how a false-positive signature gets rejected.
const TIFF_TYPE_BYTES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
function tiffLength(buf, tiff, limit) {
  const le = buf[tiff] === 0x49;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  let end = 8; // the TIFF header itself
  const todo = [u32(tiff + 4)]; // IFD0, then whatever it points at: Exif, GPS, Interop, IFD1
  for (let i = 0; i < todo.length && i < 8; i++) { // the cap is also what stops a file that points in a circle
    const off = todo[i];
    if (!off || off + 2 > limit) return 0;
    const n = u16(tiff + off);
    if (off + 2 + n * 12 + 4 > limit) return 0;
    end = Math.max(end, off + 2 + n * 12 + 4);
    for (let k = 0; k < n; k++) {
      const e = tiff + off + 2 + k * 12;
      const tag = u16(e), bytes = (TIFF_TYPE_BYTES[u16(e + 2)] || 0) * u32(e + 4);
      if (bytes > 4) { // 4 bytes or fewer live in the entry; anything bigger sits elsewhere in the block
        if (u32(e + 8) + bytes > limit) return 0;
        end = Math.max(end, u32(e + 8) + bytes);
      }
      if (tag === 0x8769 || tag === 0x8825 || tag === 0xa005) todo.push(u32(e + 8)); // Exif / GPS / Interop sub-IFDs
    }
    const next = u32(tiff + off + 2 + n * 12);
    if (next) todo.push(next);
  }
  return end;
}
function neutralizeExif(seg) {
  const tiff = 10; // 2-byte marker + 2-byte length + 'Exif\0\0'
  if (seg.length < tiff + 8) return false;
  const le = seg.slice(tiff, tiff + 2).toString('latin1') === 'II';
  const u16 = (o) => (le ? seg.readUInt16LE(o) : seg.readUInt16BE(o));
  const ifd0 = tiff + (le ? seg.readUInt32LE(tiff + 4) : seg.readUInt32BE(tiff + 4));
  if (ifd0 < tiff + 8 || ifd0 + 2 > seg.length) return false;
  const n = u16(ifd0);
  const next = ifd0 + 2 + n * 12;
  if (next + 4 > seg.length) return false;
  for (let i = 0; i < n; i++) {
    const e = ifd0 + 2 + i * 12;
    if (u16(e) === 0x0112) le ? seg.writeUInt16LE(1, e + 8) : seg.writeUInt16BE(1, e + 8); // orientation, already applied to the pixels
  }
  // Drop IFD1 with it: its thumbnail is the source's, unscaled and unrotated, so anything
  // that trusted it would show the photo sideways again.
  le ? seg.writeUInt32LE(0, next) : seg.writeUInt32BE(0, next);
  return true;
}
const HEIC_EXTS = /\.hei[cf]$/i;
function copyExif(srcAbs, outAbs) {
  try {
    const buf = fs.readFileSync(srcAbs);
    const seg = HEIC_EXTS.test(srcAbs) ? heicExifSegment(buf) : jpegExifSegment(buf);
    if (!seg || !neutralizeExif(seg)) return false;
    const out = fs.readFileSync(outAbs);
    if (out.length < 2 || out[0] !== 0xff || out[1] !== 0xd8) return false;
    fs.writeFileSync(outAbs, Buffer.concat([out.slice(0, 2), seg, out.slice(2)])); // straight after the SOI, where Exif wants it
    return true;
  } catch (e) {
    console.error('exif copy failed:', srcAbs, e.message); // the photo itself is fine, just barer
    return false;
  }
}

// What the sliders would actually produce, by running the real encoder: exact for a photo
// (it encodes the whole thing - well under a second), a short sample scaled up by the
// duration for video.
// A sample is scene-dependent, so a video estimate is ballpark (roughly ±25%);
// encode the whole file if that ever isn't good enough. An HDR sample goes through the same
// tone-map chain as the real encode, which makes the estimate slower - a number that matches
// what you'll get beats a fast one that doesn't.
const SAMPLE_SEC = 3;
async function estimateCompressed(abs, quality, scale) {
  const src = await compressSource(abs); // the same one probe the encode uses: duration and HDR
  const { ext, args } = compressArgs(abs, quality, scale, src);
  const tmp = path.join(path.dirname(abs), `.estimating-${Date.now()}${ext}`); // dot name: hidden from listings and the watcher
  try {
    const duration = src.duration || 0;
    const sampled = duration > SAMPLE_SEC * 1.5; // shorter than that, just encode the lot
    const pre = sampled ? ['-ss', String(Math.round(duration * 0.1))] : []; // 10% in: past a black lead-in
    const post = sampled ? ['-t', String(SAMPLE_SEC)] : [];
    await run(FFMPEG, ['-y', '-v', 'error', ...pre, ...MEDIA_ONLY, '-i', abs, ...post, ...args, tmp]);
    const bytes = fs.statSync(tmp).size;
    return { bytes: sampled ? Math.round(bytes * duration / SAMPLE_SEC) : bytes, sampled, before: fs.statSync(abs).size };
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
}

let compressChain = Promise.resolve(); // one encode at a time, same reason as conversions
async function compressFile(abs, { quality, scale, overwrite }) {
  const { ext, args } = compressArgs(abs, quality, scale, await compressSource(abs));
  const dir = path.dirname(abs);
  const tmp = path.join(dir, `.compressing-${Date.now()}${ext}`); // dot name: hidden from listings and the watcher
  try {
    await run(FFMPEG, ['-y', '-v', 'error', ...MEDIA_ONLY, '-i', abs, ...args, tmp]);
    if (ext === '.jpg' && /\.(jpe?g|hei[cf])$/i.test(path.extname(abs))) copyExif(abs, tmp); // before the sizes are read: the EXIF block counts
    const before = fs.statSync(abs).size, after = fs.statSync(tmp).size;
    if (after >= before) return { before, after, skipped: true }; // never trade a file for a bigger one
    const rel = path.relative(SHARED_DIR, abs).split(path.sep).join('/');
    const base = path.basename(abs, path.extname(abs));
    let trash = null;
    if (overwrite) { // the original goes to the trash, so "replace" is still undoable for a week
      trash = trashName(rel);
      fs.mkdirSync(TRASH_DIR, { recursive: true });
      renameSync(abs, path.join(TRASH_DIR, trash));
    }
    const name = uniqueName(dir, overwrite ? base + ext : `${base} (compressed)${ext}`); // after the trash move, so a replace keeps the name
    renameSync(tmp, path.join(dir, name));
    const newRel = path.relative(SHARED_DIR, path.join(dir, name)).split(path.sep).join('/');
    if (meta[rel]) meta[newRel] = { ...meta[rel] };
    if (overwrite) moveMeta(rel, '.trash/' + trash); else saveMeta();
    changed(abs);
    bump();
    return { before, after, path: newRel, trash };
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
}

// ---------- previews for browsers that can't show the original ----------
// An iPhone original is HEVC video (often HDR) and HEIC photos, and a browser on Windows
// frequently can't decode either - so the thumbnail and the lightbox were black boxes.
// The page asks for one of these only after the original failed to load; the file itself
// is never touched. Cached in a dot folder (hidden from listings, the watcher, the totals),
// keyed by path + size + mtime so an edited file gets a fresh one.
// HDR is squeezed to 8-bit without tone-mapping - HLG (iPhone) still looks fine,
// PQ looks flat; add zscale+tonemap if that ever matters for a preview.
const PREVIEW_DIR = path.join(SHARED_DIR, '.previews');
const PREVIEW_KINDS = {
  video: { ext: '.mp4', args: ['-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=-2:min(720\\,ih)', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'] },
  poster: { ext: '.jpg', pre: ['-ss', '0.1'], args: ['-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5'] },
  // -filter_complex for the same reason as compressArgs: with -vf a tile-grid HEIC - the one
  // format this fallback exists for - refused to convert, and the page showed an icon instead.
  image: { ext: '.jpg', args: ['-frames:v', '1', '-filter_complex', 'scale=min(1600\\,iw):-2', '-q:v', '4'] },
  // "Download as JPEG": Windows can't open a HEIC without a paid extension. The whole photo at
  // full size, so no filter at all (nothing for a tile grid to object to). ffmpeg writes no
  // EXIF, so copyExif splices it in - and resets the orientation, since autorotate already
  // turned the pixels. Served as a download named after the photo.
  // Cached like any preview, so each photo saved this way keeps a full-size copy in
  // .previews for up to 30 days; prune these sooner if that ever shows on the disk.
  jpeg: { ext: '.jpg', only: HEIC_EXTS, exif: true, args: ['-frames:v', '1', '-q:v', '2'] },
};
const PREVIEW_EXTS = /\.(jpe?g|png|heic|heif|webp|bmp|gif|mov|mp4|m4v|mkv|avi|webm|wmv|flv|ts|mpg|mpeg|3gp)$/i;
const previewJobs = new Map(); // cache file -> promise, so the thumbnail and the lightbox don't encode it twice
let previewChain = Promise.resolve(); // one encode at a time; separate from compress so a big job there doesn't stall a thumbnail
function makePreview(abs, kind) {
  const spec = PREVIEW_KINDS[kind];
  const st = fs.statSync(abs);
  const key = crypto.createHash('sha1').update(`${abs}|${st.size}|${st.mtimeMs}|${kind}`).digest('hex');
  const out = path.join(PREVIEW_DIR, key + spec.ext);
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (previewJobs.has(out)) return previewJobs.get(out);
  const tmp = out + '.part' + spec.ext;
  const job = (previewChain = previewChain.catch(() => {}).then(async () => {
    fs.mkdirSync(PREVIEW_DIR, { recursive: true });
    try {
      await run(FFMPEG, ['-y', '-v', 'error', ...(spec.pre || []), ...MEDIA_ONLY, '-i', abs, ...spec.args, tmp]);
      if (spec.exif) copyExif(abs, tmp);
      renameSync(tmp, out);
      return out;
    } finally { fs.rm(tmp, { force: true }, () => {}); }
  })).finally(() => previewJobs.delete(out));
  previewJobs.set(out, job);
  return job;
}
function prunePreviews() { // regenerating one is cheap; keeping a month of them isn't free
  let entries = [];
  try { entries = fs.readdirSync(PREVIEW_DIR); } catch (e) { return; }
  for (const e of entries) {
    const p = path.join(PREVIEW_DIR, e);
    try { if (Date.now() - fs.statSync(p).atimeMs > 30 * 24 * 3600 * 1000) fs.rm(p, { force: true }, () => {}); } catch (err) { /* gone */ }
  }
}

// Anything already sitting in the share from before (skips dot folders, i.e. the trash).
async function convertExisting(dir = SHARED_DIR) {
  for (const { name, isDir } of await listShared(dir)) {
    const p = path.join(dir, name);
    isDir ? await convertExisting(p) : queueConvert(p, 'startup');
  }
}

// ?path=sub/folder puts the upload in that folder; anything unusable falls back to the
// root. The folder is created if it's missing - that's what makes uploading a whole
// folder work: the client just sends each file with its own relative path.
function uploadDir(req) {
  const dir = safeDir(req.query.path) || SHARED_DIR;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return SHARED_DIR; }
  return dir;
}
// Windows' "this came from another computer" mark (what a browser download gets), so SmartScreen
// and Office's Protected View treat a received file with the same care. Not on non-NTFS disks.
function markReceived(abs) {
  if (process.platform !== 'win32') return;
  try { fs.writeFileSync(abs + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n'); } catch (e) { /* FAT/exFAT, or no ADS support */ }
}

// Re-sending a camera roll used to leave IMG_1234 (1).HEIC next to an identical IMG_1234.HEIC.
// Only the file that took the name is compared (same size first, then SHA-256), so a different
// photo that happens to share a name is still kept, as "(1)".
function fileHash(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}
async function sameContent(a, b) {
  try {
    const x = fs.statSync(a), y = fs.statSync(b);
    if (!x.isFile() || !y.isFile() || x.size !== y.size) return false;
  } catch (e) { return false; }
  const [ha, hb] = await Promise.all([fileHash(a), fileHash(b)]);
  return ha === hb;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir(req)),
  filename: (req, file, cb) => {
    // multer gives us the raw bytes; fix up UTF-8 filenames mangled by latin1 decoding.
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    file.requestedName = safeFileName(name); // what it would be called if the name were free - the duplicate check compares against that
    cb(null, uniqueName(uploadDir(req), file.requestedName));
  },
});
const upload = multer({ storage });

const tls = ensureCerts(); // null if openssl isn't available and no certs were generated earlier

const app = express();
app.set('env', 'production'); // no stack traces (with the install path in them) in error pages, even before the passcode
app.disable('x-powered-by');

// The host skips the passcode, so without this any web page open in the PC's browser could POST
// to http://localhost:8811 (a form or no-cors fetch needs no permission) and rename, move,
// upload or "compress" files. Browsers say where a request came from; anything that changes
// state must come from this page itself. Tools that send neither header (the iPhone Shortcut,
// curl) aren't browsers and are still let through to the passcode check.
function isCrossSite(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  if (origin === 'null') return true; // what a sandboxed iframe sends
  try { return new URL(origin).host !== String(req.headers.host || ''); } catch (e) { return true; }
}
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  next();
});
app.use((req, res, next) => (isCrossSite(req) ? res.status(403).json({ error: 'cross-site request' }) : next()));

// ---- #7: only answer to names and addresses this PC really has ----
// A web page on a phone can point its own domain name at this PC (DNS rebinding) and send what look
// like same-origin requests: enough to burn the passcode limit and lock that phone out. So a
// request must be addressed to one of this PC's own names or addresses. Extra names (a router's
// "pc.lan", a VPN name) can be added with LANLORD_HOSTS=name1,name2.
const EXTRA_HOSTS = String(process.env.LANLORD_HOSTS || '').toLowerCase().split(',').map((h) => h.trim()).filter(Boolean);
let ownAddrs = { at: 0, set: new Set() };
function knownHost(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  if (LOCAL_HOSTS.has(h) || EXTRA_HOSTS.includes(h)) return true;
  if (Date.now() - ownAddrs.at > 10000) { // addresses change with DHCP; re-read now and then
    const set = new Set();
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) set.add(a.family === 'IPv6' ? '[' + a.address.toLowerCase() + ']' : a.address);
    ownAddrs = { at: Date.now(), set };
  }
  return ownAddrs.set.has(h);
}
app.use((req, res, next) => (knownHost(req.headers.host) ? next() : res.status(421).json({ error: 'unknown host name; add it to LANLORD_HOSTS' })));

app.use(express.json());
const formBody = express.urlencoded({ extended: false }); // only the zip download is a plain form POST (so the browser streams it to disk)

// Keep a known device's presence fresh on every API call it makes, so ordinary
// browsing/uploading counts as activity between heartbeats. Registration is deliberately
// NOT done here: /api/devices/ping is the only thing that creates a device, because it's
// the only request that carries the device's real name - and because auto-registering
// here made "Forget" useless (the device reappeared on its very next poll).
app.use((req, res, next) => {
  if (isLoopback(req)) req.headers['x-device-id'] = HOST_ID;
  const id = req.headers['x-device-id'];
  if (id && id !== HOST_ID && devices[id] && !devices[id].forgotten) lastSeen[id] = Date.now();
  next();
});

// The gate itself. Everything below it - the API, the shared files, the app shell - is
// behind the passcode; the PC serving it (localhost) is always let through.
app.use((req, res, next) => {
  if (isLoopback(req)) return next();
  // Same address the loopback check reads, minus the IPv6-mapped prefix, so one phone
  // arriving over v4 and v4-in-v6 doesn't get two buckets to burn.
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (authBlocked(ip)) return tooManyAttempts(req, res); // before any comparison work
  // A passcode in the URL counts only when the request didn't come from another website: a page
  // open on the phone could otherwise fire ten <img src="http://pc:8811/?k=x"> and lock that
  // phone out for ten minutes. Scanning the QR, pasting the link and the unlock form all qualify.
  const fromSite = /^(cross-site|same-site)$/.test(req.headers['sec-fetch-site'] || '');
  const k = !fromSite && typeof req.query.k === 'string' ? req.query.k : '';
  if (k && sameToken(k)) {
    noteAuthAttempt(ip, true);
    res.setHeader('Set-Cookie', `ls_key=${encodeURIComponent(TOKEN)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`); // the page never reads it
    // The redirect is only here to clean the passcode out of a browser's address bar, so it's
    // for page navigations. Doing it to an API client (an iOS Shortcut posting a photo) throws
    // the request body away and strips the key on the way, leaving it stuck at the 401.
    if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) return res.redirect(302, stripKey(req.originalUrl));
    return next();
  }
  const c = cookieToken(req);
  if (c && sameToken(c)) {
    noteAuthAttempt(ip, true);
    return next();
  }
  // A wrong cookie is almost always a stale one (the passcode was changed): drop it, or the
  // phone's own polling would burn through the ten tries in seconds and lock it out of
  // entering the new passcode. A script that keeps re-sending cookies still counts each time.
  if (c) res.setHeader('Set-Cookie', 'ls_key=; Path=/; Max-Age=0; SameSite=Lax');
  if ((k || c) && noteAuthAttempt(ip, false)) return tooManyAttempts(req, res);
  res.status(401);
  if (req.path.startsWith('/api/') || !req.accepts('html')) return res.json({ error: 'unauthorized' });
  res.type('html').send(LOGIN_PAGE);
});

// supports Range requests natively -> video scrubbing, resumable downloads.
// maxAge lets the browser skip re-fetching thumbnails it just showed on every 4s file-list poll.
// ?download forces "save" - phones ignore <a download> for media and open a player instead,
// which for an MKV (unplayable on iOS/most Android browsers) is just a dead black screen.
// Uploaded files are served from the app's own origin, so an .html or .svg someone uploaded
// would run its scripts with the passcode cookie and could drive the whole API. The sandbox
// CSP gives the file an opaque origin with scripts off. Not for PDFs: Chrome refuses to
// render a sandboxed PDF at all (and its viewer doesn't run the PDF's JS in our origin).
app.use('/files', countBytesOnResponse, (req, res, next) => {
  // The same guard as every API route: static serving on its own would hand out a short-name or
  // alternate-stream spelling of a hidden file.
  let rel = '';
  try { rel = decodeURIComponent(req.path); } catch (e) { return res.status(400).end(); }
  if (!safeSharedPath(rel)) return res.status(404).end();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin'); // no <img src=…> from other sites probing which names exist
  if (!/\.pdf$/i.test(req.path)) res.setHeader('Content-Security-Policy', "sandbox; frame-ancestors 'none'");
  if ('download' in req.query) try { res.attachment(path.basename(decodeURIComponent(req.path))); } catch {} // bad %-escape: static 404s it
  next();
}, express.static(SHARED_DIR, { maxAge: '5m' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- live updates ----------
// One held-open stream per device instead of waiting for the next poll: a photo sent from
// the phone lands on the PC's screen immediately, and so does one dragged into the shared
// folder in Explorer. Clients keep a slow poll as the fallback for when this is unavailable.
const sseClients = new Set();
const pendingKinds = new Set();
let bumpTimer = null;
let bumpDue = 0;
const BUMP_MS = 150;
// A 2000-photo upload arrives one request at a time, and each one told every connected device
// to re-fetch and re-render the whole listing - seven times a second, on a list that is 2000
// rows by the end. A second of lag on "the next photo showed up" is invisible. A second of lag
// on something the owner just did by hand - a delete, a rename, a pasted line of text - is
// not, so those keep the short window, and a short window always wins over a pending long one:
// deleting something in the middle of an upload still goes out immediately.
// This has to cover the fs.watch bump as well as the upload endpoint. The watcher sees our own
// uploads land (and fires more than once per file as it is written), so leaving it on the short
// window would simply defeat the long one - measured, not assumed.
// The price is that one file dropped into the folder in Explorer now shows up on the
// other devices in up to a second instead of 150ms. The watcher can't tell one drop from two
// thousand; if that second ever feels slow, that is what would have to be worked out.
const BUMP_BULK_MS = 1000;
function bump(kind, waitMs = BUMP_MS) {
  pendingKinds.add(kind || 'files'); // folder sizes are the caller's job: see changed()
  const due = Date.now() + waitMs;
  if (bumpTimer && due >= bumpDue) return; // coalesce a burst: an upload writes the file and then the metadata
  clearTimeout(bumpTimer);
  bumpDue = due;
  bumpTimer = setTimeout(() => {
    bumpTimer = null;
    const msg = 'data: ' + [...pendingKinds].join(',') + '\n\n';
    pendingKinds.clear();
    // A phone that walked out of wifi range can be gone before its 'close' fires; writing to
    // that socket must not take the server down with it.
    for (const res of sseClients) { try { res.write(msg); } catch (e) { sseClients.delete(res); } }
  }, waitMs);
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  const keepalive = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* gone; close follows */ } }, 25000); // a silent stream gets closed by iOS after a while
  req.on('close', () => { clearInterval(keepalive); sseClients.delete(res); });
  res.on('error', () => { clearInterval(keepalive); sseClients.delete(res); });
});

// Files also arrive the old-fashioned way - dropped into the folder in Explorer.
// Only when actually serving: on Linux a recursive watch keeps the process alive even when
// unref()'d, so selftest.js (which only loads this file) would never exit.
if (require.main === module) try {
  fs.watch(SHARED_DIR, { recursive: true }, (evt, name) => {
    // No name: Windows overflowed its change buffer and can't say what changed - so all of it may have.
    if (!name) { walkCache.clear(); return bump('files', BUMP_BULK_MS); }
    if (name.split(/[\\/]/).some((p) => p.startsWith('.'))) return; // our own .meta.json writes would loop forever; .trash isn't ours to convert
    changed(path.join(SHARED_DIR, name));
    queueConvert(path.join(SHARED_DIR, name), 'watch'); // dropped in via Explorer
    bump('files', BUMP_BULK_MS); // a file appearing is the bulk signal; see BUMP_BULK_MS
  }).unref();
} catch (e) { /* recursive watch unsupported here - the client's fallback poll still covers it */ }

app.get('/api/files', (req, res) => {
  const rel = normRel(req.query.path);
  const dir = safeDir(req.query.path);
  if (!dir || !fs.existsSync(dir)) return res.status(404).json({ error: 'no such folder' });
  const prefix = rel ? rel + '/' : '';
  listShared(dir).then((list) => {
    const entries = list.map(({ name, stat, isDir }) => {
      const m = meta[prefix + name] || {};
      // A file copied into the folder by hand keeps its old mtime; birthtime says when it landed here.
      const e = { name, path: prefix + name, isDir, mtime: m.addedAt || Math.max(stat.birthtimeMs || 0, stat.mtimeMs), addedBy: m.addedBy || 'PC' };
      if (!isDir) return Object.assign(e, { size: stat.size });
      const s = walkStatsCached(path.join(dir, name));
      return Object.assign(e, { size: s.bytes, count: s.files });
    });
    entries.sort((a, b) => b.mtime - a.mtime);
    // Prune metadata for things that vanished from THIS folder only - other folders' keys
    // are still live even though they aren't in this listing. And only what is gone from disk
    // now: an upload that finished while the listing was being read has its key already, and
    // no entry in this (slightly older) listing.
    const here = new Set(entries.map((e) => e.path));
    const stale = Object.keys(meta).filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/') && !here.has(k) && !fs.existsSync(path.join(SHARED_DIR, k)));
    // Soon, not now: every device lists this folder on every change, and dropping keys that are
    // already gone from disk can wait - nothing reads .meta.json back while the process is up.
    if (stale.length) { for (const k of stale) delete meta[k]; saveMetaSoon(); }
    res.json(entries);
  }, () => res.status(404).json({ error: 'no such folder' })) // gone between the check and the read
    .catch((e) => { console.error('listing failed:', dir, e.message); if (!res.headersSent) res.status(500).json({ error: 'listing failed' }); }); // an unhandled rejection would take the whole server down
});

async function recordUploads(req) {
  const from = nameForDevice(req);
  const now = Date.now();
  const rel = safeDir(req.query.path) ? normRel(req.query.path) : '';
  const prefix = rel ? rel + '/' : '';
  const uploaded = [], duplicates = [];
  for (const f of req.files || []) {
    changed(f.path);
    const want = f.requestedName;
    if (want && want !== f.filename && await sameContent(f.path, path.join(path.dirname(f.path), want))) {
      fs.rmSync(f.path, { force: true });
      duplicates.push(want);
      continue;
    }
    uploaded.push(f.filename);
    markReceived(f.path);
    meta[prefix + f.filename] = { addedBy: from, addedAt: now };
    queueConvert(f.path, 'upload'); // we wrote and closed it: no settle wait
  }
  if (uploaded.length) saveMetaSoon();
  bump('files', BUMP_BULK_MS);
  return { uploaded, duplicates };
}

app.post('/api/upload', checkRoom, countBytesOnRequest, upload.array('files'), (req, res) => {
  recordUploads(req).then((r) => res.json({ ok: true, ...r }), (e) => res.status(500).json({ error: e.message }));
});

// Web Share Target (manifest.json): the phone's Share sheet posts here. Files land in the
// share root; shared text/links go to the clipboard. Must answer with a page, not JSON.
app.post('/api/share', checkRoom, countBytesOnRequest, upload.array('files'), (req, res) => {
  recordUploads(req).catch((e) => console.error('share upload failed:', e.message)); // the share sheet only wants the page back
  const text = [req.body && req.body.title, req.body && req.body.text, req.body && req.body.url]
    .filter((v) => typeof v === 'string' && v.trim()).join('\n').slice(0, 20000);
  if (text) {
    clipboard.push({ id: crypto.randomUUID(), text, at: Date.now(), from: nameForDevice(req) });
    if (clipboard.length > 200) clipboard = clipboard.slice(-200);
    saveClipboard();
    bump('clip');
  }
  res.redirect(303, '/');
});

// ---------- resumable uploads (the page's own queue) ----------
// A 4K video over shaky wifi used to start again from 0% after every drop, pause or Safari
// backgrounding. The page now sends the file in pieces to a .part file and asks how much
// already arrived before each attempt, so it carries on from there - even after a reload,
// because the id is derived from the file itself. The multipart /api/upload above stays for
// the iPhone Shortcut and the share sheet.
const PARTS_DIR = path.join(SHARED_DIR, '.uploads'); // dot folder: hidden from listings, the watcher, the totals
const PART_TTL_MS = 2 * 24 * 3600 * 1000;
const activeParts = new Set(); // one writer per upload id
function partPath(id) { return /^[\w-]{8,100}$/.test(String(id)) ? path.join(PARTS_DIR, id + '.part') : null; }
function partSize(p) { try { return fs.statSync(p).size; } catch (e) { return 0; } }
function pruneParts() {
  let entries = [];
  try { entries = fs.readdirSync(PARTS_DIR); } catch (e) { return; }
  for (const e of entries) {
    const p = path.join(PARTS_DIR, e);
    try { if (Date.now() - fs.statSync(p).mtimeMs > PART_TTL_MS) fs.rm(p, { force: true }, () => {}); } catch (err) { /* gone */ }
  }
}

app.get('/api/upload/status', (req, res) => {
  const p = partPath(req.query.id);
  if (!p) return res.status(400).json({ error: 'bad id' });
  res.json({ size: partSize(p) });
});

// PUT ?id&offset&total&name&path, raw bytes in the body. Appends only at the exact end of what
// is already there; anything else gets 409 with the real size, and the page continues from it.
app.put('/api/upload/chunk', countBytesOnRequest, (req, res) => {
  const q = req.query;
  const p = partPath(q.id);
  const total = Number(q.total), offset = Number(q.offset);
  const dir = safeDir(q.path);
  const name = safeFileName(typeof q.name === 'string' ? q.name : '');
  if (!p || !dir || !(total >= 0) || !(offset >= 0)) return res.status(400).json({ error: 'bad request' });
  if (activeParts.has(q.id)) return res.status(409).json({ error: 'busy', size: partSize(p) });
  fs.mkdirSync(PARTS_DIR, { recursive: true });
  const have = partSize(p);
  if (offset !== have || offset > total) { req.resume(); return res.status(409).json({ error: 'offset', size: have }); }
  // Everything still to come, not just this piece: refusing at 90% would waste the 90%. A .part
  // already here stays, so Retry carries on once there is room. The piece itself is only 8 MB,
  // so it's drained rather than the connection cut - the page has to be able to read the 507.
  const full = noRoom(total - have);
  if (full) { req.resume(); return res.status(507).json(full); }
  activeParts.add(q.id);
  const out = fs.createWriteStream(p, { flags: 'a' });
  let failed = false;
  const done = () => activeParts.delete(q.id);
  // A dropped connection leaves whatever arrived in the .part - that's the point: the next
  // attempt asks for the size and sends only the rest.
  req.on('close', () => { if (!req.complete) { failed = true; out.end(); done(); } });
  out.on('error', (e) => { failed = true; done(); if (!res.headersSent) res.status(500).json({ error: e.message }); });
  req.pipe(out);
  out.on('finish', () => {
    if (failed) return;
    const size = partSize(p);
    if (size < total) { done(); return res.json({ ok: true, size }); }
    if (size > total) { fs.rmSync(p, { force: true }); done(); return res.status(400).json({ error: 'more bytes than announced', size: 0 }); }
    const relOf = (abs) => path.relative(SHARED_DIR, abs).split(path.sep).join('/');
    sameContent(p, path.join(dir, name)).then((dup) => {
      if (dup) { // already here, byte for byte: keep the one that's there
        fs.rmSync(p, { force: true });
        return res.json({ ok: true, size, done: true, duplicate: true, path: relOf(path.join(dir, name)) });
      }
      fs.mkdirSync(dir, { recursive: true });
      const final = uniqueName(dir, name);
      renameSync(p, path.join(dir, final));
      markReceived(path.join(dir, final));
      const rel = relOf(path.join(dir, final));
      meta[rel] = { addedBy: nameForDevice(req), addedAt: Date.now() };
      saveMetaSoon(); // the page's own queue: same 2000-photo burst as /api/upload
      queueConvert(path.join(dir, final), 'upload');
      changed(path.join(dir, final));
      bump('files', BUMP_BULK_MS);
      res.json({ ok: true, size, done: true, path: rel });
    }).catch((e) => res.status(500).json({ error: e.message })).finally(done);
  });
});

app.delete('/api/files', (req, res) => {
  const rel = normRel(req.query.name);
  const target = safeSharedPath(req.query.name);
  if (!target) return res.status(400).json({ error: 'bad name' });
  if (!fs.existsSync(target)) return res.status(404).json({ error: 'not found' });
  const entry = trashName(rel);
  try {
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    renameSync(target, path.join(TRASH_DIR, entry)); // a folder goes with everything in it
  } catch (e) { return res.status(500).json({ error: e.message }); }
  moveMeta(rel, '.trash/' + entry); // parked, not dropped, so a restore brings back who sent it
  pruneTrash();
  changed(target);
  bump();
  res.json({ ok: true, trash: entry });
});

// The file the sliders point at, or null with the response already sent.
function compressTarget(req, res) {
  const abs = safeSharedPath((req.body || {}).name);
  if (!abs || !COMPRESS_EXTS.test(abs)) { res.status(400).json({ error: 'not an image or video' }); return null; }
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.status(404).json({ error: 'not found' }); return null; }
  return abs;
}

// Deliberately not on compressChain: an estimate is short, and queueing it behind a
// running video encode would leave the slider spinning for minutes.
// Estimates queue among themselves (twenty at once would be twenty ffmpegs), but not behind a
// compress: a long video encode would leave the slider spinning for minutes.
let estimateChain = Promise.resolve();
app.post('/api/compress/estimate', (req, res) => {
  const abs = compressTarget(req, res);
  if (!abs) return;
  const job = (estimateChain = estimateChain.catch(() => {}).then(() => estimateCompressed(abs, req.body.quality, req.body.scale)));
  job.then((r) => res.json({ ok: true, ...r }), (e) => { console.error('estimate failed:', abs, e.message); res.status(500).json({ error: 'estimate failed' }); });
});

app.post('/api/compress', (req, res) => {
  const body = req.body || {};
  const abs = compressTarget(req, res);
  if (!abs) return;
  const job = compressChain.then(() => compressFile(abs, { quality: body.quality, scale: body.scale, overwrite: !!body.overwrite }));
  compressChain = job.catch(() => {});
  job.then((r) => res.json({ ok: true, ...r }), (e) => { console.error('compress failed:', abs, e.message); res.status(500).json({ error: 'compress failed' }); });
});

app.get('/api/preview', (req, res) => {
  const kind = String(req.query.kind || '');
  const spec = Object.hasOwn(PREVIEW_KINDS, kind) ? PREVIEW_KINDS[kind] : null; // not "constructor" & co.
  const abs = safeSharedPath(req.query.name);
  if (!spec || !abs || (spec.only && !spec.only.test(abs)) || !PREVIEW_EXTS.test(abs)) return res.status(400).json({ error: 'bad request' });
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return res.status(404).json({ error: 'not found' });
  makePreview(abs, kind).then(
    (out) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      if (kind === 'jpeg') res.attachment(path.basename(abs).replace(HEIC_EXTS, '.jpg')); // IMG_1234.HEIC -> IMG_1234.jpg
      res.sendFile(out, { maxAge: '1d' });
    },
    (e) => { console.error('preview failed:', abs, e.message); res.status(415).json({ error: 'no preview' }); });
});

// ---------- "why can't my phone connect?" ----------
// The most common reason by far: Windows put the wifi in the Public profile, where the firewall
// drops the phone's connection before it reaches us - so nothing here ever sees it fail. Ask
// Windows instead, at startup, and say so on the console and the PC's own page.
// profiles: Get-NetConnectionProfile as JSON (NetworkCategory 0 = Public); nets: os.networkInterfaces().
// -> names of real LAN adapters that are on a Public network.
function publicLanAdapters(profiles, nets) {
  const lan = new Set(Object.keys(nets).filter((n) => !VIRTUAL_NIC.test(n) && (nets[n] || []).some((a) => a.family === 'IPv4' && !a.internal)));
  return [].concat(profiles || []).filter((p) => p && (p.NetworkCategory === 0 || p.NetworkCategory === 'Public') && lan.has(p.InterfaceAlias)).map((p) => p.InterfaceAlias);
}
let networkWarning = null;
function checkNetwork() {
  if (process.platform !== 'win32') return;
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetConnectionProfile | Select-Object InterfaceAlias,NetworkCategory | ConvertTo-Json -Compress'])
    .then((out) => {
      const bad = publicLanAdapters(JSON.parse(out || '[]'), os.networkInterfaces());
      if (!bad.length) return;
      networkWarning = `Windows has "${bad.join('", "')}" set to a Public network, so its firewall blocks phones. Fix: Windows Settings → Network & internet → ${bad[0]} → Network profile type → Private.`;
      console.warn('  WARNING: ' + networkWarning);
    })
    .catch(() => { /* no PowerShell or the cmdlet - nothing to report */ });
}

// ---------- trash ----------
app.get('/api/trash', (req, res) => {
  pruneTrash();
  let entries = [];
  try { entries = fs.readdirSync(TRASH_DIR); } catch (e) { /* no trash yet */ }
  res.json(entries
    .map((entry) => ({ entry, from: trashOrigin(entry), at: trashStamp(entry) }))
    .filter((e) => e.from)
    .map((e) => Object.assign(e, { name: e.from.split('/').pop() }))
    .sort((a, b) => b.at - a.at));
});

app.post('/api/restore', (req, res) => {
  const entry = path.basename(String((req.body && req.body.entry) || '')); // basename: the name is the only thing that picks the file
  const rel = trashOrigin(entry);
  const src = path.join(TRASH_DIR, entry);
  const dest = rel && safeSharedPath(rel);
  if (!dest || !fs.existsSync(src)) return res.status(404).json({ error: 'nothing to restore' });
  const parent = path.dirname(dest);
  let name;
  try {
    fs.mkdirSync(parent, { recursive: true }); // the folder it lived in may have gone too
    name = uniqueName(parent, path.basename(dest)); // something else may have taken the name since
    renameSync(src, path.join(parent, name));
  } catch (e) { return res.status(500).json({ error: e.message }); }
  const newRel = rel.split('/').slice(0, -1).concat(name).join('/');
  moveMeta('.trash/' + entry, newRel);
  changed(path.join(parent, name));
  bump();
  res.json({ ok: true, path: newRel });
});

app.delete('/api/trash', (req, res) => {
  fs.rmSync(TRASH_DIR, { recursive: true, force: true });
  for (const k of Object.keys(meta)) if (k.startsWith('.trash/')) delete meta[k];
  saveMeta();
  res.json({ ok: true });
});

// Windows' filesystem is case-insensitive, so after renaming a.jpg -> A.jpg the destination
// already "exists" - it is the very same file. Ask the OS for its identity instead of guessing
// at Windows' case-folding rules. ino 0 means it won't identify the file, so assume different
// and let the caller report a clash rather than overwrite something.
function sameFile(a, b) {
  try {
    const x = fs.statSync(a), y = fs.statSync(b);
    return x.ino !== 0 && x.ino === y.ino && x.dev === y.dev;
  } catch (e) { return false; } // one of them isn't there: not the same file
}

// Rename in place: the new name is a bare name, the parent folder never changes.
app.post('/api/files/rename', (req, res) => {
  const body = req.body || {};
  const rel = normRel(body.name);
  const from = safeSharedPath(body.name);
  const base = safeFileName(typeof body.to === 'string' ? body.to : '');
  const parent = rel ? rel.split('/').slice(0, -1).join('/') : '';
  const newRel = parent ? parent + '/' + base : base;
  const to = safeSharedPath(newRel);
  if (!from || !to || !base) return res.status(400).json({ error: 'bad name' });
  if (!fs.existsSync(from)) return res.status(404).json({ error: 'not found' });
  if (from !== to && fs.existsSync(to) && !sameFile(from, to)) return res.status(409).json({ error: 'a file with that name already exists' });
  try { renameSync(from, to); } catch (e) { return res.status(500).json({ error: e.message }); }
  moveMeta(rel, newRel);
  changed(from); changed(to);
  bump();
  res.json({ ok: true, name: base, path: newRel });
});

// ---------- folders ----------
app.post('/api/folders', (req, res) => {
  const body = req.body || {};
  const parent = safeDir(body.path);
  const name = safeFileName(typeof body.name === 'string' ? body.name : '');
  if (!parent || !name) return res.status(400).json({ error: 'bad name' });
  const dir = path.join(parent, name);
  if (fs.existsSync(dir)) return res.status(409).json({ error: 'a folder with that name already exists' });
  try { fs.mkdirSync(dir); } catch (e) { return res.status(500).json({ error: e.message }); }
  const rel = normRel(body.path);
  meta[rel ? rel + '/' + name : name] = { addedBy: nameForDevice(req), addedAt: Date.now() };
  saveMeta();
  changed(dir);
  bump();
  res.json({ ok: true, name });
});

// Every folder in the share, flat - the "Move to…" list.
app.get('/api/folders', (req, res) => {
  const out = [];
  (function walk(dir, rel) {
    if (out.length > 500) return; // Flat cap, paginate if anyone ever nests that deep
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      out.push(r);
      walk(path.join(dir, e.name), r);
    }
  })(SHARED_DIR, '');
  res.json(out.sort());
});

app.post('/api/move', (req, res) => {
  const body = req.body || {};
  const destRel = normRel(body.to);
  const dest = safeDir(body.to);
  if (destRel === null || !dest || !fs.existsSync(dest)) return res.status(400).json({ error: 'bad destination' });
  const moved = [];
  for (const n of [].concat(body.names || [])) {
    const rel = normRel(n);
    const from = safeSharedPath(n);
    if (!from || !fs.existsSync(from)) continue;
    if (path.dirname(from) === dest) continue;                       // already there
    if (dest === from || dest.startsWith(from + path.sep)) continue; // a folder can't move inside itself
    const base = uniqueName(dest, path.basename(from));
    try { renameSync(from, path.join(dest, base)); } catch (e) { continue; }
    const toRel = destRel ? destRel + '/' + base : base;
    moveMeta(rel, toRel, false); // one .meta.json write for the lot, below - moving 500 photos used to rewrite it 500 times
    changed(from); changed(path.join(dest, base));
    moved.push(toRel);
  }
  if (moved.length) { saveMeta(); bump(); }
  res.json({ ok: true, moved });
});

// Search the whole share, not just the folder you happen to be standing in. Entries come
// back in the same shape as /api/files, so the list renders them without knowing the difference.
app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);
  const out = [];
  (function walk(dir, rel) {
    if (out.length >= 300) return; // Flat cap - add paging if a share ever gets that big
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const d of entries) {
      const name = d.name;
      if (name.startsWith('.') || IGNORED.test(name)) continue;
      const hit = name.toLowerCase().includes(q);
      // Only a hit needs a stat (and a link, whose type readdir can't tell): statting every name
      // in the share, once per keystroke, was nearly all of a search's time on a big one.
      let stat = null;
      if (hit || d.isSymbolicLink()) { try { stat = fs.statSync(path.join(dir, name)); } catch (e) { continue; } } // vanished
      const isDir = stat ? stat.isDirectory() : d.isDirectory();
      if (stat && !isDir && !stat.isFile()) continue; // same as listShared: files and folders only
      const p = rel ? rel + '/' + name : name;
      if (hit) {
        const m = meta[p] || {};
        const e = { name, path: p, isDir, size: stat.size, mtime: m.addedAt || Math.max(stat.birthtimeMs || 0, stat.mtimeMs), addedBy: m.addedBy || 'PC' };
        if (isDir) { const s = walkStatsCached(path.join(dir, name)); e.size = s.bytes; e.count = s.files; }
        out.push(e);
      }
      if (isDir) walk(path.join(dir, name), p);
    }
  })(SHARED_DIR, '');
  out.sort((a, b) => b.mtime - a.mtime);
  res.json(out);
});

app.post('/api/zip', formBody, countBytesOnResponse, (req, res) => {
  const names = [].concat((req.body && req.body.names) || []); // JSON array, or repeated form fields (a single one arrives as a string)
  const valid = names.map((n) => safeSharedPath(n)).filter((p) => p && fs.existsSync(p));
  if (!valid.length) return res.status(400).json({ error: 'no valid files' });

  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="Lanlord-${Date.now()}.zip"`);
  const archive = archiver('zip', { store: true }); // no compression: media files are already compressed, so this is just faster
  archive.on('error', (err) => { console.error('zip error:', err.message); res.destroy(); });
  archive.pipe(res);
  for (const p of valid) {
    if (fs.statSync(p).isDirectory()) archive.directory(p, path.basename(p));
    else archive.file(p, { name: path.basename(p) });
  }
  archive.finalize();
});

// ---------- stats (speed, transferred today, disk free) ----------
app.get('/api/stats', (req, res) => {
  let diskFreeBytes = null, diskTotalBytes = null;
  try {
    ({ free: diskFreeBytes, total: diskTotalBytes } = diskSpace(SHARED_DIR));
  } catch (e) { /* statfs unsupported on this platform/Node version */ }

  const totals = sharedTotals();

  res.json({
    speedBps: currentSpeedBps(),
    transferredTodayBytes: bytesToday,
    fileCount: totals.files,
    totalSizeBytes: totals.bytes,
    diskFreeBytes,
    diskTotalBytes,
  });
});

// ---------- paired devices ----------
app.get('/api/devices', (req, res) => {
  const now = Date.now();
  const list = [{ id: HOST_ID, name: HOST_NAME, kind: 'host', online: true, isHost: true }];
  for (const [id, d] of Object.entries(devices)) {
    if (d.forgotten) continue;
    list.push({ id, name: d.name, kind: d.kind, online: now - (lastSeen[id] || 0) < ONLINE_WINDOW_MS, isHost: false });
  }
  res.json(list);
});

app.post('/api/devices/ping', (req, res) => {
  const id = req.headers['x-device-id'];
  if (id === HOST_ID) return res.json({ ok: true, isHost: true, name: HOST_NAME });
  if (!id || !DEVICE_ID.test(id)) return res.status(400).json({ error: 'bad device id' });
  const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 40) : '';
  // Forgotten from another device: tell this one to come back as a new device rather than
  // silently re-appearing (or becoming a zombie that can never be listed again).
  if (devices[id] && devices[id].forgotten) return res.json({ ok: true, reset: true });
  lastSeen[id] = Date.now();
  if (!devices[id]) { devices[id] = { name: name || detectKind(req.headers['user-agent']), kind: detectKind(req.headers['user-agent']) }; saveDevices(); bump('devices'); }
  else if (name && name !== devices[id].name) { devices[id].name = name; saveDevices(); bump('devices'); }
  // Safari empties a site's localStorage after 7 days without a visit, and the phone then came
  // back as a second "iPhone". A cookie the server sets isn't under that cap, so the page falls
  // back to it for its id.
  res.append('Set-Cookie', `ls_dev=${id}; Path=/; Max-Age=31536000; SameSite=Lax`);
  res.json({ ok: true });
});

app.post('/api/devices/:id/name', (req, res) => {
  const { id } = req.params;
  if (id === HOST_ID || req.headers['x-device-id'] === HOST_ID) return res.status(400).json({ error: 'cannot rename host' });
  if (!DEVICE_ID.test(id)) return res.status(400).json({ error: 'bad device id' });
  const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 40) : '';
  if (!name) return res.status(400).json({ error: 'name required' });
  if (devices[id] && devices[id].forgotten) return res.status(404).json({ error: 'not found' });
  devices[id] = devices[id] || { name, kind: 'Device' };
  devices[id].name = name;
  saveDevices();
  bump('devices');
  res.json({ ok: true });
});

app.delete('/api/devices/:id', (req, res) => {
  const { id } = req.params;
  if (id === HOST_ID) return res.status(400).json({ error: 'cannot remove host' });
  if (!devices[id] || devices[id].forgotten) return res.status(404).json({ error: 'not found' });
  devices[id] = { forgotten: true };
  delete lastSeen[id];
  saveDevices();
  bump('devices');
  res.json({ ok: true });
});

// ---------- clipboard / text sharing ----------
app.get('/api/clipboard', (req, res) => res.json(clipboard.slice(-30).reverse()));

app.post('/api/clipboard', (req, res) => {
  const text = req.body && typeof req.body.text === 'string' ? req.body.text.slice(0, 20000) : '';
  if (!text.trim()) return res.status(400).json({ error: 'empty' });
  const item = { id: crypto.randomUUID(), text, at: Date.now(), from: nameForDevice(req) };
  clipboard.push(item);
  if (clipboard.length > 200) clipboard = clipboard.slice(-200);
  saveClipboard();
  bump('clip');
  res.json({ ok: true, item });
});

app.delete('/api/clipboard/:id', (req, res) => {
  clipboard = clipboard.filter((c) => c.id !== req.params.id);
  saveClipboard();
  bump('clip');
  res.json({ ok: true });
});

// Real adapters first: the QR code uses the first address, and on a PC with WSL/Docker/
// Hyper-V/VirtualBox that used to be a 172.x virtual switch no phone can reach.
// (The PC's own hotspot is "Local Area Connection* N" and deliberately counts as real.)
const VIRTUAL_NIC = /vethernet|wsl|hyper-v|virtualbox|vmware|vbox|docker|^br-|^veth|tailscale|zerotier|utun|^bridge/i;
function lanAddresses(nets = os.networkInterfaces()) {
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) out.push({ ip: net.address, virtual: VIRTUAL_NIC.test(name) });
    }
  }
  return out.sort((a, b) => a.virtual - b.virtual).map((a) => a.ip); // stable: OS order within each group
}

const QR_PATH = path.join(__dirname, 'connect-qr.png');
app.get('/connect-qr.png', (req, res) => { res.setHeader('Cross-Origin-Resource-Policy', 'same-origin'); res.sendFile(QR_PATH); });

// Served inline (no attachment) and with the x-x509-ca-cert type iOS looks for, so tapping
// this link offers to install it as a configuration profile instead of downloading a file.
app.get('/lanlord-ca.crt', (req, res) => {
  res.type('application/x-x509-ca-cert');
  res.sendFile(CA_CRT, (err) => { if (err) res.status(404).end(); });
});

app.get('/api/server-info', (req, res) => {
  const hostname = os.hostname();
  const k = `/?k=${encodeURIComponent(TOKEN)}`; // a scanned/copied URL unlocks the new device by itself
  res.json({
    hostname,
    port: PORT,
    passcode: TOKEN,
    hostUrl: `http://${hostname}.local:${PORT}${k}`,
    lanUrls: lanAddresses().map((ip) => `http://${ip}:${PORT}${k}`),
    // What the iPhone Shortcut's import question asks for: upload straight in, passcode included.
    networkWarning,
    shortcutUrl: `http://${hostname}.local:${PORT}/api/upload?k=${encodeURIComponent(TOKEN)}`,
    // Present only once the certs exist: over https the clipboard API works, which is the
    // only way a phone can copy a picture itself rather than a link to it.
    httpsUrl: tls ? `https://${hostname}.local:${HTTPS_PORT}${k}` : null,
    httpsLanUrls: tls ? lanAddresses().map((ip) => `https://${ip}:${HTTPS_PORT}${k}`) : [],
    cloudSyncWarning: CLOUD_SYNC_WARNING,
  });
});

// Anything a route didn't answer itself (a malformed JSON body, say) gets a plain message, not a stack.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (!(err.status < 500)) console.error('request failed:', req.method, req.path, err.message);
  res.status(err.status || 500).json({ error: err.status < 500 ? 'bad request' : 'request failed' });
});

module.exports = { findFfmpeg, MEDIA_ONLY, knownHost, realInside, saveJson, mp4Args, compressArgs, safeSharedPath, safeDir, normRel, safeFileName, uniqueName, SHARED_DIR, cookieToken, stripKey, sameToken, TOKEN, trashName, trashOrigin, isLoopback, lanAddresses, sameFile, authBlocked, noteAuthAttempt, AUTH_WINDOW_MS, FFMPEG, partPath, publicLanAdapters, isCrossSite, DEVICE_ID, cloudSyncService, debounced, walkStatsCached, walkCache, WALK_TTL_MS, WALK_CACHE_MAX, copyExif, convertBackoff, sameSnap, isConvertible, isReadOnly, stableEnough, needsSettle, CONVERT_MAX_WAIT_MS, roomFor, SPACE_MARGIN_BYTES, PREVIEW_KINDS, changed };
if (require.main !== module) return; // required by selftest.js - don't grab the port

// The debounced metadata write must not die with the process: the service is stopped, and a
// dev shell Ctrl+C'd, far more often than either crashes. 'exit' covers the ordinary ways out;
// the signals don't reach it on their own, because listening for them replaces Node's default
// "terminate now", so each one has to end the process itself.
// A SIGKILL, a power cut, or Windows' service manager killing the process outright
// can't be caught at all, so the ceiling is the half-second of attribution that was in flight -
// who sent those last few photos, never the photos themselves. Writing every change through
// would cost the 2000 writes this change exists to remove.
process.on('exit', () => { saveMetaSoon.flush(); });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, () => { saveMetaSoon.flush(); process.exit(0); }); } catch (e) { /* signal unknown on this platform */ }
}

const server = app.listen(PORT, async () => {
  // Unlimited timeouts: default Node request timeouts (5 min) would otherwise kill large video uploads on slow wifi.
  // Only the request itself may run forever (a huge upload on slow wifi). Headers must arrive
  // within a minute and a silent socket closes after ten, or a guest without the passcode could
  // hold thousands of half-open connections (SSE pings every 25s, so it never goes silent).
  server.requestTimeout = 0;
  server.headersTimeout = 60 * 1000;
  server.timeout = 10 * 60 * 1000;

  convertExisting().catch((e) => console.error('startup convert scan failed:', e.message));
  pruneTrash(); // otherwise a share nobody has deleted from lately keeps last month's deletions forever
  prunePreviews();
  pruneParts();
  checkNetwork(); // an upload abandoned for two days isn't coming back

  const hostname = os.hostname();
  const key = `/?k=${encodeURIComponent(TOKEN)}`;
  const hostUrl = `http://${hostname}.local:${PORT}${key}`;
  const ipUrls = lanAddresses().map((ip) => `http://${ip}:${PORT}${key}`);

  console.log('Lanlord running.');
  console.log(`  Primary (works even if your IP changes): ${hostUrl}`);
  ipUrls.forEach((u) => console.log(`  Fallback:                                 ${u}`));
  console.log(`  Shared folder: ${SHARED_DIR}`);
  if (CLOUD_SYNC_WARNING) console.warn(`  WARNING: ${CLOUD_SYNC_WARNING} Set LANLORD_DIR to a folder outside it if you don't want that.`);
  console.log(`  Passcode (other devices need it once): ${TOKEN}`);

  const qrTarget = ipUrls[0] || hostUrl;
  const qrPath = QR_PATH;
  try {
    await QRCode.toFile(qrPath, qrTarget, { width: 400 });
    console.log(`  QR code (scan with iPhone camera to open Safari): ${qrPath}`);
  } catch (e) {
    console.error('Could not generate QR code:', e.message);
  }
});
if (tls) {
  const secure = https.createServer({ key: tls.key, cert: tls.cert }, app);
  secure.requestTimeout = 0; secure.headersTimeout = 60 * 1000; secure.timeout = 10 * 60 * 1000; // as above
  secure.listen(HTTPS_PORT, () => console.log(`  Secure (needed for copy-image on a phone):  https://${os.hostname()}.local:${HTTPS_PORT}`));
  secure.on('error', (e) => console.error('HTTPS listener failed:', e.message));
} else {
  console.log('  No HTTPS: openssl not found, so copy-image stays PC-only. Set LANLORD_OPENSSL to its path.');
}

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use - is the Lanlord service already running?` : e.message);
  process.exit(1);
});
