require('node:http').createServer((req, res) => {
  res.statusCode = req.url === '/ready' ? 200 : 404;
  res.end(req.url === '/ready' ? 'ready' : 'not found');
}).listen(Number(process.env.PORT), '0.0.0.0');
