const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const ROOT_DIR = __dirname;

const BLOCKED_FILES = new Set([
    '/server.js',
    '/package.json',
    '/package-lock.json',
    '/metadata.json',
]);

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.mp3': 'audio/mpeg',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(reqUrl.pathname);

    if (pathname === '/') {
        pathname = '/index.html';
    }

    if (
        BLOCKED_FILES.has(pathname) ||
        pathname.startsWith('/node_modules') ||
        pathname.includes('..') ||
        path.basename(pathname).startsWith('.')
    ) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
    }

    const filePath = path.join(ROOT_DIR, pathname);
    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            const fallbackPath = path.join(ROOT_DIR, 'index.html');
            fs.readFile(fallbackPath, (fbErr, data) => {
                if (fbErr) {
                    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('Internal Server Error');
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-cache',
                });
                res.end(data);
            });
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': stats.size,
            'Cache-Control': 'no-cache',
        });
        fs.createReadStream(filePath).pipe(res);
    });
});

server.listen(PORT, HOST, () => {
    console.log(`E-Kanban Station Marker server listening on http://${HOST}:${PORT}`);
});
