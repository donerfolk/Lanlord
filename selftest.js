// Smallest thing that fails if the shared-folder path guard breaks.  Run: node selftest.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveJson, mp4Args, compressArgs, safeSharedPath, safeDir, normRel, safeFileName, SHARED_DIR, cloudSyncService, cookieToken, stripKey, sameToken, TOKEN, trashName, trashOrigin, sameFile, authBlocked, noteAuthAttempt, AUTH_WINDOW_MS, debounced, walkStatsCached, walkCache, WALK_TTL_MS, WALK_CACHE_MAX, changed, copyExif } = require('./server.js');

// uploaded names can't escape the folder, hide themselves, or use characters Windows rejects
assert.strictEqual(safeFileName('../../evil.txt'), 'evil.txt');
assert.strictEqual(safeFileName('.meta.json'), 'meta.json');
assert.strictEqual(safeFileName('a<b>:"c|d?e*.txt'), 'a_b___c_d_e_.txt');
assert.strictEqual(safeFileName('בינה חברותית.pdf'), 'בינה חברותית.pdf');
assert.strictEqual(safeFileName('...'), 'file');
assert.strictEqual(safeFileName('con.txt'), '_con.txt');
assert.strictEqual(safeFileName('console.txt'), 'console.txt');
// Windows silently drops trailing dots/spaces on write, so the file would land under a name
// that never matches its .meta.json key and lose its attribution
assert.strictEqual(safeFileName('photo.jpg.'), 'photo.jpg');
assert.strictEqual(safeFileName('report. '), 'report');
assert.strictEqual(safeFileName('a. . '), 'a');
assert.strictEqual(safeFileName('. . '), 'file', 'a name that is only dots and spaces still gets one');
assert.strictEqual(safeFileName('con.'), '_con', 'a reserved name is still reserved once the dot goes');
assert.strictEqual(safeSharedPath('.meta.json'), null, 'state files are not deletable');

// legitimate names resolve inside the shared folder
assert.strictEqual(safeSharedPath('photo.jpg'), path.join(SHARED_DIR, 'photo.jpg'));
assert.strictEqual(safeSharedPath('image (1).jpg'), path.join(SHARED_DIR, 'image (1).jpg'));

// subfolders are allowed now, at any depth, with either separator
assert.strictEqual(safeSharedPath('trip/photo.jpg'), path.join(SHARED_DIR, 'trip', 'photo.jpg'));
assert.strictEqual(safeSharedPath('a/b/c/d.txt'), path.join(SHARED_DIR, 'a', 'b', 'c', 'd.txt'));
assert.strictEqual(safeSharedPath('trip' + String.fromCharCode(92) + 'photo.jpg'), path.join(SHARED_DIR, 'trip', 'photo.jpg'));
assert.strictEqual(normRel('/trip//sub/'), 'trip/sub', 'stray separators collapse');

// safeDir is the same guard, except that empty means the share root
assert.strictEqual(safeDir(''), SHARED_DIR);
assert.strictEqual(safeDir(undefined), SHARED_DIR);
assert.strictEqual(safeDir('trip'), path.join(SHARED_DIR, 'trip'));
assert.strictEqual(safeDir('../elsewhere'), null, 'a bad folder is not silently the root');

// anything that escapes the folder is rejected
for (const bad of [
  '../devices.json',
  '../../etc/passwd',
  '..' + String.fromCharCode(92) + 'devices.json',  // backslash separator (Windows)
  '../shared-other/x.txt',   // the sibling-prefix case a plain startsWith() check let through
  'trip/../../devices.json', // a traversal hiding mid-path, now that subfolders are legal
  'trip/.meta.json',         // state files stay unreachable inside subfolders too
  '',
  null,
  42,
]) assert.strictEqual(safeSharedPath(bad), null, 'should reject: ' + bad);

// LANLORD_DIR can point the share anywhere, including into a cloud folder that would
// upload every file the owner thinks is staying at home. Matching is per path segment:
// "OneDriveBackups" is an ordinary folder that merely starts the same way.
const bs = (p) => p.split('/').join(String.fromCharCode(92)); // the same path as Windows writes it
for (const [dir, env, expected] of [
  ['C:/Users/x/OneDrive/shared', {}, 'OneDrive'],
  [bs('C:/Users/x/OneDrive/shared'), {}, 'OneDrive'],
  ['C:/Users/x/OneDrive - Contoso/shared', {}, 'OneDrive'],           // work/school account
  ['D:/Synced/shared', { OneDrive: bs('D:/Synced') }, 'OneDrive'],    // personal, folder moved off the path
  ['D:/Synced/shared', { OneDriveConsumer: bs('D:/Synced') }, 'OneDrive'],
  ['D:/Work/x/shared', { OneDriveCommercial: bs('D:/Work') }, 'OneDrive'],
  ['C:/Users/x/iCloudDrive/shared', {}, 'iCloud Drive'],
  ['/Users/x/Library/Mobile Documents/com~apple~CloudDocs/shared', {}, 'iCloud Drive'],
  ['C:/Users/x/Dropbox/shared', {}, 'Dropbox'],
  ['C:/Users/x/Dropbox (Personal)/shared', {}, 'Dropbox'],
  ['C:/Users/x/Google Drive/shared', {}, 'Google Drive'],
  ['C:/Users/x/GoogleDrive/shared', {}, 'Google Drive'],
  ['G:/My Drive/shared', {}, 'Google Drive'],
  ['C:/Users/x/Documents/shared', {}, null],
  ['C:/OneDriveBackups/shared', {}, null],                            // prefix, not a segment
  ['C:/Users/x/Dropboxes/shared', {}, null],
  ['C:/Users/x/OneDriveBackups/shared', { OneDrive: bs('C:/Users/x/OneDrive') }, null], // same, via the env root
  ['C:/Users/x/Documents/shared', { OneDrive: '' }, null],            // no OneDrive installed
]) assert.strictEqual(cloudSyncService(dir, env), expected, 'cloud check: ' + dir);
// the default share is wherever the code lives, and that is not a cloud folder by itself
assert.strictEqual(SHARED_DIR, path.resolve(__dirname, process.env.LANLORD_DIR || 'shared'));

