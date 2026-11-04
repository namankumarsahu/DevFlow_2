import http from 'node:http';
http.createServer((req,res)=>res.end('Pocket')).listen(4173, '127.0.0.1');
