const fs = require('node:fs');
fs.mkdirSync('dist', { recursive: true });
fs.copyFileSync('src/server.cjs', 'dist/server.cjs');