// renaming a.jpg -> A.jpg must not read as a clash: on Windows the destination "exists"
// because it is the same file. A different file with that name is still a real clash.
{
  const fs = require('fs');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lanlord-selftest-'));
  try {
    const a = path.join(dir, 'a.jpg'), b = path.join(dir, 'b.jpg');
    fs.writeFileSync(a, 'x');
    fs.writeFileSync(b, 'x');
    assert.ok(sameFile(a, a));
    assert.ok(!sameFile(a, b), 'same contents is not the same file');
    assert.ok(!sameFile(a, path.join(dir, 'gone.jpg')), 'a missing target is not the same file');
    if (process.platform === 'win32') assert.ok(sameFile(a, path.join(dir, 'A.jpg')), 'case-only rename is the same file');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// the passcode gate: only the real passcode opens it, and it stops riding in the URL after that
assert.ok(sameToken(TOKEN));
assert.ok(!sameToken(TOKEN.toLowerCase()), 'the passcode is case-sensitive');
for (const bad of ['', 'x', TOKEN + 'x', TOKEN.slice(0, -1), undefined, null, {}]) assert.ok(!sameToken(bad), 'should reject: ' + bad);
assert.strictEqual(cookieToken({ headers: { cookie: 'a=1; ls_key=ABC; b=2' } }), 'ABC');
assert.strictEqual(cookieToken({ headers: { cookie: 'other_ls_key=ABC' } }), '', 'a lookalike cookie name is not the key');
assert.strictEqual(cookieToken({ headers: {} }), '');
assert.strictEqual(stripKey('/?k=ABC'), '/');
assert.strictEqual(stripKey('/files/a.jpg?k=ABC'), '/files/a.jpg');
assert.strictEqual(stripKey('/api/files?k=ABC&path=trip'), '/api/files?path=trip');
assert.strictEqual(stripKey('//evil.example/?k=ABC'), '/', 'no redirecting off this host');

// guessing the passcode from one address stops after ten tries; the clock is passed in so
// this doesn't have to sit out the ten-minute window
const t0 = 1_700_000_000_000;
const guess = '192.0.2.10';
for (let i = 1; i <= 9; i++) assert.ok(!noteAuthAttempt(guess, false, t0 + i), 'nine wrong tries are still just wrong tries');
assert.ok(!authBlocked(guess, t0 + 9));
assert.ok(noteAuthAttempt(guess, false, t0 + 10), 'the tenth wrong passcode locks the address out');
assert.ok(noteAuthAttempt(guess, false, t0 + 11), 'and so does the eleventh');
assert.ok(authBlocked(guess, t0 + 11));
assert.ok(!authBlocked(guess, t0 + AUTH_WINDOW_MS + 1), 'the lockout ends when the window does');
noteAuthAttempt(guess, true, t0);
assert.ok(!authBlocked(guess, t0), 'the right passcode clears the misses');
for (let i = 1; i <= 20; i++) noteAuthAttempt('127.0.0.1', false, t0 + i);
assert.ok(!authBlocked('127.0.0.1', t0 + 20), 'the PC itself must never be able to lock itself out');

// a deleted file's original path round-trips through the trash entry name, and a doctored
// entry can't make restore write outside the share
for (const rel of ['photo.jpg', 'trip/day 1/a+b&c.jpg', 'בינה.pdf']) {
  assert.strictEqual(trashOrigin(trashName(rel)), rel, 'restore must land where it was deleted from: ' + rel);
}
for (const bad of ['', 'garbage', '__x', 'x__photo.jpg', '123__%2E%2E%2Fdevices.json', '123__..%2F..%2Fetc', '123__%ZZ', null]) {
  assert.strictEqual(trashOrigin(bad), null, 'should reject trash entry: ' + bad);
}

// state files are written via a temp file and renamed, so a crash can't leave half a passcode
// or half the metadata behind - and the temp file must not survive the write
const stateFile = path.join(os.tmpdir(), 'lanlord-selftest-' + process.pid + '.json');
try {
  saveJson(stateFile, { token: 'ABC', nested: [1, 'בינה'] });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { token: 'ABC', nested: [1, 'בינה'] });
  assert.ok(!fs.existsSync(stateFile + '.tmp'), 'the temp file must be gone once the write lands');
  saveJson(stateFile, { token: 'DEF' });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { token: 'DEF' }, 'rename must replace the old file');
} finally {
  fs.rmSync(stateFile, { force: true });
  fs.rmSync(stateFile + '.tmp', { force: true });
}

// a burst of metadata writes (2000 photos arriving one at a time) becomes one write, but
// nothing may be left unwritten when the process goes down. The timers are injected, so this
// drives the window instead of sitting through it.
{
  let writes = 0, nextId = 1;
  const timers = new Map();
  const clock = {
    setTimeout: (fn) => { const id = nextId++; timers.set(id, fn); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  const tick = () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } };
  const soon = debounced(() => writes++, 500, clock);

  soon(); soon(); soon();
  assert.strictEqual(timers.size, 1, 'a burst must schedule one write, not one per call');
  assert.strictEqual(writes, 0, 'nothing is written inside the window');
  tick();
  assert.strictEqual(writes, 1, 'the window closing does write');
  assert.ok(!soon.pending(), 'and leaves nothing pending');

  assert.strictEqual(soon.flush(), false, 'flush with nothing pending is a no-op');
  assert.strictEqual(writes, 1);

  soon();
  assert.ok(soon.pending());
  assert.strictEqual(soon.flush(), true, 'flush reports that it had something to write');
  assert.strictEqual(writes, 2, 'flush writes immediately');
  assert.strictEqual(timers.size, 0, 'and cancels the timer, or the exit write happens twice');
  tick();
  assert.strictEqual(writes, 2, 'a flushed window must not fire again');

  // the whole point: 2000 scheduled writes cost one write per window, not 2000
  for (let i = 0; i < 2000; i++) soon();
  assert.strictEqual(timers.size, 1);
  tick();
  assert.strictEqual(writes, 3);
}

