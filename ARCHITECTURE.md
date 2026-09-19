# How Lanlord works

A short tour of the code for anyone changing it. For using Lanlord, see the
[README](README.md); for sending a change, see [CONTRIBUTING](CONTRIBUTING.md).

## The pieces

| Path | What it is |
|---|---|
| `server.js` | The whole backend: passcode gate, file API, trash, folders, search, zip, ffmpeg work (convert, compress, previews), live updates, devices, clipboard, stats, QR code, HTTPS. It exports its helpers so `selftest.js` can test them without starting a server. |
| `public/index.html` | The whole frontend: markup, one `<style>` block and one script. No build step, no framework, no dependencies. |
| `public/manifest.json` | Web app manifest, including the Android share target (`POST /api/share`). |
| `public/fonts/`, `public/icon.png` | The Figtree font and the app icon, served locally so the page works with no internet. |
| `certs.js` | Makes a local certificate authority (10 years, limited to local names and private addresses) and a short-lived server certificate, reissued when the PC's addresses change. |
| `selftest.js` | The tests. `node selftest.js` prints `selftest ok`. |
| `install-service.js`, `uninstall-service.js` | Install or remove the Windows service (`node-windows`). |

Created at runtime and never committed: `shared/` (your files, plus the hidden `.meta.json`,
`.clipboard.json`, `.trash/`, `.previews/` and `.uploads/`), `auth.json` (the passcode),
`devices.json`, `certs/` (private keys), `daemon/` (service wrapper and logs) and
`connect-qr.png`.

## Running it

- `npm start` runs it in the foreground. As a Windows service it runs as LocalSystem; restart
  it with `Restart-Service lanlord.exe` from an elevated PowerShell after changing the code.
- For development, run a second copy on other ports (`$env:LANLORD_PORT=9911; node server.js`).
  It uses the same `shared/`, `auth.json` and `devices.json`, so create test files with a
  recognisable prefix and delete them through the app.
- `node selftest.js` loads `server.js` without listening on a port.

Requires Node 24. ffmpeg and openssl are optional:

- **ffmpeg** is taken from `LANLORD_FFMPEG`, else from your own WinGet install
  (`%LOCALAPPDATA%\Microsoft\WinGet`), else from PATH. The service runs as LocalSystem, which
  has neither, so `install-service.js` finds your copy and saves its path in the service
  settings. Other accounts' folders are never searched.
- **openssl** comes from `LANLORD_OPENSSL`, PATH or Git for Windows. Without it there is no
  HTTPS.

## Backend, in the order a request meets it

1. **Headers and origin checks.** Every response refuses to be framed. A request that changes
   something is refused if the browser says it came from another site (`Sec-Fetch-Site` /
   `Origin`), and every request must be addressed to one of the PC's own names or addresses
   (`knownHost`, plus `LANLORD_HOSTS`). Together these stop other web pages from driving the API
   through a browser that is already allowed in.
2. **Device identity.** Pages send `X-Device-Id`. A request from the PC itself (loopback
   address, local host name, no proxy header) is the host. `nameForDevice` decides who gets
   credited for an upload.
3. **Passcode gate.** Everyone else needs the 8-character passcode, either as `?k=` (which sets
   a year-long cookie; page loads are redirected to drop it from the address bar) or as that
   cookie. Wrong guesses are limited per address. A `?k=` sent by another website is ignored.
4. **Path safety.** Every path a client sends goes through `normRel` and then `safeSharedPath`
   (a file or folder) or `safeDir` (a folder, empty meaning the share). Segments starting with a
   dot and anything with `:` are refused, and `realInside` re-checks the path on disk, so Windows
   short names (`TRASH~1`) and junctions can't reach hidden or outside files. Upload names go
   through `safeFileName`, and a name that's taken becomes `name (1).ext`: nothing is ever
   overwritten. Any new endpoint that takes a path must use these helpers and get a test.
5. **Files and folders.** `listShared` reads a folder; folder sizes come from `walkStatsCached`,
   and `changed(abs)` clears only the cached sizes a change can affect. `.meta.json` records who
   added what and when; `moveMeta` keeps it in step with renames, moves, deletes and restores.
6. **Trash.** Deleting moves an item to `.trash/<time>__<original path>`; restore puts it back
   where it came from. Items are purged after 7 days.
