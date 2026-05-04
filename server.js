require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const dns = require('dns');
const { serializeError, formatErrorLogLine } = require('./serialize_error');

/** Localhost often "just works" while Railway 502s: cloud DNS may prefer AAAA with broken IPv6 egress; home IPv4 path is fine. */
let dnsIpv4FirstApplied = false;
try {
    dns.setDefaultResultOrder('ipv4first');
    dnsIpv4FirstApplied = true;
    console.log('[chesspnt-wrapper] dns.setDefaultResultOrder("ipv4first") applied');
} catch (e) {
    console.warn('[chesspnt-wrapper] dns.setDefaultResultOrder not available:', e.message);
}

const app = express();
app.set('trust proxy', 1);
app.use(cors());

/** Railway volume mount (e.g. /storage). Unset = read/write next to server.js. */
const DATA_DIR = process.env.PERSISTENT_STORAGE_DIR
    ? path.resolve(String(process.env.PERSISTENT_STORAGE_DIR).trim())
    : __dirname;

if (process.env.PERSISTENT_STORAGE_DIR) {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (e) {
        console.warn('[chesspnt-wrapper] PERSISTENT_STORAGE_DIR not usable:', DATA_DIR, e.message);
    }
}

function readTextFileIfExists(filePath) {
    try {
        if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8').trim();
    } catch (_) {}
    return null;
}

function readJsonFileIfExists(filePath) {
    try {
        if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        console.error(
            '[chesspnt-wrapper] Invalid JSON file:',
            filePath,
            '\n' + JSON.stringify(serializeError(e), null, 2)
        );
    }
    return null;
}

/** Upstream SPA (no trailing slash). Override on Railway if your login host changes. */
const PROXY_TARGET = (process.env.CHESSPNT_PROXY_TARGET || 'https://chat.chesspnt.com').replace(/\/$/, '');

/** Outbound ChessPNT / Qwen / DeepSeek: hardcoded limits for slow uplinks (http-proxy proxyTimeout + matching inbound timeouts below).
 * Important: our JSON 502 `{ where: 'chesspnt reverse proxy' }` from proxy `onError` is usually connection reset/refused/TLS/DNS — not “timed out”.
 * Raising this does not fix that class of failure; it only helps genuinely slow upstream first-byte/body delivery. */
const PROXY_TIMEOUT_MS = 900000;
function createKeepAliveAgent(useHttps) {
    const opts = {
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: 80,
        maxFreeSockets: 20,
        timeout: PROXY_TIMEOUT_MS,
    };
    return useHttps ? new https.Agent(opts) : new http.Agent(opts);
}
const chesspntOutboundAgent = createKeepAliveAgent(PROXY_TARGET.startsWith('https'));
const qwenOutboundAgent = createKeepAliveAgent(true);
const deepseekOutboundAgent = createKeepAliveAgent(true);

// Fallback when no volume file, env, or Puppeteer (legacy / local dev)
const defaultLocalStorageData = {
    user: '{"token":"eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjI0MTkzLCJyb2xlIjowLCJsb2dpbklkIjoiZWQyNjY1NDUtMWYzYy00NzcxLTlmNTgtYzJkMmU0YmQ0NDkxIiwidW5hbWUiOiJjbGF1ZGUwMSIsImV4cCI6MTc3Nzg2OTQxN30.vW8EaI3dskDOWWjC1aUFTtHYXsjJ62BuGblE_qKv-hI","id":24193,"username":"claude01","isPlus":2,"isPro":1,"expireTime":"2026-05-05 11:22:18","isLogin":true,"email":"claude01@eternalgy.com","affCode":"4GLR74","plusExpireTime":"2026-05-05 11:22:18","claudeExpireTime":"2026-05-05 11:22:18","claudeProExpireTime":"2026-05-05 11:22:18","grokExpireTime":"2026-05-05 11:22:18","grokSuperExpireTime":null,"loginType":1}',
    device_id: '64b60e9817831c10e473fc1ece248b40',
    accessToken:
        'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjI0MTkzLCJyb2xlIjowLCJsb2dpbklkIjoiZWQyNjY1NDUtMWYzYy00NzcxLTlmNTgtYzJkMmU0YmQ0NDkxIiwidW5hbWUiOiJjbGF1ZGUwMSIsImV4cCI6MTc3Nzg2OTQxN30.vW8EaI3dskDOWWjC1aUFTtHYXsjJ62BuGblE_qKv-hI',
    refreshToken:
        'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjI0MTkzLCJyb2xlIjp0cnVlLCJ1bmFtZSI6ImNsYXVkZTAxIiwicmVmcmVzaFRva2VuSWQiOiI5OTIzMDU2YS0zNTZjLTQyYWQtYjUwOC04N2UxNzZhNDlhOGIiLCJ0eXBlIjoicmVmcmVzaCIsImV4cCI6MTgxMzg2NDkxN30.vNMT-HgTyn_zVQvA67p2izEDp3nemJYtEi02S2bdnWo',
    user_model_preference:
        '{"preference":{"modelName":"Claude+GPT优选不降智","modelType":"sass","timestamp":1777868516497},"timestamp":1777868516497}',
};

