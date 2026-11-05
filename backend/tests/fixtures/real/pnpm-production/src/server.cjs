require('node:http').createServer((req, res) => res.end('Production script fixture')).listen(Number(process.env.PORT), '0.0.0.0');