// folder sizes are cached per folder: a change drops what it can have moved (changed(), below),
// and the TTL is the backstop for a change nothing told us about. The clock is passed in.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanlord-selftest-walk-'));
  const t0 = 1_700_000_000_000;
  try {
    fs.writeFileSync(path.join(dir, 'a.bin'), 'xxxxx');
    assert.deepStrictEqual(walkStatsCached(dir, t0), { files: 1, bytes: 5 });
    fs.writeFileSync(path.join(dir, 'b.bin'), 'yyyyy');
    assert.deepStrictEqual(walkStatsCached(dir, t0 + 100), { files: 1, bytes: 5 }, 'inside the window the cached size is served');
    walkCache.clear(); // what the watcher does when Windows can't say what changed
    assert.deepStrictEqual(walkStatsCached(dir, t0 + 200), { files: 2, bytes: 10 }, 'a cleared cache must not be able to leave a stale size behind');
    fs.writeFileSync(path.join(dir, 'c.bin'), 'zzzzz');
    assert.deepStrictEqual(walkStatsCached(dir, t0 + 200 + WALK_TTL_MS), { files: 3, bytes: 15 }, 'the TTL expires a size nothing bumped');
    // and the cache cannot grow without bound: past the cap it starts over
    for (let i = 0; i < WALK_CACHE_MAX + 5; i++) walkStatsCached(path.join(dir, 'missing-' + i), t0);
    assert.ok(walkCache.size <= WALK_CACHE_MAX, 'the folder-size cache must stay bounded: ' + walkCache.size);
    // a folder's size is built from its subfolders' cached sizes, so a change deep down must drop them all the way up
    walkCache.clear();
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'd.bin'), 'dd');
    assert.deepStrictEqual(walkStatsCached(dir, t0), { files: 4, bytes: 17 });
    assert.ok(walkCache.has(path.join(dir, 'sub')), 'the walk caches each subfolder on the way');
  } finally {
    walkCache.clear(); // don't leave this test's temp folders cached for the asserts below
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// changed() drops the folders above a change and anything cached below it - and nothing else,
// or every upload would re-walk the whole share again. Cache keys only; nothing touches disk.
{
  const at = (...p) => path.join(SHARED_DIR, ...p);
  const seed = () => { walkCache.clear(); for (const k of [SHARED_DIR, at('a'), at('a', 'b'), at('a', 'b', 'c'), at('side'), at('ab')]) walkCache.set(k, { at: Date.now(), val: { files: 1, bytes: 1 } }); };
  seed();
  changed(at('a', 'b', 'photo.jpg'));
  assert.deepStrictEqual([...walkCache.keys()].sort(), [at('a', 'b', 'c'), at('ab'), at('side')].sort(), 'a new file drops its folder and every folder above it, and only those');
  seed();
  changed(at('a')); // a renamed or deleted folder: its old subfolders' sizes must not come back if the name does
  assert.deepStrictEqual([...walkCache.keys()].sort(), [at('ab'), at('side')].sort(), 'a changed folder drops everything cached under it - but not a sibling that shares its prefix');
  walkCache.clear();
}

// https certs: what the phone trusts must actually cover the names this PC answers on,
// or Safari refuses the connection and copy-image is back to being impossible there.
const { ensureCerts, sanNames, certCovers, CA_CRT } = require('./certs.js');
const tls = ensureCerts();
if (!tls) console.log('  (skipped cert checks: no openssl and no certs on disk)');
else {
  assert.ok(certCovers(path.join(__dirname, 'certs', 'server.crt'), sanNames()), 'server cert must cover every LAN name/IP');
  assert.ok(!certCovers(CA_CRT, sanNames()), 'the CA has no SANs, so it must not pass as the server cert');
  assert.ok(!certCovers(path.join(__dirname, 'certs', 'nope.crt'), sanNames()), 'a missing cert is not a valid cert');
  assert.deepStrictEqual(ensureCerts().cert, tls.cert, 'a second call must reuse the cert, not re-issue it');
}

// phone video: compatible streams are copied (lossless), anything else re-encoded, hevc gets the
// tag iOS needs. Exact arrays, because a -c:a:0/-c:a:1 paired with the wrong track still "includes"
// the right flags - and mis-pairing them would re-encode a track that should have been copied.
const stream = (index, codec_type, codec_name) => ({ index, codec_type, codec_name });
assert.deepStrictEqual(mp4Args([stream(0, 'video', 'h264'), stream(1, 'audio', 'aac')]),
  { args: ['-map', '0:0', '-map', '0:1', '-c:v', 'copy', '-c:a:0', 'copy', '-movflags', '+faststart'], dropped: 0 });
assert.deepStrictEqual(mp4Args([stream(0, 'video', 'hevc'), stream(1, 'audio', 'aac')]),
  { args: ['-map', '0:0', '-map', '0:1', '-c:v', 'copy', '-tag:v', 'hvc1', '-c:a:0', 'copy', '-movflags', '+faststart'], dropped: 0 });
assert.deepStrictEqual(mp4Args([stream(0, 'video', 'vp9'), stream(1, 'audio', 'opus')]),
  { args: ['-map', '0:0', '-map', '0:1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a:0', 'aac', '-b:a:0', '192k', '-movflags', '+faststart'], dropped: 0 });
assert.deepStrictEqual(mp4Args([stream(0, 'video', 'mpeg4')]),
  { args: ['-map', '0:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart'], dropped: 0 });
// a second audio track (the original-language dub) must survive, and only the non-AAC one is re-encoded
assert.deepStrictEqual(mp4Args([stream(0, 'video', 'h264'), stream(1, 'audio', 'aac'), stream(2, 'audio', 'ac3')]),
  { args: ['-map', '0:0', '-map', '0:1', '-map', '0:2', '-c:v', 'copy', '-c:a:0', 'copy', '-c:a:1', 'aac', '-b:a:1', '192k', '-movflags', '+faststart'], dropped: 0 });
// text subtitles fit in an MP4 as mov_text; attachments and data streams are dropped without ceremony
assert.deepStrictEqual(mp4Args([stream(0, 'video', 'h264'), stream(1, 'audio', 'aac'), stream(2, 'subtitle', 'subrip'), stream(3, 'attachment', 'ttf'), stream(4, 'data', 'bin_data')]),
  { args: ['-map', '0:0', '-map', '0:1', '-map', '0:2', '-c:v', 'copy', '-c:a:0', 'copy', '-c:s', 'mov_text', '-movflags', '+faststart'], dropped: 0 });
// image-based subtitles can't go in at all -> reported, so convertToMp4 keeps the original file
assert.deepStrictEqual(mp4Args([stream(0, 'video', 'h264'), stream(1, 'audio', 'aac'), stream(2, 'subtitle', 'hdmv_pgs_subtitle')]),
  { args: ['-map', '0:0', '-map', '0:1', '-c:v', 'copy', '-c:a:0', 'copy', '-movflags', '+faststart'], dropped: 1 });

// a file still arriving must not be converted: the original goes to the trash afterwards, so a
// half-written MP4 is the only copy left. Two stat snapshots have to agree before ffmpeg runs.
const { convertBackoff, sameSnap, isConvertible, isReadOnly, stableEnough, needsSettle, CONVERT_MAX_WAIT_MS } = require('./server.js');
const snap = (size, mtimeMs) => ({ size, mtimeMs });
assert.ok(sameSnap(snap(1000, 5), snap(1000, 5)));
assert.ok(!sameSnap(snap(1000, 5), snap(2000, 5)), 'a growing file is still being copied');
assert.ok(!sameSnap(snap(1000, 5), snap(1000, 6)), 'same size, rewritten in place, is still a change');
assert.ok(!sameSnap(null, snap(1000, 5)), 'the very first check has nothing to compare against');
assert.ok(!sameSnap(snap(1000, 5), null), 'a file that vanished is not a stable file');
assert.ok(sameSnap(snap(0, 5), snap(0, 5)), 'an empty file that stays empty is stable (ffprobe then finds no video and drops it)');

// .ts is an MPEG transport stream and also a TypeScript source file; only the sync byte tells
// them apart, and probing a source file would end in a give-up message about a non-video
assert.ok(isConvertible('a.ts', Buffer.from([0x47])));
assert.ok(!isConvertible('a.ts', Buffer.from([0x69])), 'TypeScript source is not a video');
assert.ok(!isConvertible('a.ts', Buffer.alloc(0)), 'an empty or unreadable .ts tells us nothing, so leave it alone');
assert.ok(!isConvertible('a.ts', null));
assert.ok(isConvertible('a.mkv', Buffer.alloc(0)), 'every other extension on the list is unambiguous: no read needed');
assert.ok(isConvertible('a.MKV', null));
assert.ok(!isConvertible('a.mp4', Buffer.from([0x47])), 'already phone-playable: not ours to touch');
assert.ok(!isConvertible('a.txt', Buffer.from([0x47])));

// the retry schedule: doubling, capped at a minute so a stall is still checked often, giving up
// at ten minutes - not before (a slow copy must survive) and not never (no runaway timer)
assert.strictEqual(convertBackoff(1).delayMs, 4000);
assert.strictEqual(convertBackoff(2).delayMs, 8000);
assert.strictEqual(convertBackoff(4).totalMs, 4000 + 8000 + 16000 + 32000);
assert.strictEqual(convertBackoff(5).delayMs, 60000, 'the wait is capped, not doubled forever');
assert.strictEqual(convertBackoff(20).delayMs, 60000);
const lastCheck = 13;
for (let i = 1; i <= lastCheck; i++) assert.ok(!convertBackoff(i).giveUp, 'no early give-up, attempt ' + i);
assert.strictEqual(convertBackoff(lastCheck).totalMs, CONVERT_MAX_WAIT_MS, 'the schedule lands exactly on the ten-minute budget');
assert.strictEqual(CONVERT_MAX_WAIT_MS, 10 * 60 * 1000);
assert.ok(convertBackoff(lastCheck + 1).giveUp, 'and nothing is scheduled past it');

// where the file came from decides whether it has to prove it is complete. Our own upload
// endpoints wrote and closed it, so waiting would only delay the MP4; a file that was already
// in the share at startup gets no such promise (a reboot can interrupt a copy mid-flight, and
// the leftover looks exactly like a finished file), so it settles like an Explorer drop does.
assert.ok(!needsSettle('upload'), '/api/upload and /api/share hand us a closed file');
assert.ok(needsSettle('watch'), 'an Explorer drop is the slow-copy case');
assert.ok(needsSettle('startup'), 'a file left behind by an interrupted copy looks finished');
for (const odd of [undefined, null, '', 'UPLOAD', 'something-new']) assert.ok(needsSettle(odd), 'an unknown source settles: ' + odd);

// a read-only file can never be opened for writing, so the exclusive probe would call it locked
// forever and give up on a finished video. It leans on stability instead - and has to hold still
// twice, so a copy that is still running is still caught.
assert.ok(isReadOnly(0o444), 'Windows reports 0o444 for the read-only attribute');
assert.ok(!isReadOnly(0o666), 'and 0o666 for a normal file');
assert.ok(!isReadOnly(0o644));
assert.ok(isReadOnly(0o400));
assert.ok(!stableEnough(0, false), 'one snapshot on its own proves nothing');
assert.ok(stableEnough(1, false), 'one agreeing pair is enough when the write probe also passed');
assert.ok(!stableEnough(1, true), 'read-only: one quiet interval could just be a stalled copy');
assert.ok(stableEnough(2, true), 'read-only: two quiet intervals in a row');
assert.ok(stableEnough(5, true));

// compress: sliders map to ffmpeg's scales, PNG/HEIC become JPEG, video becomes H.264 MP4, bad input is clamped
assert.strictEqual(compressArgs('a.png', 100, 100).ext, '.jpg');
assert.ok(compressArgs('a.jpg', 100, 100).args.join(' ').includes('-q:v 2'));
assert.ok(compressArgs('a.jpg', 'junk', 5).args.join(' ').includes('scale=trunc(iw*0.1)'));
assert.strictEqual(compressArgs('a.webp', 80, 100).ext, '.webp');
assert.ok(compressArgs('a.MOV', 100, 50).args.join(' ').includes('-crf 18'));
assert.strictEqual(compressArgs('a.mkv', 10, 100).ext, '.mp4');
// a photo must be asked to carry its metadata across, whichever way it comes out
assert.ok(compressArgs('a.jpg', 80, 100).args.join(' ').includes('-map_metadata 0'), 'a compressed photo must keep its EXIF');
assert.ok(compressArgs('a.webp', 80, 50).args.join(' ').includes('-map_metadata 0'));
assert.ok(compressArgs('a.webp', 80, 50).args.join(' ').includes('scale=trunc(iw*0.5)'), 'webp still scales, and still comes out webp');
// HDR only tone-maps when the build can: no zscale means the old encode, not a failed one.
// Never on an image, and never on plain bt709 video - the chain would darken it for nothing.
const hdrVf = (src) => compressArgs('a.MOV', 80, 100, src).args.join(' ');
assert.ok(hdrVf({ hdr: true, zscale: true }).includes('tonemap=tonemap=hable'), 'HLG/PQ video must be tone-mapped down to SDR');
assert.ok(hdrVf({ hdr: true, zscale: true }).includes('zscale=t=bt709:m=bt709:r=tv'), 'and handed back as bt709, or the MP4 still claims to be HDR');
assert.ok(!hdrVf({ hdr: true, zscale: false }).includes('tonemap'), 'no zscale in this ffmpeg build: fall back, do not fail');
assert.ok(!hdrVf({ hdr: false, zscale: true }).includes('tonemap'));
assert.ok(!hdrVf({}).includes('tonemap'), 'no probe result at all is treated as SDR');
assert.ok(!compressArgs('a.jpg', 80, 100, { hdr: true, zscale: true }).args.join(' ').includes('tonemap'));
// tone-mapping comes after the scale (fewer pixels through the expensive filter) and does not
// cost the scale, which is what keeps a 50% slider meaning 50%
const both = compressArgs('a.MOV', 80, 50, { hdr: true, zscale: true }).args.join(' ');
assert.ok(/scale=trunc\(iw\*0\.5\/2\)\*2:-2,zscale=t=linear/.test(both), 'scale then tone-map, in one -vf: ' + both);

// EXIF is spliced back in by hand because ffmpeg cannot write it. The orientation tag must come
// out as 1: ffmpeg's autorotate already turned the pixels, so a copied "rotate 90" would do it
// twice. Built here rather than read from disk so the test needs no sample photo.
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const tiff = Buffer.concat([
  Buffer.from('II'), u16le(0x2a), u32le(8), // little-endian TIFF header, IFD0 at byte 8
  u16le(1), u16le(0x0112), u16le(3), u32le(1), u16le(6), u16le(0), // one entry: Orientation = 6 (rotate 90 CW)
  u32le(26), Buffer.alloc(8), // IFD1 (the embedded thumbnail) lives at 26
]);
const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.alloc(2), Buffer.from('Exif\0\0'), tiff]);
app1.writeUInt16BE(2 + 6 + tiff.length, 2); // JPEG segment lengths are big-endian, the TIFF inside is not
const jpegSrc = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xda, 0x00, 0x03, 0x00, 0xff, 0xd9])]);
const jpegOut = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), Buffer.from([0xff, 0xda, 0x00, 0x03, 0x00, 0xff, 0xd9])]);
const jpegDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanlord-exif-'));
try {
  const src = path.join(jpegDir, 'src.jpg'), out = path.join(jpegDir, 'out.jpg');
  fs.writeFileSync(src, jpegSrc);
  fs.writeFileSync(out, jpegOut);
  assert.ok(copyExif(src, out), 'a JPEG with EXIF must hand it over');
  const got = fs.readFileSync(out);
  assert.deepStrictEqual(got.slice(0, 2), Buffer.from([0xff, 0xd8]), 'still a JPEG');
  assert.deepStrictEqual(got.slice(2, 4), Buffer.from([0xff, 0xe1]), 'EXIF goes straight after the SOI');
  assert.strictEqual(got.slice(6, 12).toString('latin1'), 'Exif\0\0');
  assert.deepStrictEqual(got.slice(2 + app1.length), jpegOut.slice(2), 'the encoded image itself must come through untouched');
  const exif = got.slice(12, 2 + app1.length); // the TIFF block, so its own offsets line up
  assert.strictEqual(exif.readUInt16LE(10 + 8), 1, 'orientation must be reset: autorotate already did the rotating');
  assert.strictEqual(exif.readUInt32LE(22), 0, 'and IFD1 dropped: its thumbnail is the unrotated one');
  // A photo the parser cannot make sense of must leave the compressed file exactly as it was
  fs.writeFileSync(out, jpegOut);
  fs.writeFileSync(src, jpegOut); // no EXIF segment at all
  assert.ok(!copyExif(src, out));
  assert.deepStrictEqual(fs.readFileSync(out), jpegOut, 'nothing to copy must mean nothing written');
  fs.writeFileSync(src, jpegSrc.slice(0, 12)); // truncated mid-APP1
  assert.ok(!copyExif(src, out));
  assert.deepStrictEqual(fs.readFileSync(out), jpegOut, 'a truncated source must not produce a corrupt photo');
} finally {
  fs.rmSync(jpegDir, { recursive: true, force: true });
}

