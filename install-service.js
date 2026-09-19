const path = require('path');
const { Service } = require('node-windows');
const { findFfmpeg } = require('./server.js');

// The service runs as SYSTEM, which has no WinGet install of its own, and searching other
// accounts' folders for one is how a planted ffmpeg.exe could run as SYSTEM. So find the owner's
// ffmpeg now, while running as the owner, and hand the service that exact path.
const ffmpeg = findFfmpeg();
const env = path.isAbsolute(ffmpeg) ? [{ name: 'LANLORD_FFMPEG', value: ffmpeg }] : [];
console.log(env.length ? 'Using ffmpeg at ' + ffmpeg : 'ffmpeg not found; conversion, compress and previews stay off until it is installed and the service is reinstalled.');

const svc = new Service({
  name: 'Lanlord',
  description: 'Local network file transfer server between PC and iPhone.',
  script: path.join(__dirname, 'server.js'),
  env,
});

svc.on('install', () => {
  console.log('Lanlord service installed. Starting it now...');
  svc.start();
});
svc.on('alreadyinstalled', () => console.log('Service is already installed.'));
svc.on('start', () => console.log('Lanlord service is running and will auto-start on boot.'));

svc.install();
