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
app.use(express.json());

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
    } catch (_) { }
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

function decodeJwtExp(token) {
    try {
        const parts = String(token).split('.');
        if (parts.length !== 3) return null;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return payload.exp ? payload.exp * 1000 : null;
    } catch (_) { return null; }
}

function getSessionToken() {
    // Prefer accessToken directly — it's what Puppeteer waits on and is most reliably fresh.
    // Fall back to user.token only if accessToken is absent.
    const at = sessionLocalStorage && sessionLocalStorage.accessToken;
    if (at && String(at).length > 40) return at;
    try {
        const u = typeof sessionLocalStorage.user === 'string'
            ? JSON.parse(sessionLocalStorage.user) : sessionLocalStorage.user;
        return u && u.token ? u.token : null;
    } catch (_) { return null; }
}

function tokenExpiresInMs() {
    const token = getSessionToken();
    if (!token) return -1;
    const exp = decodeJwtExp(token);
    if (exp === null) return Infinity;
    return exp - Date.now();
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

    // Verify the new token is actually valid before accepting it
    const newToken = localStorageObj.accessToken;
    const expMs = newToken ? decodeJwtExp(newToken) : null;
    if (expMs !== null && expMs < Date.now()) {
        throw new Error(`Puppeteer login returned an already-expired token (exp=${new Date(expMs).toISOString()}). Login may have silently failed — check credentials or CAPTCHA.`);
    }
    if (expMs) {
        console.log(`[chesspnt-wrapper] New token valid until ${new Date(expMs).toISOString()} (${Math.round((expMs - Date.now()) / 60000)}min from now)`);
    }

    // Do a live test call to confirm ChessPNT actually accepts the new token
    try {
        const testRes = await fetch(`${PROXY_TARGET.replace(/\/$/, '')}/client-api/sass/logintoken`, {
            headers: {
                'Authorization': `Bearer ${newToken}`,
                'Cookie': cookieHeader || '',
                'Origin': PROXY_TARGET,
                'Referer': `${PROXY_TARGET}/list/`,
                'User-Agent': 'Mozilla/5.0 (compatible; chesspnt-wrapper/1.0)',
            },
        });
        const testBody = await testRes.text();
        const testJson = (() => { try { return JSON.parse(testBody); } catch (_) { return null; } })();
        if (testJson && testJson.code === 401) {
            throw new Error(`Post-login verification failed: ChessPNT still returns 401 after fresh login. Body: ${testBody.slice(0, 200)}`);
        }
        console.log(`[chesspnt-wrapper] Post-login token verified OK (sass/logintoken status=${testRes.status})`);
    } catch (verifyErr) {
        if (verifyErr.message.includes('Post-login verification failed')) throw verifyErr;
        console.warn('[chesspnt-wrapper] Post-login verify request failed (network?):', verifyErr.message);
    }

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



function puppeteerLoginInFlightFlag() {
    return Boolean(puppeteerLoginInFlight);
}

app.get('/health', (req, res) => {
    try {
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
            dnsIpv4First: dnsIpv4FirstApplied,
            probeChesspntOutbound: '/api/probe-chesspnt-outbound',
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'health serialization failed', detail: String(e.message) });
    }
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

/**
 * GET /api/cards
 * Fetches the real card list from ChessPNT card APIs (sass/gemini/grok/claude/openai).
 * Returns { sass: [...], gemini: [...], grok: [...], claude: [...], plus: [...] }
 * Each card has: { carID, title (username), status, isPlus, badge, nodeType }
 */
app.get('/api/cards', async (req, res) => {
    res.set('Cache-Control', 'no-store');

    const userToken = (() => {
        try {
            const u = typeof sessionLocalStorage.user === 'string'
                ? JSON.parse(sessionLocalStorage.user)
                : sessionLocalStorage.user;
            return u && u.token ? u.token : sessionLocalStorage.accessToken;
        } catch (_) { return sessionLocalStorage.accessToken; }
    })();

    if (!userToken) {
        return res.status(503).json({ ok: false, error: 'No accessToken in server session.' });
    }

    const baseUrl = PROXY_TARGET.replace(/\/$/, '');
    const headers = {
        'Content-Type': 'application/json',
        'Cookie': sessionCookies || '',
        'Origin': baseUrl,
        'Referer': `${baseUrl}/list/`,
        'User-Agent': 'Mozilla/5.0 (compatible; chesspnt-wrapper/1.0)',
    };
    if (userToken) headers['Authorization'] = `Bearer ${userToken}`;

    async function fetchCards(clientPath, nodeType, badgeLabel) {
        try {
            const r = await fetch(`${baseUrl}/client-api${clientPath}`, { headers, redirect: 'follow' });
            if (!r.ok) { console.warn(`[chesspnt-wrapper] GET /client-api${clientPath} -> ${r.status}`); return []; }
            const json = await r.json();
            // Response: { code: 200, msg: '\u8bf7\u6c42\u6210\u529f', data: [...] }
            const list = Array.isArray(json) ? json
                : (json && Array.isArray(json.data)) ? json.data
                    : (json && Array.isArray(json.rows)) ? json.rows
                        : [];
            return list.map(c => ({
                carID: c.carID || c.id || String(c.carId || ''),
                title: c.carID || c.username || c.name || 'Instance',
                // Chinese: \u7a7a\u95f2 = Idle, \u7e41\u5fd9 = Busy
                status: (c.status === '\u7e41\u5fd9' || c.status === 'busy' || c.status === 'Busy' || c.status === 1) ? 'Busy' : 'Idle',
                isPlus: c.isPlus || 0,
                badge: badgeLabel,
                nodeType,
            })).filter(c => c.carID);
        } catch (e) {
            console.warn(`[chesspnt-wrapper] fetchCards /client-api${clientPath} error:`, e.message);
            return [];
        }
    }

    try {
        const [sass, gemini, grok, claude, plus] = await Promise.all([
            fetchCards('/sass/carpage', 'sass', 'Sass'),
            fetchCards('/gemini/carpage', 'gemini', 'Gemini'),
            fetchCards('/grok/carpage', 'grok', 'Grok'),
            fetchCards('/claude/carpage', 'claude', 'Claude'),
            fetchCards('/openai/carpage', 'plus', 'Plus'),
        ]);
        res.json({ ok: true, sass, gemini, grok, claude, plus });
    } catch (e) {
        res.status(502).json({ ok: false, error: e.message });
    }
});

/**
 * POST /api/connect-session
 * Body: { carID: string, nodeType: string, planType: number }
 *
 * Per-nodeType auth flows (reverse-engineered from CarList-Bf02bWLT.js):
 *   sass   -> GET /client-api/sass/logintoken        -> path suffix -> gpt.chesspnt.com + suffix
 *   grok   -> GET /client-api/grok/loginToken        -> path suffix -> grok.chesspnt.com + suffix
 *   gemini -> GET /client-api/gemini/loginToken?...  -> path suffix -> gemini.chesspnt.com + suffix
 *   claude -> GET /client-api/claude/auth?...        -> URL/path    -> via sxClaudeUrl or claudeUrl
 *   plus        -> POST /client-api/openai/auth -> POST /auth/login -> /list/#/home
 *   perplexity  -> Puppeteer navigates to directUrl, enters directToken, returns final URL
 */
app.post('/api/connect-session', express.json(), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { carID, nodeType, planType, directUrl, directToken } = req.body || {};
    if (!carID || !nodeType) {
        return res.status(400).json({ ok: false, error: 'Missing carID or nodeType.' });
    }

    const userToken = getSessionToken();
    const username = (() => {
        try {
            const u = typeof sessionLocalStorage.user === 'string'
                ? JSON.parse(sessionLocalStorage.user) : sessionLocalStorage.user;
            return u && u.username ? u.username : '';
        } catch (_) { return ''; }
    })();

    if (!userToken && nodeType !== 'perplexity') return res.status(503).json({ ok: false, error: 'No session token yet.' });

    if (userToken && nodeType !== 'perplexity') {
        const remainingMs = tokenExpiresInMs();
        if (remainingMs < 0) {
            console.log(`[connect-session] Token is expired by ${Math.round(-remainingMs / 60000)}min — triggering re-login`);
            schedulePuppeteerLogin('connect-session-expired-token');
            return res.status(503).json({ ok: false, error: 'Session token expired, re-login in progress. Retry in ~60s.' });
        }
        if (remainingMs < 5 * 60 * 1000) {
            console.log(`[connect-session] Token expires in ${Math.round(remainingMs / 60000)}min — triggering proactive refresh`);
            schedulePuppeteerLogin('connect-session-near-expiry');
        }
    }

    const siteConfig = (() => {
        try { return JSON.parse(sessionLocalStorage.site || '{}'); } catch (_) { return {}; }
    })();

    const baseUrl = PROXY_TARGET.replace(/\/$/, '');
    const hdrs = {
        'Content-Type': 'application/json',
        'Cookie': sessionCookies || '',
        'Origin': baseUrl,
        'Referer': `${baseUrl}/list/`,
        'User-Agent': 'Mozilla/5.0 (compatible; chesspnt-wrapper/1.0)',
        'Authorization': `Bearer ${userToken}`,
    };

    async function apiGet(path) {
        const r = await fetch(`${baseUrl}/client-api${path}`, { headers: hdrs, redirect: 'follow' });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        // Trigger Puppeteer re-login if ChessPNT says token is expired
        if (json && json.code === 401) schedulePuppeteerLogin('connect-session-401');
        return { status: r.status, json, text };
    }
    async function apiPost(path, body) {
        const r = await fetch(`${baseUrl}/client-api${path}`, {
            method: 'POST', headers: hdrs, body: JSON.stringify(body), redirect: 'follow',
        });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        if (json && json.code === 401) schedulePuppeteerLogin('connect-session-401');
        return { status: r.status, json, text };
    }
    function extractData(result) {
        if (!result.json) return null;
        if (typeof result.json === 'string') return result.json;
        if (result.json.data && typeof result.json.data === 'string') return result.json.data;
        return null;
    }
    function noUrlError(label, r, suffix) {
        const detail = `status=${r.status} body=${r.text.slice(0, 300)} parsed_suffix="${suffix}"`;
        console.error(`[connect-session] ✗ ${label} — no URL in response. ${detail}`);
        return res.status(502).json({ ok: false, error: `${label}: backend returned no session URL`, detail: r.text.slice(0, 300) });
    }

    console.log(`[connect-session] → carID=${carID} nodeType=${nodeType} planType=${planType}`);

    try {
        let sessionUrl = null;

        if (nodeType === 'sass') {
            const r = await apiGet('/sass/logintoken');
            const suffix = extractData(r) || r.text.trim();
            console.log(`[connect-session] sass logintoken: status=${r.status} body=${r.text.slice(0, 300)}`);
            if (suffix && (suffix.startsWith('/') || suffix.startsWith('http'))) {
                const base = (siteConfig.soruxGptSideBarUrl || 'https://gpt.chesspnt.com').replace(/\/$/, '');
                sessionUrl = suffix.startsWith('http') ? suffix : base + suffix;
            } else {
                return noUrlError('sass /logintoken', r, suffix);
            }

        } else if (nodeType === 'grok') {
            const isSuper = (planType || 0) >= 3 ? 'true' : 'false';
            const r = await apiGet(`/grok/loginToken?isSuper=${isSuper}`);
            const suffix = extractData(r) || r.text.trim();
            console.log(`[connect-session] grok loginToken: status=${r.status} body=${r.text.slice(0, 300)}`);
            if (suffix && (suffix.startsWith('/') || suffix.startsWith('http'))) {
                const base = (siteConfig.grokUrl || 'https://grok.chesspnt.com').replace(/\/$/, '');
                sessionUrl = suffix.startsWith('http') ? suffix : base + suffix;
            } else {
                return noUrlError('grok /loginToken', r, suffix);
            }

        } else if (nodeType === 'gemini') {
            const params = new URLSearchParams({ usertoken: username, carid: carID, isPlus: planType || 0 });
            const r = await apiGet(`/gemini/loginToken?${params}`);
            const suffix = extractData(r) || r.text.trim();
            console.log(`[connect-session] gemini loginToken: status=${r.status} body=${r.text.slice(0, 300)}`);
            if (suffix && (suffix.startsWith('/') || suffix.startsWith('http'))) {
                const base = (siteConfig.geminiUrl || 'https://gemini.chesspnt.com').replace(/\/$/, '');
                sessionUrl = suffix.startsWith('http') ? suffix : base + suffix;
            } else {
                return noUrlError('gemini /loginToken', r, suffix);
            }

        } else if (nodeType === 'claude') {
            const params = new URLSearchParams({ usertoken: username, carid: carID, isPlus: planType || 0 });
            const r = await apiGet(`/claude/auth?${params}`);
            const data = extractData(r) || r.text.trim();
            console.log(`[connect-session] claude auth: status=${r.status} body=${r.text.slice(0, 300)}`);
            if (data && (data.startsWith('/') || data.startsWith('http'))) {
                const claudeBase = (siteConfig.sxClaudeUrl || siteConfig.claudeUrl || 'https://claude.chesspnt.com').replace(/\/$/, '');
                sessionUrl = data.startsWith('http') ? data : claudeBase + data;
            } else {
                return noUrlError('claude /auth', r, data);
            }

        } else if (nodeType === 'perplexity') {
            const cdkUrl   = directUrl   || 'https://v.tuangouai.com/#/';
            const cdkToken = directToken || '';
            if (!cdkToken) return res.status(400).json({ ok: false, error: 'Missing token for perplexity.' });
            console.log(`[connect-session] perplexity: launching puppeteer → ${cdkUrl}`);
            const { redeemCdkSession } = require('./chesspnt_puppeteer_login');
            const result = await redeemCdkSession({ url: cdkUrl, token: cdkToken });
            sessionUrl = result.url;

        } else {
            // plus / claudeSaas / embedded
            const authR = await apiPost('/openai/auth', { usertoken: userToken, nodeType, carid: carID, planType: planType || 0 });
            console.log(`[connect-session] openai auth: status=${authR.status} body=${authR.text.slice(0, 300)}`);
            const activeCarID = extractData(authR) || carID;
            const loginR = await fetch(`${baseUrl}/auth/login?carid=${encodeURIComponent(activeCarID)}`, {
                method: 'POST',
                headers: hdrs,
                body: JSON.stringify({ usertoken: userToken, nodeType, carid: activeCarID, planType: planType || 0 }),
                redirect: 'manual',
            });
            const loginBody = await loginR.text().catch(() => '');
            console.log(`[connect-session] auth/login: status=${loginR.status} body=${loginBody.slice(0, 300)}`);
            if (loginR.status >= 200 && loginR.status < 400) {
                sessionUrl = '/list/#/home';
            } else {
                return res.status(502).json({ ok: false, error: `auth/login returned ${loginR.status}`, detail: loginBody.slice(0, 300) });
            }
        }

        if (sessionUrl) {
            console.log(`[connect-session] ✓ OK nodeType=${nodeType} url=${sessionUrl}`);
            return res.json({ ok: true, url: sessionUrl, nodeType });
        }
        return res.status(502).json({ ok: false, error: `No session URL for nodeType=${nodeType}` });

    } catch (err) {
        console.error(`[connect-session] ✗ exception: ${err.message}`);
        return res.status(502).json({ ok: false, error: err.message });
    }
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



app.use('/qwen', createProxyMiddleware(qwenProxyOptions));
app.use('/', createProxyMiddleware(proxyOptions));

const PORT = Number(process.env.PORT) || 3000;
/** Railway and most PaaS require binding all interfaces; health checks need the port open immediately. */
const LISTEN_HOST = process.env.HOST || '0.0.0.0';

const server = app.listen(PORT, LISTEN_HOST, () => {
    console.log(`Team Proxy Server listening on http://${LISTEN_HOST}:${PORT}`);
    console.log('[chesspnt-wrapper] PROXY_TIMEOUT_MS (hardcoded)=', PROXY_TIMEOUT_MS);
    if (!process.env.PERSISTENT_STORAGE_DIR) {
        console.log('[chesspnt-wrapper] Tip: set PERSISTENT_STORAGE_DIR=/storage on Railway for persisted sessions.');
    }

    // Never block listen() on Puppeteer — Railway treats slow open port as deploy failure.
    if (puppeteerWanted) {
        schedulePuppeteerLogin('startup').then(() =>
            console.log('[chesspnt-wrapper] Puppeteer startup attempt finished (see logs or GET /health if it failed)')
        );
    }

    if (puppeteerWanted) {
        // Check token expiry every 15 min; re-login when < 30 min remaining
        const TOKEN_REFRESH_BUFFER_MS = 30 * 60 * 1000;
        const CHECK_INTERVAL_MS = 15 * 60 * 1000;
        setInterval(() => {
            const remaining = tokenExpiresInMs();
            if (remaining < TOKEN_REFRESH_BUFFER_MS) {
                console.log(`[chesspnt-wrapper] Token expires in ${Math.round(remaining / 60000)}min — refreshing proactively`);
                schedulePuppeteerLogin('proactive-expiry');
            }
        }, CHECK_INTERVAL_MS);
        console.log('[chesspnt-wrapper] Smart token refresh: checks every 15min, refreshes when <30min remaining');
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