// A HEIC keeps the same EXIF behind the same 'Exif\0\0', but as an item in the container with no
// segment length to read, so the block has to be measured. Built here with an Exif and a GPS
// sub-IFD, and with a neighbouring item right behind it: measuring too generously would drag that
// in, measuring too meanly would leave the GPS pointing at nothing.
const entry = (tag, type, count, value) => Buffer.concat([u16le(tag), u16le(type), u32le(count), value]);
const DATE = Buffer.from('2026:06:11 11:40:56\0', 'latin1'); // 20 bytes, so it cannot live in the entry
const LAT = Buffer.concat([u32le(32), u32le(1), u32le(9), u32le(1), u32le(2884), u32le(100)]); // 32/1 9/1 28.84/1
const heicTiff = Buffer.concat([
  Buffer.from('II'), u16le(0x2a), u32le(8), // 0..7 header
  u16le(3), // 8: IFD0, three entries, then its next-IFD pointer -> 8..49
  entry(0x0112, 3, 1, Buffer.concat([u16le(6), u16le(0)])), // Orientation = 6, inline
  entry(0x8769, 4, 1, u32le(50)), entry(0x8825, 4, 1, u32le(68)), // Exif and GPS sub-IFDs
  u32le(0),
  u16le(1), entry(0x9003, 2, DATE.length, u32le(86)), u32le(0), // 50..67: Exif IFD -> DateTimeOriginal
  u16le(1), entry(0x0002, 5, 3, u32le(106)), u32le(0), // 68..85: GPS IFD -> GPSLatitude
  DATE, LAT, // 86..105, 106..129
]);
assert.strictEqual(heicTiff.length, 130, 'the fixture must be exactly as long as its last value');
const heicSrc = Buffer.concat([
  Buffer.from('\0\0\0\x18ftypheic\0\0\0\0mif1heic', 'latin1'), // enough of a HEIC to look like one
  Buffer.from('Exif no TIFF here', 'latin1'), // a decoy: the signature without a TIFF header behind it
  Buffer.from('\0\0\0\x06', 'latin1'), Buffer.from('Exif\0\0', 'latin1'), heicTiff,
  Buffer.alloc(32, 0xaa), // the next item in the file, which must not end up inside the APP1
]);
const heicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanlord-heic-'));
try {
  const src = path.join(heicDir, 'src.heic'), out = path.join(heicDir, 'out.jpg');
  fs.writeFileSync(src, heicSrc);
  fs.writeFileSync(out, jpegOut);
  assert.ok(copyExif(src, out), 'a HEIC keeps its EXIF too, container item and all');
  const got = fs.readFileSync(out);
  assert.deepStrictEqual(got.slice(2, 4), Buffer.from([0xff, 0xe1]));
  assert.strictEqual(got.readUInt16BE(4), 2 + 6 + heicTiff.length, 'the measured block, not a byte more');
  assert.strictEqual(got.slice(6, 12).toString('latin1'), 'Exif\0\0');
  assert.strictEqual(got.readUInt16LE(12 + 8 + 2 + 8), 1, 'orientation reset here as well: ffmpeg rotates a HEIC by its irot');
  assert.strictEqual(got.slice(12 + 86, 12 + 86 + DATE.length).toString('latin1'), DATE.toString('latin1'), 'capture date must survive');
  assert.deepStrictEqual(got.slice(12 + 106, 12 + 106 + LAT.length), LAT, 'GPS must survive: it is the whole point of copying the block');
  assert.deepStrictEqual(got.slice(2 + 4 + 6 + heicTiff.length), jpegOut.slice(2), 'and the image comes after it, untouched');
  // Nothing to find, or something that points outside itself: leave the compressed photo alone
  fs.writeFileSync(out, jpegOut);
  fs.writeFileSync(src, Buffer.concat([Buffer.from('\0\0\0\x18ftypheic'), Buffer.alloc(64, 0x11)]));
  assert.ok(!copyExif(src, out), 'no Exif item means nothing to copy');
  const bent = Buffer.from(heicSrc);
  const bentTiff = bent.indexOf(Buffer.from('Exif\0\0', 'latin1')) + 6; // the decoy has no \0\0, so this is the real one
  bent.writeUInt32LE(9000, bentTiff + 42); // the GPS pointer in IFD0's third entry, sent off the end of the file
  fs.writeFileSync(src, bent);
  assert.ok(!copyExif(src, out), 'a sub-IFD pointing past the file must be refused, not half-copied');
  assert.deepStrictEqual(fs.readFileSync(out), jpegOut, 'and the photo is left exactly as the encoder wrote it');
} finally {
  fs.rmSync(heicDir, { recursive: true, force: true });
}

