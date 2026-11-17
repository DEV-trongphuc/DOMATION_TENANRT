// CloudLinux / LiteSpeed Phusion Passenger Entrypoint
const fs = require('node:fs');
const path = require('node:path');

process.chdir(__dirname);
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

// Preserve Passenger's assigned Unix domain socket or port
if (process.env.PORT) {
  process.env.PASSENGER_PORT = process.env.PORT;
}

(async () => {
  try {
    const prebuiltEntry = path.join(__dirname, 'dist-server', 'index.mjs');
    if (fs.existsSync(prebuiltEntry)) {
      await import('./dist-server/index.mjs');
    } else {
      await import('tsx/esm');
      await import('./server/index.ts');
    }
  } catch (err) {
    console.error('[Passenger Boot Fatal Error]', err);
    process.exit(1);
  }
})();