const defaultCookies =
    'JSESSIONID=LNMFjAbABq4Q1JESWAYO3vq0tNkU8l_Pg7MjMurq; username=claude01; password=U2FsdGVkX1/CPPB+BqwIsIY9/aqwh1dwUnIbCycCgi4=; rememberMe=true; visitor=false';

const chesspntLsPath = path.join(DATA_DIR, 'chesspnt_localstorage.json');
const chesspntCookiesPath = path.join(DATA_DIR, 'chesspnt_proxy_cookies.txt');

function readInitialLocalStorage() {
    const raw = process.env.CHESSPNT_INJECT_LS_JSON;
    if (raw) {
        try {
            return JSON.parse(raw);
        } catch (e) {
            console.error('CHESSPNT_INJECT_LS_JSON invalid JSON:\n' + JSON.stringify(serializeError(e), null, 2));
        }
    }
    const fromFile = readJsonFileIfExists(chesspntLsPath);
    if (
        fromFile &&
        typeof fromFile.accessToken === 'string' &&
        fromFile.accessToken.length > 40
    ) {
        return fromFile;
    }
    if (fromFile) {
        console.warn('[chesspnt-wrapper] Ignoring invalid chesspnt_localstorage.json on disk (no accessToken); using defaults until Puppeteer succeeds.');
    }
    return defaultLocalStorageData;
}

function readInitialCookies() {
    const fromEnv = process.env.CHESSPNT_PROXY_COOKIES;
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
    const fromFile = readTextFileIfExists(chesspntCookiesPath);
    if (fromFile && fromFile.includes('=') && fromFile.length > 40) return fromFile;
    if (fromFile) {
        console.warn('[chesspnt-wrapper] Ignoring short/invalid chesspnt_proxy_cookies.txt on disk; using baked-in defaults until Puppeteer succeeds.');
    }
    return defaultCookies;
}

let sessionLocalStorage = readInitialLocalStorage();
let sessionCookies = readInitialCookies();

const cookiesFromEnv = Boolean(process.env.CHESSPNT_PROXY_COOKIES);
const lsFromEnv = Boolean(process.env.CHESSPNT_INJECT_LS_JSON);
const cookiesFromFile = fs.existsSync(chesspntCookiesPath);
const lsFromFile = fs.existsSync(chesspntLsPath);

