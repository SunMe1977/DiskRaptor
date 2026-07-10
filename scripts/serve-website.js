const http = require('http');
const fs = require('fs');
const path = require('path');

const dir = 'C:\\dev\\diskraptor.com';
const mime = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain',
  '.ico': 'image/x-icon', '.png': 'image/png'
};

http.createServer((req, res) => {
  let file = req.url.split('?')[0];
  if (file === '/') file = '/index.html';
  const fp = path.join(dir, file);
  try {
    const c = fs.readFileSync(fp);
    res.writeHead(200, { 'Content-Type': mime[path.extname(fp)] || 'application/octet-stream' });
    res.end(c);
    console.log('200', req.url);
  } catch (e) {
    res.writeHead(404);
    res.end('Not found');
    console.log('404', req.url);
  }
}).listen(3000, () => {
  console.log('\n  DiskRaptor Website: http://localhost:3000');
  console.log('  Druecke Strg+C zum Stoppen\n');
});