// previews and "Download as JPEG": an iPhone HEIC is a tile grid, and ffmpeg refuses a -vf on
// top of one, so no kind that can be handed a photo may use it. The full-size JPEG is only for
// HEIC/HEIF, is never scaled, and is the kind that gets its EXIF back.
{
  const { PREVIEW_KINDS } = require('./server.js');
  for (const k of ['image', 'jpeg']) assert.ok(!PREVIEW_KINDS[k].args.includes('-vf'), `preview kind "${k}" must not use -vf`);
  const jpeg = PREVIEW_KINDS.jpeg;
  assert.ok(!jpeg.args.join(' ').includes('scale'), 'Download as JPEG is the whole photo');
  assert.ok(jpeg.args.join(' ').includes('-q:v 2'), 'at the best mjpeg quality');
  assert.ok(jpeg.exif, 'with its capture date, camera and location');
  for (const ok of ['IMG_1234.HEIC', 'trip/a.heic', 'b.HEIF']) assert.ok(jpeg.only.test(ok), 'jpeg kind should take: ' + ok);
  for (const no of ['a.jpg', 'a.png', 'a.heic.txt', 'heic']) assert.ok(!jpeg.only.test(no), 'jpeg kind should refuse: ' + no);
  assert.strictEqual('trip/IMG_1234.HEIC'.split('/').pop().replace(jpeg.only, '.jpg'), 'IMG_1234.jpg', 'the download keeps the photo name');
}