function envBool(name, defaultFalse = false) {
    const v = process.env[name];
    if (v === undefined || v === '') return defaultFalse;
    return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const USE_PUPPETEER_LOGIN =
    envBool('CHESSPNT_USE_PUPPETEER') ||
    envBool('CHESSGPT_USE_PUPPETEER') ||
    envBool('CHESSPNT_PUPPETEER_LOGIN') ||
    envBool('CHESSPNT_AUTO_LOGIN') ||
    envBool('CHESSGPT_AUTO_LOGIN');
const PUPPETEER_USER = (
    process.env.CHESSPNT_USERNAME ||
    process.env.CHESSGPT_USERNAME ||
    ''
).trim();
const PUPPETEER_PASS = (
    process.env.CHESSPNT_PASSWORD ||
    process.env.CHESSGPT_PASSWORD ||
    ''
).trim();
const PUPPETEER_REFRESH_MS = parseInt(process.env.CHESSPNT_PUPPETEER_REFRESH_MS || String(4 * 60 * 60 * 1000), 10);

const puppeteerWanted = USE_PUPPETEER_LOGIN && PUPPETEER_USER && PUPPETEER_PASS && !cookiesFromEnv;

/**
 * Chat is behind Cloudflare: clearance cookies tie to the IP that passed the challenge. A session captured
 * on your laptop is invalid when the server exits from Railway → “Max challenge attempts exceeded”.
 * Default: disable reverse proxy; portal opens https://chat.deepseek.com directly (same idea as Qwen).
 * Enable only after refreshing deepseek_session.json from Puppeteer running with THIS host’s egress IP.
 */
const USE_DEEPSEEK_PROXY = envBool('DEEPSEEK_USE_PROXY') || envBool('CHESSGPT_DEEPSEEK_USE_PROXY');

if (!cookiesFromEnv && !cookiesFromFile && !puppeteerWanted) {
    console.warn(
        '[chesspnt-wrapper] No ChessPNT cookies: set CHESSPNT_USE_PUPPETEER=1 with CHESSPNT_USERNAME/PASSWORD, or CHESSPNT_PROXY_COOKIES, or chesspnt_proxy_cookies.txt on the volume.'
    );
}

if (USE_PUPPETEER_LOGIN && (!PUPPETEER_USER || !PUPPETEER_PASS)) {
    console.warn(
        '[chesspnt-wrapper] ChessPNT Puppeteer is enabled but CHESSPNT_USERNAME or CHESSPNT_PASSWORD is missing.'
    );
}

if (process.env.PERSISTENT_STORAGE_DIR) {
    console.log('[chesspnt-wrapper] PERSISTENT_STORAGE_DIR ->', DATA_DIR);
    if (cookiesFromFile) console.log('[chesspnt-wrapper] Initial cookies from', chesspntCookiesPath);
    if (lsFromFile) console.log('[chesspnt-wrapper] Initial localStorage inject from', chesspntLsPath);
}

function persistChesspntSessionToDisk() {
    fs.writeFileSync(chesspntCookiesPath, sessionCookies, 'utf8');
    fs.writeFileSync(chesspntLsPath, JSON.stringify(sessionLocalStorage, null, 2), 'utf8');
}

let puppeteerLoginInFlight = null;

/** Populated for GET /health — structured errors, no passwords. */
const healthState = {
    lastPuppeteerAttemptAt: null,
    lastPuppeteerAttemptReason: null,
    lastPuppeteerOkAt: null,
    puppeteerLastFailure: null,
    proxyChesspntLastFailure: null,
    proxyQwenLastFailure: null,
    proxyDeepseekLastFailure: null,
};

function logPuppeteerFailure(err) {
    const detail = serializeError(err);
    healthState.puppeteerLastFailure = detail;
    console.error('[chesspnt-wrapper] Puppeteer login failed — full detail:\n' + JSON.stringify(detail, null, 2));
    if (err && err.stack) console.error(err.stack);
}

async function runChesspntPuppeteerLogin(reason) {
    if (!puppeteerWanted) return false;
    healthState.lastPuppeteerAttemptAt = new Date().toISOString();
    healthState.lastPuppeteerAttemptReason = String(reason || '');
    const { loginChesspntSession } = require('./chesspnt_puppeteer_login');
    console.log('[chesspnt-wrapper] ChessPNT Puppeteer login:', reason || 'refresh');
    const { cookieHeader, localStorageObj } = await loginChesspntSession({
        baseUrl: PROXY_TARGET,
        username: PUPPETEER_USER,
        password: PUPPETEER_PASS,
        stepTimeoutMs: parseInt(process.env.CHESSPNT_PUPPETEER_TIMEOUT_MS || '120000', 10),
    });
    sessionCookies = cookieHeader;
    sessionLocalStorage = localStorageObj;
    healthState.lastPuppeteerOkAt = new Date().toISOString();
    healthState.puppeteerLastFailure = null;
    try {
        persistChesspntSessionToDisk();
        console.log('[chesspnt-wrapper] Session saved to', DATA_DIR);
    } catch (e) {
        console.error('[chesspnt-wrapper] Could not persist session:\n' + JSON.stringify(serializeError(e), null, 2));
    }
    return true;
}

function schedulePuppeteerLogin(reason) {
    if (!puppeteerWanted) return Promise.resolve();
    if (puppeteerLoginInFlight) return puppeteerLoginInFlight;
    puppeteerLoginInFlight = runChesspntPuppeteerLogin(reason)
        .catch((e) => {
            logPuppeteerFailure(e);
        })
        .finally(() => {
            puppeteerLoginInFlight = null;
        });
    return puppeteerLoginInFlight;
}

// Qwen session: prefer volume, then app directory (legacy path)
let qwenSession = null;
try {
    const paths = [path.join(DATA_DIR, 'qwen_session.json'), path.join(__dirname, 'qwen_session.json')];
    const sessionPath = paths.find((p) => fs.existsSync(p));
    if (sessionPath) {
        qwenSession = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
        console.log('[chesspnt-wrapper] Qwen session loaded from', sessionPath);
    }
} catch (e) {
    console.warn('[chesspnt-wrapper] Qwen session not found or invalid:', formatErrorLogLine('[qwen session] ', e));
}

// DeepSeek session: prefer volume, then app directory (legacy path)
let deepseekSession = null;
try {
    const paths = [
        path.join(DATA_DIR, 'deepseek_session.json'),
        path.join(__dirname, 'deepseek_session.json'),
    ];
    const sessionPath = paths.find((p) => fs.existsSync(p));
    if (sessionPath) {
        deepseekSession = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
        console.log('[chesspnt-wrapper] DeepSeek session loaded from', sessionPath);
    }
} catch (e) {
    console.warn(
        '[chesspnt-wrapper] DeepSeek session not found or invalid:',
        formatErrorLogLine('[deepseek session] ', e)
    );
}

function puppeteerLoginInFlightFlag() {
    return Boolean(puppeteerLoginInFlight);
}

app.get('/health', (req, res) => {
    const at = sessionLocalStorage && sessionLocalStorage.accessToken;
    res.json({
        ok: true,
        proxyTarget: PROXY_TARGET,
        proxyTimeoutMs: PROXY_TIMEOUT_MS,
        dataDir: DATA_DIR,
        puppeteerWanted,
        puppeteerLoginInFlight: puppeteerLoginInFlightFlag(),
        cookieHeaderLength: sessionCookies ? sessionCookies.length : 0,
        hasAccessToken: typeof at === 'string' && at.length > 20,
        lastPuppeteerAttemptAt: healthState.lastPuppeteerAttemptAt,
        lastPuppeteerAttemptReason: healthState.lastPuppeteerAttemptReason,
        lastPuppeteerOkAt: healthState.lastPuppeteerOkAt,
        puppeteerLastFailure: healthState.puppeteerLastFailure,
        proxyChesspntLastFailure: healthState.proxyChesspntLastFailure,
        proxyQwenLastFailure: healthState.proxyQwenLastFailure,
        proxyDeepseekLastFailure: healthState.proxyDeepseekLastFailure,
        deepseekUseProxy: USE_DEEPSEEK_PROXY,
        dnsIpv4First: dnsIpv4FirstApplied,
        probeChesspntOutbound: '/api/probe-chesspnt-outbound',
    });
});

/**
 * One-shot HTTPS check from this process to PROXY_TARGET (same path as the reverse proxy uses).
 * If localhost works but Railway fails, open this on Railway: `ok:false` here means datacenter egress cannot reach ChessPNT (not a browser/CORS issue).
 */
app.get('/api/probe-chesspnt-outbound', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const t0 = Date.now();
    let targetUrl;
    try {
        targetUrl = new URL(PROXY_TARGET.endsWith('/') ? PROXY_TARGET : `${PROXY_TARGET}/`);
    } catch (e) {
        return res.status(500).json({ ok: false, error: serializeError(e) });
    }
    const lib = targetUrl.protocol === 'https:' ? https : http;
    const opts = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
        path: '/',
        method: 'GET',
        agent: chesspntOutboundAgent,
        headers: {
            Host: targetUrl.hostname,
            'User-Agent': 'Mozilla/5.0 (compatible; chesspnt-wrapper/1.0; outbound-probe)',
            Accept: 'text/html,*/*',
        },
    };
    const preq = lib.request(opts, (pres) => {
        pres.resume();
        res.json({
            ok: true,
            proxyTarget: PROXY_TARGET,
            statusCode: pres.statusCode,
            ms: Date.now() - t0,
            note: 'Reachability only. Upstream may return 302/401 and still prove the TCP/TLS path works.',
        });
    });
    preq.setTimeout(25000, () => {
        preq.destroy(new Error('probe socket timeout after 25s'));
    });
    preq.on('error', (err) => {
        if (res.headersSent) return;
        res.status(502).json({
            ok: false,
            proxyTarget: PROXY_TARGET,
            ms: Date.now() - t0,
            error: serializeError(err),
            hint: 'Fails only on Railway vs OK on laptop: datacenter IP / region / IPv6 route. Try another Railway region or confirm ChessPNT allows this egress.',
        });
    });
    preq.end();
});