7. **Uploads.** The page's own queue uses resumable uploads (`GET /api/upload/status`,
   `PUT /api/upload/chunk`, 8 MB pieces into `.uploads/`). The iPhone Shortcut and the share
   target use a plain multipart `POST`. Both refuse an upload the disk can't hold, skip a file
   that's already there byte for byte, and mark what arrives as coming from another computer.
8. **ffmpeg work.** Every ffmpeg and ffprobe call accepts plain media containers only
   (`MEDIA_ONLY`), because a playlist disguised as a video could otherwise make ffmpeg read files
   outside the share.
   - Videos that phones can't play (MKV, AVI and so on) are rewrapped as MP4 when they arrive,
     keeping every audio track and text subtitle. A file copied in through Explorer is only
     converted once it has stopped changing.
   - **Compress** is on request, keeps the photo's metadata, tone-maps HDR video, and never keeps
     a result bigger than the original.
   - **Previews** (`/api/preview`) make a playable copy for a browser that can't show the
     original, and a full-size JPEG of a HEIC photo. They are cached in `.previews/`.
9. **Live updates.** Each page holds `GET /api/events` open. `bump(kind)` tells every page that
   files, the clipboard or the device list changed. A recursive `fs.watch` covers files added in
   Explorer. Anything that changes files calls `changed(abs)` and then `bump()`.
10. **HTTPS.** The same app is served on the HTTPS port when certificates exist, because phones
    only allow copying images and saving to Photos on secure pages.

### API

All JSON and all behind the passcode, unless noted.

| Method and path | Input | What it does |
|---|---|---|
| GET `/api/files` | `?path=` | List a folder |
| GET `/api/search` | `?q=` | Search names across the share (up to 300 results) |
| POST `/api/upload` | multipart `files`, `?path=` | Upload |
| GET `/api/upload/status` | `?id=` | Bytes already received for a resumable upload |
| PUT `/api/upload/chunk` | raw body, `?id&offset&total&name&path` | Add a piece; the file is finished when `total` is reached |
| POST `/api/share` | multipart `files`, `title`, `text`, `url` | Android share target; text goes to the clipboard |
| DELETE `/api/files` | `?name=` | Move to the trash |
| POST `/api/files/rename` | `{ name, to }` | Rename in place |
| POST `/api/folders` | `{ path, name }` | New folder |
| GET `/api/folders` | | Every folder in the share |
| POST `/api/move` | `{ names, to }` | Move items into a folder |
| POST `/api/zip` | `names` | Download items as one zip |
| GET `/api/trash`, POST `/api/restore`, DELETE `/api/trash` | `{ entry }` | List, restore, empty |
| GET `/api/trash/preview` | `?entry=&kind=image|poster` | Thumbnail of a file in the trash (which lives outside `/files`) |
| POST `/api/compress/estimate`, POST `/api/compress` | `{ name, quality, scale, overwrite }` | Estimate or compress a photo or video |
| GET `/api/preview` | `?kind=video\|poster\|image\|jpeg&name=` | A copy the browser can show, or a HEIC as JPEG |
| GET `/api/events` | | Live updates |
| GET `/api/stats` | | Speed, transferred today, totals, free space |
| GET `/api/devices`, POST `/api/devices/ping`, POST `/api/devices/:id/name`, DELETE `/api/devices/:id` | | List, check in, rename, forget |
| GET, POST `/api/clipboard`, DELETE `/api/clipboard/:id` | `{ text }` | Text sent between devices |
| GET `/api/server-info` | | Addresses, passcode, Shortcut link, warnings |
| GET `/files/<path>` | `?download` | The files themselves, with range support |

## Frontend

- A small script in `<head>` applies the saved theme before the page paints.
- The script is one function, split into sections marked `// ---------- name ----------`.
  All state lives in one `state` object; rendering builds HTML strings. Anything a user or
  another device controls (file names, device names, clipboard text) goes through `escapeHtml`.
- The page listens to `/api/events` and falls back to slow polling if that stream is down.
  Polling stops while the page is in the background.
- Only the visible view (list or grid) is built, selection changes update in place, and video
  thumbnails load as they scroll into view, so folders with thousands of files stay quick.