// only a real browser on this PC skips the passcode - not a DNS-rebound page, not a proxied request
const { isLoopback, lanAddresses } = require('./server.js');
const req = (addr, host, extra) => ({ socket: { remoteAddress: addr }, headers: Object.assign({ host }, extra) });
assert.ok(isLoopback(req('127.0.0.1', 'localhost:8811')));
assert.ok(isLoopback(req('::1', '[::1]:8811')));
assert.ok(isLoopback(req('::ffff:127.0.0.1', require('os').hostname() + '.local:8811')));
assert.ok(!isLoopback(req('127.0.0.1', 'evil.example:8811')), 'DNS rebinding must not get the host pass');
assert.ok(!isLoopback(req('127.0.0.1', undefined)), 'no Host header, no pass');
assert.ok(!isLoopback(req('127.0.0.1', 'localhost', { 'x-forwarded-for': '203.0.113.5' })), 'a proxied request is not local');
assert.ok(!isLoopback(req('192.168.1.20', 'localhost:8811')), 'a LAN client claiming localhost is still a LAN client');

// the QR code's address is a real adapter, not a WSL/Docker/Hyper-V switch
const nic = (address) => [{ family: 'IPv4', internal: false, address }];
assert.deepStrictEqual(lanAddresses({
  'vEthernet (WSL)': nic('172.20.0.1'),
  'Wi-Fi': nic('192.168.1.5'),
  'Ethernet 3': nic('169.254.10.10'),
  'Local Area Connection* 12': nic('192.168.137.1'),
  lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
}), ['192.168.1.5', '192.168.137.1', '172.20.0.1']);

