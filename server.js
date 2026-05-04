require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
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
        console.error('[chesspnt-wrapper] Invalid JSON file:', filePath, e.message);
    }
    return null;
}

/** Upstream SPA (no trailing slash). Override on Railway if your login host changes. */
const PROXY_TARGET = (process.env.CHESSPNT_PROXY_TARGET || 'https://chat.chesspnt.com').replace(/\/$/, '');

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
            console.error('CHESSPNT_INJECT_LS_JSON invalid JSON:', e.message);
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

let puppeteerLoginInFlight = null;

/** For GET /health — no secrets, only lengths and last Puppeteer outcome. */
const chesspntSessionMeta = {
    lastAttemptAt: null,
    lastAttemptReason: null,
    lastOkAt: null,
    lastError: null,
};

async function runChesspntPuppeteerLogin(reason) {
    if (!puppeteerWanted) return false;
    chesspntSessionMeta.lastAttemptAt = new Date().toISOString();
    chesspntSessionMeta.lastAttemptReason = String(reason || '');
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
    chesspntSessionMeta.lastOkAt = new Date().toISOString();
    chesspntSessionMeta.lastError = null;
    try {
        persistChesspntSessionToDisk();
        console.log('[chesspnt-wrapper] Session saved to', DATA_DIR);
    } catch (e) {
        console.warn('[chesspnt-wrapper] Could not persist session:', e.message);
    }
    return true;
}

function schedulePuppeteerLogin(reason) {
    if (!puppeteerWanted) return Promise.resolve();
    if (puppeteerLoginInFlight) return puppeteerLoginInFlight;
    puppeteerLoginInFlight = runChesspntPuppeteerLogin(reason)
        .catch((e) => {
            chesspntSessionMeta.lastError = String(e.message || e);
            console.error('[chesspnt-wrapper] Puppeteer login failed:', e.message || e);
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
    console.warn('[chesspnt-wrapper] Qwen session not found or invalid:', e.message);
}

app.get('/health', (req, res) => {
    const at = sessionLocalStorage && sessionLocalStorage.accessToken;
    res.json({
        ok: true,
        proxyTarget: PROXY_TARGET,
        dataDir: DATA_DIR,
        puppeteerWanted,
        cookieHeaderLength: sessionCookies ? sessionCookies.length : 0,
        hasAccessToken: typeof at === 'string' && at.length > 20,
        lastPuppeteerAttemptAt: chesspntSessionMeta.lastAttemptAt,
        lastPuppeteerAttemptReason: chesspntSessionMeta.lastAttemptReason,
        lastPuppeteerOkAt: chesspntSessionMeta.lastOkAt,
        lastPuppeteerError: chesspntSessionMeta.lastError,
    });
});

app.get('/', (req, res) => {
    try {
        let html = fs.readFileSync(path.join(__dirname, 'public', 'portal.html'), 'utf8');
        const injection = `
            <script>
                window.INJECTED_LS = ${JSON.stringify(sessionLocalStorage)};
                window.INJECTED_COOKIES = ${JSON.stringify(sessionCookies)};
            </script>
        `;
        html = html.replace('</head>', injection + '</head>');
        res.send(html);
    } catch (e) {
        res.status(500).send('Error loading portal: ' + e.message);
    }
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const proxyOptions = {
    target: PROXY_TARGET,
    changeOrigin: true,
    ws: true,
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
    cookieDomainRewrite: { '*': '' },
};

const qwenProxyOptions = {
    target: 'https://chat.qwen.ai',
    changeOrigin: true,
    ws: true,
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
    cookieDomainRewrite: { '*': '' },
};

app.use('/qwen', createProxyMiddleware(qwenProxyOptions));
app.use('/', createProxyMiddleware(proxyOptions));

const PORT = Number(process.env.PORT) || 3000;
/** Railway and most PaaS require binding all interfaces; health checks need the port open immediately. */
const LISTEN_HOST = process.env.HOST || '0.0.0.0';

const server = app.listen(PORT, LISTEN_HOST, () => {
    console.log(`Team Proxy Server listening on http://${LISTEN_HOST}:${PORT}`);
    if (!process.env.PERSISTENT_STORAGE_DIR) {
        console.log('[chesspnt-wrapper] Tip: set PERSISTENT_STORAGE_DIR=/storage on Railway for persisted sessions.');
    }

    // Never block listen() on Puppeteer — Railway treats slow open port as deploy failure.
    if (puppeteerWanted) {
        schedulePuppeteerLogin('startup')
            .then(() => console.log('[chesspnt-wrapper] Puppeteer startup login finished'))
            .catch(() => {});
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

server.on('error', (err) => {
    console.error('[chesspnt-wrapper] Server failed to start:', err);
    process.exit(1);
});
