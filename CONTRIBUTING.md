# Contributing to Lanlord

Thanks for helping. Lanlord is deliberately small: one Node server (`server.js`), one web
page (`public/index.html`), one test file (`selftest.js`). [ARCHITECTURE.md](ARCHITECTURE.md)
explains how the code is laid out. Read it before a bigger change.

## Run it for development

You need Windows 10/11 and [Node.js 24](https://nodejs.org). ffmpeg (`winget install
Gyan.FFmpeg`) is only needed if you work on previews, conversion or compression.

```powershell
git clone https://github.com/donerfolk/Lanlord.git
cd Lanlord
npm install
$env:LANLORD_PORT=9911; $env:LANLORD_HTTPS_PORT=9912; node server.js
```

Then open `http://localhost:9911`. The PC's own browser skips the passcode. To try it from
a phone, use the address and passcode the console prints.

**Keep away from a Lanlord you actually use.** If Lanlord runs as a Windows service on your
PC, it holds ports 8811/8812 and its data is real:

- Develop on other ports (9911/9912 above), never 8811/8812, and don't restart or stop the
  service to test something.
- Never run `install-service.js` or `uninstall-service.js` to try them out: loading either
  one installs or removes the real service. Check them with `node --check` or by reading them.
- A second copy started in the same folder uses the same `shared/`, `auth.json` and
  `devices.json`. Develop in a separate clone (or a `git worktree`) to get an empty share of
  your own. If you do test against real files, give yours a prefix like `zz-` and delete them through
  the app afterwards, so they go to the trash.
- Restart your dev copy after changing `server.js`. A change to `public/index.html` only
  needs a page reload.

## Tests

```powershell
node selftest.js
```

It must print `selftest ok`. It is plain `assert` with no framework, and GitHub Actions runs
it on Windows and Ubuntu for every push and pull request. New logic gets a case there:
anything that parses input, touches paths, or makes a decision (see the existing ones for
the style). Anything that needs a real browser or phone: say in the pull request what you
checked by hand, and on which device.

## Rules

- **No build step, no frontend framework, no frontend dependencies.** The whole page is
  `public/index.html`. The server keeps its few npm dependencies; ask before adding one.
- **No third-party requests, ever.** No CDN, no web fonts, no analytics. Lanlord must work
  with the internet unplugged (a PC hotspot is a normal way to use it).
- **Every client-supplied path goes through the helpers:** `normRel`, then
  `safeSharedPath` (a file or folder) or `safeDir` (a folder, `''` = the share root).
  Uploaded names go through `safeFileName`, collisions through `uniqueName`. Never overwrite.
- **Every endpoint that changes something calls `bump()`**, so other devices update.
- **Never lose data.** Deleting goes to the trash with Undo, not a confirm dialog.
  Compress never keeps a bigger file.
- **Phone and PC are equal.** A feature works with touch (long-press, swipe) and with a
  mouse and keyboard.
- **Conventional design:** side nav, top bar, table, right-hand panel, one blue accent for
  actions and the current selection, soft rounded corners, Figtree only, and tabular numbers
  wherever figures line up or change. Reuse existing components and patterns. Ask before changing how
  anything looks.
- **Code style:** small, direct diffs. Comments explain *why*. A deliberate shortcut
  says so in a comment and names its limit. 2 spaces, single quotes, semicolons.

## Reporting a bug

Use the [bug report form](https://github.com/donerfolk/Lanlord/issues/new/choose). What
makes a report useful:

- **Both ends:** the PC's Windows version and `node --version`, and the phone's model, OS
  version and browser (Safari, the Home Screen app, Chrome…).
- **How the phone connects:** `http` or `https`, and by IP address, by `<pc-name>.local`,
  or by the QR code. Most connection problems depend on exactly this.
- **What happened, and what you expected instead.** Steps someone else can follow.
- **Errors:** the console window Lanlord runs in. As a service, that's
  `daemon/lanlord.err.log` and `daemon/lanlord.out.log`. On the PC, also check the
  browser's console (F12).

Leave out your passcode and any link containing `?k=`: that is the passcode.

**Security problems:** please don't open a public issue.
[Report them privately](https://github.com/donerfolk/Lanlord/security/advisories/new).