// ffmpeg is found without PATH (the service runs as LocalSystem, whose PATH has no winget
// install): a WinGet ffmpeg under any user must win over the bare-name fallback.
{
  const { FFMPEG } = require('./server.js');
  const winget = (fs.existsSync('C:/Users') ? fs.readdirSync('C:/Users') : []).some((u) => {
    try { return fs.readdirSync(`C:/Users/${u}/AppData/Local/Microsoft/WinGet/Packages`).some((d) => /ffmpeg/i.test(d)); } catch (e) { return false; }
  });
  if (winget && !process.env.LANLORD_FFMPEG) assert.ok(path.isAbsolute(FFMPEG) && fs.existsSync(FFMPEG), 'winget ffmpeg not found: ' + FFMPEG);
}

// resumable uploads: the id names a file in shared/.uploads, so it must never carry a path
{
  const { partPath } = require('./server.js');
  assert.ok(partPath('u-5h3skr1dg7csl-2ln6yo').endsWith(path.join('.uploads', 'u-5h3skr1dg7csl-2ln6yo.part')));
  for (const bad of ['../../x', 'a/b/cdefghij', 'short', '', null, 'u-ok-but' + String.fromCharCode(92) + 'evil', 'x'.repeat(101)]) assert.strictEqual(partPath(bad), null, 'should reject upload id: ' + bad);
}

// an upload the disk can't hold is refused up front, with a margin left over: 1 GB, or 2% of a
// disk small enough that a gigabyte would be most of it
{
  const { roomFor, SPACE_MARGIN_BYTES: GB } = require('./server.js');
  const TB = 1024 * GB;
  assert.strictEqual(GB, 1024 ** 3);
  assert.ok(roomFor(100 * GB, 10 * GB, TB), 'plenty of room');
  assert.ok(roomFor(11 * GB, 10 * GB, TB), 'exactly the margin to spare is enough');
  assert.ok(!roomFor(11 * GB - 1, 10 * GB, TB), 'a byte into the margin is not');
  assert.ok(!roomFor(5 * GB, 50 * TB, TB), 'the 50 TB video');
  assert.ok(!roomFor(GB / 2, 0, TB), 'a disk already inside its margin takes nothing more');
  assert.ok(roomFor(1.5 * GB, GB, 16 * GB), 'a 16 GB stick keeps 2% (~330 MB), not a whole gigabyte');
  assert.ok(!roomFor(1.3 * GB, GB, 16 * GB));
}

// "can't connect" check: only a real LAN adapter on a Public profile is worth a warning
{
  const { publicLanAdapters } = require('./server.js');
  const nets = { 'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.1.5' }], 'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.20.0.1' }] };
  assert.deepStrictEqual(publicLanAdapters({ InterfaceAlias: 'Wi-Fi', NetworkCategory: 0 }, nets), ['Wi-Fi'], 'a single profile comes back as an object, not an array');
  assert.deepStrictEqual(publicLanAdapters([{ InterfaceAlias: 'Wi-Fi', NetworkCategory: 1 }], nets), [], 'Private is fine');
  assert.deepStrictEqual(publicLanAdapters([{ InterfaceAlias: 'vEthernet (WSL)', NetworkCategory: 0 }], nets), [], 'a virtual switch on Public is normal and harmless');
  assert.deepStrictEqual(publicLanAdapters([{ InterfaceAlias: 'Cellular', NetworkCategory: 0 }], nets), [], 'not an adapter we serve on');
}

// an iPhone's decomposed accent and Windows' single character are the same name
assert.strictEqual(require('./server.js').safeFileName('café.jpg'), 'café.jpg');