/** Portal polls this so it does not scrape the iframe before deferred Puppeteer login finishes. */
app.get('/api/chesspnt-client-session', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
        puppeteerWanted,
        puppeteerLoginInFlight: puppeteerLoginInFlightFlag(),
        lastPuppeteerOkAt: healthState.lastPuppeteerOkAt,
        lastPuppeteerAttemptAt: healthState.lastPuppeteerAttemptAt,
        puppeteerLastFailure: healthState.puppeteerLastFailure,
        localStorage: sessionLocalStorage,
        cookieHeader: sessionCookies,
    });
});

app.get('/', (req, res) => {
    try {
        let html = fs.readFileSync(path.join(__dirname, 'public', 'portal.html'), 'utf8');
        const injection = `
            <script>
                window.INJECTED_LS = ${JSON.stringify(sessionLocalStorage)};
                window.INJECTED_COOKIES = ${JSON.stringify(sessionCookies)};
                window.WRAPPER_WAIT_FOR_PUPPETEER = ${JSON.stringify(puppeteerWanted)};
            </script>
        `;
        html = html.replace('</head>', injection + '</head>');
        res.send(html);
    } catch (e) {
        const detail = serializeError(e);
        res.status(500).type('text/plain; charset=utf-8').send(
            'Error loading portal\n\n' + JSON.stringify(detail, null, 2) + (e.stack ? '\n\n' + e.stack : '')
        );
    }
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

function recordProxyFailure(label, err, req, targetUrl) {
    const payload = {
        at: new Date().toISOString(),
        label,
        requestPath: req && req.url,
        target: targetUrl,
        error: serializeError(err),
    };
    if (label === 'chesspnt') healthState.proxyChesspntLastFailure = payload;
    else if (label === 'qwen') healthState.proxyQwenLastFailure = payload;
    else if (label === 'deepseek') healthState.proxyDeepseekLastFailure = payload;
    console.error(`[chesspnt-wrapper] Proxy error (${label}):\n` + JSON.stringify(payload, null, 2));
}

const proxyOptions = {
    target: PROXY_TARGET,
    changeOrigin: true,
    ws: true,
    xfwd: true,
    agent: chesspntOutboundAgent,
    proxyTimeout: PROXY_TIMEOUT_MS,
    timeout: PROXY_TIMEOUT_MS,
    onProxyReq: (proxyReq, req, res) => {
        if (sessionCookies) {
            proxyReq.setHeader('Cookie', sessionCookies);
        }
        proxyReq.setHeader('Origin', PROXY_TARGET);
        proxyReq.setHeader('Referer', `${PROXY_TARGET}/list/`);
    },
    onProxyRes: (proxyRes, req, res) => {
        delete proxyRes.headers['content-security-policy'];
        delete proxyRes.headers['x-frame-options'];
        if (puppeteerWanted && proxyRes.statusCode === 401) {
            schedulePuppeteerLogin('upstream-401');
        }
    },
    onError: (err, req, res, target) => {
        recordProxyFailure('chesspnt', err, req, String(target || PROXY_TARGET));
        if (res && typeof res.writeHead === 'function' && !res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
                JSON.stringify(
                    {
                        where: 'chesspnt reverse proxy',
                        target: PROXY_TARGET,
                        path: req && req.url,
                        error: serializeError(err),
                    },
                    null,
                    2
                )
            );
        }
    },
    cookieDomainRewrite: { '*': '' },
};

const QWEN_TARGET = 'https://chat.qwen.ai';
const qwenProxyOptions = {
    target: QWEN_TARGET,
    changeOrigin: true,
    ws: true,
    xfwd: true,
    agent: qwenOutboundAgent,
    proxyTimeout: PROXY_TIMEOUT_MS,
    timeout: PROXY_TIMEOUT_MS,
    onProxyReq: (proxyReq, req, res) => {
        if (qwenSession && qwenSession.cookies) {
            const cookieStr = qwenSession.cookies.map((c) => c.name + '=' + c.value).join('; ');
            proxyReq.setHeader('Cookie', cookieStr);
        }
        proxyReq.setHeader('Origin', 'https://chat.qwen.ai');
        proxyReq.setHeader('Referer', 'https://chat.qwen.ai/');
    },
    onProxyRes: (proxyRes, req, res) => {
        delete proxyRes.headers['content-security-policy'];
        delete proxyRes.headers['x-frame-options'];
    },
    onError: (err, req, res, target) => {
        recordProxyFailure('qwen', err, req, String(target || QWEN_TARGET));
        if (res && typeof res.writeHead === 'function' && !res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
                JSON.stringify(
                    {
                        where: 'qwen reverse proxy',
                        target: QWEN_TARGET,
                        path: req && req.url,
                        error: serializeError(err),
                    },
                    null,
                    2
                )
            );
        }
    },
    cookieDomainRewrite: { '*': '' },
};

