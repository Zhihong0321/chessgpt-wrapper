/**
 * Run wrapper first: PORT=3457 node server.js  (Windows: $env:PORT='3457'; node server.js)
 * Then: SMOKE_PORT=3457 npm run smoke   (omit SMOKE_PORT if PORT matches)
 */
const http = require('http');

const PORT = parseInt(process.env.SMOKE_PORT || process.env.PORT || '3000', 10);
const HOST = process.env.SMOKE_HOST || '127.0.0.1';

function get(path) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { hostname: HOST, port: PORT, path, method: 'GET', headers: { Connection: 'close' } },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: Buffer.concat(chunks).toString('utf8'),
                    });
                });
            }
        );
        req.on('error', reject);
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error(`timeout GET ${path}`));
        });
        req.end();
    });
}

(async () => {
    const health = await get('/health');
    if (health.status !== 200) throw new Error(`/health HTTP ${health.status}`);
    let j;
    try {
        j = JSON.parse(health.body);
    } catch (_) {
        throw new Error('/health not JSON');
    }
    if (j.ok !== true || typeof j.deepseekUseProxy !== 'boolean') throw new Error('/health unexpected JSON shape');

    const redir = await get('/deepseek/smoke-verify');
    if (redir.status !== 302) throw new Error(`/deepseek should 302, got ${redir.status}`);
    const loc = redir.headers.location;
    if (!loc || !String(loc).includes('chat.deepseek.com/smoke-verify')) {
        throw new Error(`unexpected Location: ${loc}`);
    }

    console.log('smoke-local OK', { port: PORT, deepseekUseProxy: j.deepseekUseProxy, deepseekRedirect: loc });
})().catch((e) => {
    console.error('smoke-local FAIL:', e.message);
    process.exit(1);
});