// security review: a web page in the PC's browser can't drive the API through localhost, a
// device id can't carry markup or "__proto__"
{
  const { isCrossSite, DEVICE_ID } = require('./server.js');
  const r = (method, headers) => ({ method, headers: Object.assign({ host: 'localhost:8811' }, headers) });
  assert.ok(isCrossSite(r('POST', { origin: 'https://evil.example' })), 'another site posting in is refused');
  assert.ok(isCrossSite(r('POST', { 'sec-fetch-site': 'cross-site' })));
  assert.ok(isCrossSite(r('POST', { origin: 'null' })), 'a sandboxed iframe sends Origin: null');
  assert.ok(isCrossSite(r('POST', { origin: 'http://localhost:9999' })), 'another port is another site');
  assert.ok(!isCrossSite(r('POST', { origin: 'http://localhost:8811', 'sec-fetch-site': 'same-origin' })), 'the page itself');
  assert.ok(!isCrossSite(r('POST', {})), 'the iPhone Shortcut and curl send neither header');
  assert.ok(!isCrossSite(r('GET', { 'sec-fetch-site': 'cross-site' })), 'a link to the page is fine; nothing GET changes state');
  assert.ok(DEVICE_ID.test('dev-mu8ox3ud-2gfet867'));
  for (const bad of ['__proto__', 'constructor', 'x"><img src=x onerror=alert(1)>', 'dev-', 'host', ''])
    assert.ok(!DEVICE_ID.test(bad), 'should reject device id: ' + bad);
}

// second security audit
{
  const os = require('os');
  const { execFileSync } = require('child_process');
  const { findFfmpeg, MEDIA_ONLY, knownHost, safeSharedPath, safeFileName, FFMPEG } = require('./server.js');

  // #2: ffmpeg comes from this account's own WinGet folder, never another profile's
  const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'lanlord-ff-'));
  const bin = path.join(mine, 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_x', 'build', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'ffmpeg.exe'), '');
  assert.strictEqual(findFfmpeg({ LOCALAPPDATA: mine }), path.join(bin, 'ffmpeg.exe'));
  assert.strictEqual(findFfmpeg({ LOCALAPPDATA: path.join(mine, 'someone-else') }), 'ffmpeg', 'no other folder is searched');
  assert.strictEqual(findFfmpeg({ LANLORD_FFMPEG: 'D:/tools/ffmpeg.exe', LOCALAPPDATA: mine }), 'D:/tools/ffmpeg.exe', 'the installer-pinned path wins');
  fs.rmSync(mine, { recursive: true, force: true });

  // #1: a playlist can't make ffmpeg read a file outside the share
  const probe = FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
  let haveProbe = true;
  try { execFileSync(probe, ['-version'], { stdio: 'ignore' }); } catch (e) { haveProbe = false; }
  if (haveProbe) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanlord-hls-'));
    const secret = path.join(dir, 'secret.ts');
    execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=d=1:s=64x64', '-c:v', 'libx264', secret]);
    const list = path.join(dir, 'list.m3u8');
    fs.writeFileSync(list, '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:' + secret.replace(/\\/g, '/') + '\n#EXT-X-ENDLIST\n');
    const opens = (args) => { try { execFileSync(probe, [...args, '-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', list], { stdio: 'pipe' }); return true; } catch (e) { return false; } };
    assert.ok(opens([]), 'sanity: without the list, ffprobe follows the playlist (so the test means something)');
    assert.ok(!opens(MEDIA_ONLY), 'with MEDIA_ONLY a playlist is refused');
    fs.rmSync(dir, { recursive: true, force: true });
  } else console.log('  (skipped the playlist check: no ffprobe)');

  // #7: only this PC's own names and addresses
  assert.ok(knownHost('localhost:8811'));
  assert.ok(knownHost(os.hostname() + '.local:8811'));
  assert.ok(!knownHost('rebind.evil.example:8811'), 'a DNS-rebound name is refused');
  assert.ok(!knownHost(undefined));
  const ip = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4');
  if (ip) assert.ok(knownHost(ip.address + ':8811'), 'our own IP address');

  // #9: no alternate data streams
  assert.strictEqual(safeSharedPath('photo.jpg:Zone.Identifier'), null);
  assert.strictEqual(safeSharedPath('x::$DATA'), null);

  // #8: an 8.3 short name doesn't sneak into a dot folder
  if (process.platform === 'win32') {
    const hidden = path.join(SHARED_DIR, '.zz-selftest-hidden-folder');
    fs.mkdirSync(hidden, { recursive: true });
    try {
      const short = execFileSync('powershell.exe', ['-NoProfile', '-Command', '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:LANLORD_T).ShortPath'], { env: Object.assign({}, process.env, { LANLORD_T: hidden }) }).toString().trim();
      const name = path.basename(short);
      if (name.toLowerCase() !== path.basename(hidden).toLowerCase()) assert.strictEqual(safeSharedPath(name), null, 'short name ' + name + ' must not reach a dot folder');
      else console.log('  (skipped the 8.3 check: short names are off on this disk)');
    } finally { fs.rmSync(hidden, { recursive: true, force: true }); }
  }

  // #11, #13: names Windows or Explorer would treat specially
  assert.strictEqual(safeFileName('nul .txt'), '_nul .txt');
  assert.strictEqual(safeFileName('COM\u00b9.txt'), '_COM\u00b9.txt');
  assert.strictEqual(safeFileName('CONIN$'), '_CONIN$');
  assert.strictEqual(safeFileName('invoice\u202Efdp.exe'), 'invoicefdp.exe', 'no right-to-left override');
  assert.strictEqual(safeFileName('free money.url'), 'free money.url.txt');
  assert.strictEqual(safeFileName('desktop.ini'), 'desktop.ini.txt');
  assert.strictEqual(safeFileName('holiday.jpg'), 'holiday.jpg');
}

console.log('selftest ok');