const DEEPSEEK_TARGET = 'https://chat.deepseek.com';

/** Parse Cookie header values (best-effort) for merging server session + browser headers. */
function parseCookieHeaderToMap(cookieHeader) {
    const out = new Map();
    if (!cookieHeader || typeof cookieHeader !== 'string') return out;
    for (const part of cookieHeader.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const name = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (name) out.set(name, value);
    }
    return out;
}

function mergeCookieHeaderStrings(sessionCookieStr, incomingCookieHeader) {
    const m = parseCookieHeaderToMap(sessionCookieStr || '');
    for (const [k, v] of parseCookieHeaderToMap(incomingCookieHeader || '')) m.set(k, v);
    const parts = [];
    for (const [k, v] of m) parts.push(`${k}=${v}`);
    return parts.join('; ');
}

function deepseekSessionCookieHeader() {
    if (!deepseekSession || !deepseekSession.cookies) return '';
    return deepseekSession.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** Map https://our-host/deepseek/... → https://chat.deepseek.com/... for upstream Referer. */
function rewriteDeepseekRefererForUpstream(clientRefererRaw) {
    if (!clientRefererRaw || typeof clientRefererRaw !== 'string') return `${DEEPSEEK_TARGET}/`;
    try {
        const u = new URL(clientRefererRaw);
        const p = u.pathname || '/';
        if (p === '/deepseek' || p.startsWith('/deepseek/')) {
            let inner = p.slice('/deepseek'.length) || '/';
            if (!inner.startsWith('/')) inner = `/${inner}`;
            return `${DEEPSEEK_TARGET}${inner}${u.search || ''}`;
        }
    } catch (_) {}
    return `${DEEPSEEK_TARGET}/`;
}

/**
 * DeepSeek’s SPA calls same-origin paths like /api/... at the site root. Under /deepseek only the first
 * document load was proxied; API + assets then hit the ChessPNT proxy and Cloudflare saw broken sessions
 * (“Max challenge attempts exceeded”). Route those paths to DeepSeek when the tab’s Referer is /deepseek.
 */
function deepseekPathFilter(pathname, req) {
    if (pathname === '/deepseek' || pathname.startsWith('/deepseek/')) return true;
    const ref = String(req.headers.referer || req.headers.referrer || '');
    if (!ref.includes('/deepseek')) return false;
    return (
        pathname.startsWith('/api/') ||
        pathname.startsWith('/_next/') ||
        pathname.startsWith('/static/') ||
        pathname.startsWith('/images/') ||
        pathname.startsWith('/assets/') ||
        pathname.startsWith('/cdn/') ||
        pathname.startsWith('/locales/') ||
        pathname === '/favicon.ico' ||
        pathname.endsWith('/sw.js') ||
        pathname.includes('workbox')
    );
}

const deepseekProxyOptions = {
    target: DEEPSEEK_TARGET,
    changeOrigin: true,
    ws: true,
    xfwd: true,
    agent: deepseekOutboundAgent,
    proxyTimeout: PROXY_TIMEOUT_MS,
    timeout: PROXY_TIMEOUT_MS,
    pathFilter: deepseekPathFilter,
    pathRewrite: (path) => {
        const q = path.indexOf('?');
        const pathnameOnly = q === -1 ? path : path.slice(0, q);
        const search = q === -1 ? '' : path.slice(q);
        if (pathnameOnly === '/deepseek' || pathnameOnly.startsWith('/deepseek/')) {
            let inner = pathnameOnly.slice('/deepseek'.length) || '/';
            if (!inner.startsWith('/')) inner = `/${inner}`;
            return `${inner}${search}`;
        }
        return path;
    },
    onProxyReq: (proxyReq, req, res) => {
        const merged = mergeCookieHeaderStrings(deepseekSessionCookieHeader(), req.headers.cookie);
        if (merged) proxyReq.setHeader('Cookie', merged);
        const ua = req.headers['user-agent'];
        if (ua) proxyReq.setHeader('User-Agent', ua);
        const lang = req.headers['accept-language'];
        if (lang) proxyReq.setHeader('Accept-Language', lang);
        proxyReq.setHeader('Origin', DEEPSEEK_TARGET);
        const ref = req.headers.referer || req.headers.referrer;
        proxyReq.setHeader('Referer', rewriteDeepseekRefererForUpstream(ref));
    },
    onProxyRes: (proxyRes, req, res) => {
        delete proxyRes.headers['content-security-policy'];
        delete proxyRes.headers['x-frame-options'];
    },
    onError: (err, req, res, target) => {
        recordProxyFailure('deepseek', err, req, String(target || DEEPSEEK_TARGET));
        if (res && typeof res.writeHead === 'function' && !res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
                JSON.stringify(
                    {
                        where: 'deepseek reverse proxy',
                        target: DEEPSEEK_TARGET,
                        path: req && req.url,
                        error: serializeError(err),
                    },
                    null,
                    2
                )
            );
        }
    },
    cookieDomainRewrite: { '*': '' },
};

