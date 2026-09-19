const path = require('path');
const { Service } = require('node-windows');

// 'LocalShare' is the name the service had before the project was renamed: removing it here too
// lets an existing install switch over with uninstall-service.js + install-service.js.
for (const name of ['Lanlord', 'LocalShare']) {
  const svc = new Service({ name, script: path.join(__dirname, 'server.js') });
  svc.on('uninstall', () => console.log(`${name} service removed.`));
  svc.on('alreadyuninstalled', () => {}); // most installs only ever had one of the two
  svc.uninstall();
}