if (USE_DEEPSEEK_PROXY) {
    app.use(createProxyMiddleware(deepseekProxyOptions));
} else {
    app.use((req, res, next) => {
        const p = req.path || '';
        if (p !== '/deepseek' && !p.startsWith('/deepseek/')) return next();
        const inner = p === '/deepseek' || p === '/deepseek/' ? '/' : p.slice('/deepseek'.length) || '/';
        const pathPart = inner.startsWith('/') ? inner : `/${inner}`;
        const base = DEEPSEEK_TARGET.replace(/\/$/, '');
        const qi = req.url.indexOf('?');
        const qs = qi !== -1 ? req.url.slice(qi) : '';
        res.redirect(302, `${base}${pathPart}${qs}`);
    });
}

app.use('/qwen', createProxyMiddleware(qwenProxyOptions));
app.use('/', createProxyMiddleware(proxyOptions));

const PORT = Number(process.env.PORT) || 3000;
/** Railway and most PaaS require binding all interfaces; health checks need the port open immediately. */
const LISTEN_HOST = process.env.HOST || '0.0.0.0';

const server = app.listen(PORT, LISTEN_HOST, () => {
    console.log(`Team Proxy Server listening on http://${LISTEN_HOST}:${PORT}`);
    console.log('[chesspnt-wrapper] PROXY_TIMEOUT_MS (hardcoded)=', PROXY_TIMEOUT_MS);
    if (!USE_DEEPSEEK_PROXY) {
        console.log(
            '[chesspnt-wrapper] DeepSeek: /deepseek → redirect to chat.deepseek.com (set DEEPSEEK_USE_PROXY=1 to proxy; session cookies must match this server egress IP).'
        );
    }
    if (!process.env.PERSISTENT_STORAGE_DIR) {
        console.log('[chesspnt-wrapper] Tip: set PERSISTENT_STORAGE_DIR=/storage on Railway for persisted sessions.');
    }

    // Never block listen() on Puppeteer — Railway treats slow open port as deploy failure.
    if (puppeteerWanted) {
        schedulePuppeteerLogin('startup').then(() =>
            console.log('[chesspnt-wrapper] Puppeteer startup attempt finished (see logs or GET /health if it failed)')
        );
    }

    if (puppeteerWanted && PUPPETEER_REFRESH_MS > 0) {
        setInterval(() => {
            schedulePuppeteerLogin('interval');
        }, PUPPETEER_REFRESH_MS);
        console.log(
            '[chesspnt-wrapper] ChessPNT Puppeteer refresh every',
            Math.round(PUPPETEER_REFRESH_MS / 3600000),
            'h (CHESSPNT_PUPPETEER_REFRESH_MS)'
        );
    }
});

/** Node 18+ defaults requestTimeout to 5m; bump so client→Railway connections can outlive slow ChessPNT upstreams. */
server.requestTimeout = PROXY_TIMEOUT_MS + 120000;
server.headersTimeout = PROXY_TIMEOUT_MS + 180000;

server.on('error', (err) => {
    console.error('[chesspnt-wrapper] Server failed to start:\n' + JSON.stringify(serializeError(err), null, 2));
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
