const path = require('path');
const puppeteer = require('puppeteer');

async function runStep(label, fn) {
    try {
        return await fn();
    } catch (e) {
        const msg = `${label}: ${e && e.message ? e.message : String(e)}`;
        const wrapped = new Error(msg, { cause: e });
        wrapped.step = label;
        throw wrapped;
    }
}

/**
 * Logs into ChessPNT (棋点) SPA and returns Cookie header string + localStorage snapshot.
 * Uses domcontentloaded (not networkidle2) — SPAs often never go idle on Railway.
 */
async function loginChesspntSession({ baseUrl, username, password, stepTimeoutMs = 120000 }) {
    if (!baseUrl || !username || !password) {
        throw new Error('loginChesspntSession requires baseUrl, username, and password');
    }

    const origin = baseUrl.replace(/\/$/, '');
    const loginUrl = `${origin}/list/#/login`;
    const dataDir = process.env.PERSISTENT_STORAGE_DIR
        ? path.resolve(String(process.env.PERSISTENT_STORAGE_DIR).trim())
        : __dirname;

    const execPath = (() => {
        const candidates = [
            process.env.PUPPETEER_EXECUTABLE_PATH,
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/snap/bin/chromium',
        ].filter(Boolean);
        for (const p of candidates) {
            try { if (require('fs').existsSync(p)) { console.log('[puppeteer] using chrome at', p); return p; } } catch (_) {}
        }
        // Fall back to puppeteer's own bundled path (Chrome for Testing cache)
        try {
            const p = typeof puppeteer.executablePath === 'function' ? puppeteer.executablePath() : null;
            if (p) { console.log('[puppeteer] using bundled chrome at', p); return p; }
        } catch (_) {}
        console.warn('[puppeteer] no chrome found in known paths — letting puppeteer auto-detect');
        return undefined;
    })();

    const browser = await runStep('puppeteer.launch', () =>
        puppeteer.launch({
            headless: true,
            executablePath: execPath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--no-first-run',
                '--window-size=1280,900',
            ],
        })
    );

    let page;
    try {
        page = await runStep('browser.newPage', () => browser.newPage());
        page.setDefaultTimeout(stepTimeoutMs);
        page.setDefaultNavigationTimeout(stepTimeoutMs);

        await runStep(`page.goto(${loginUrl})`, () =>
            page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: stepTimeoutMs })
        );

        await runStep('waitForSelector(#username)', () =>
            page.waitForSelector('#username', { visible: true, timeout: 60000 })
        );
        await runStep('waitForSelector(#password)', () =>
            page.waitForSelector('#password', { visible: true, timeout: 60000 })
        );

        await runStep('fill username', async () => {
            await page.click('#username', { clickCount: 3 });
            await page.keyboard.press('Backspace');
            await page.type('#username', username, { delay: 12 });
        });

        await runStep('fill password', async () => {
            await page.click('#password', { clickCount: 3 });
            await page.keyboard.press('Backspace');
            await page.type('#password', password, { delay: 12 });
        });

        await runStep('agree-terms', async () => {
            const agree = await page.$('#agree-terms');
            if (agree) {
                const checked = await page.evaluate((el) => el.checked, agree);
                if (!checked) await agree.click();
            }
        });

        // Snapshot the token BEFORE submit so we can detect when it genuinely changes
        const tokenBefore = await page.evaluate(() => {
            try { return window.localStorage && window.localStorage.getItem('accessToken'); } catch (_) { return null; }
        }).catch(() => null);

        await runStep('click submit', () => page.click('button[type="submit"]'));

        try {
            // Wait until accessToken is non-empty AND different from the pre-submit value
            await page.waitForFunction(
                (before) => {
                    try {
                        const t = window.localStorage && window.localStorage.getItem('accessToken');
                        return Boolean(t) && t !== before;
                    } catch (_) { return false; }
                },
                { timeout: stepTimeoutMs, polling: 500 },
                tokenBefore
            );
        } catch (waitErr) {
            const snippet = await page
                .evaluate(() => (document.body && document.body.innerText ? document.body.innerText.slice(0, 2000) : ''))
                .catch(() => '');
            const url = page.url();
            try {
                await page.screenshot({ path: path.join(dataDir, 'chesspnt_login_fail.png') });
            } catch (_) {
                /* screenshot optional */
            }
            const detail = new Error(
                `After submit, accessToken never changed in localStorage within ${stepTimeoutMs}ms. tokenBefore=${String(tokenBefore).slice(0, 40)} url=${url} waitError=${waitErr.message}. Page text (truncated): ${snippet.replace(/\s+/g, ' ').slice(0, 600)}`,
                { cause: waitErr }
            );
            detail.pageUrl = url;
            throw detail;
        }

        // Extra settle time for the SPA to finish writing all localStorage keys
        await new Promise((r) => setTimeout(r, 2000));

        const cookies = await runStep('page.cookies', () => page.cookies());
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

        const localStorageObj = await runStep('read localStorage', () =>
            page.evaluate(() => {
                const out = {};
                try {
                    for (let i = 0; i < window.localStorage.length; i++) {
                        const k = window.localStorage.key(i);
                        if (k) out[k] = window.localStorage.getItem(k);
                    }
                } catch (_) {}
                return out;
            })
        );

        if (!cookieHeader || !localStorageObj.accessToken) {
            const err = new Error(
                `Login appeared to complete but session is empty: cookieCount=${cookies.length} hasAccessToken=${Boolean(localStorageObj.accessToken)}`
            );
            err.cookieCount = cookies.length;
            err.localStorageKeys = Object.keys(localStorageObj || {});
            throw err;
        }

        // Decode JWT exp claim to confirm token is fresh
        try {
            const parts = localStorageObj.accessToken.split('.');
            if (parts.length === 3) {
                const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
                const expDate = payload.exp ? new Date(payload.exp * 1000).toISOString() : 'no exp';
                const nowMs = Date.now();
                const freshMs = payload.exp ? (payload.exp * 1000 - nowMs) : null;
                console.log(`[puppeteer] New token: uid=${payload.uid} uname=${payload.uname} exp=${expDate} (${freshMs !== null ? Math.round(freshMs / 60000) + 'min from now' : 'no exp'})`);
                if (freshMs !== null && freshMs < 0) {
                    throw new Error(`Token is already expired by ${Math.round(-freshMs / 60000)}min — login may have silently failed`);
                }
            }
        } catch (jwtErr) {
            if (jwtErr.message.includes('already expired')) throw jwtErr;
            console.warn('[puppeteer] Could not decode token JWT:', jwtErr.message);
        }

        return { cookieHeader, localStorageObj };
    } finally {
        try {
            await browser.close();
        } catch (closeErr) {
            console.error('[chesspnt_puppeteer_login] browser.close failed:', closeErr && closeErr.stack ? closeErr.stack : closeErr);
        }
    }
}

/**
 * Navigates to a CDK/token redemption site, enters the token, submits, and
 * returns the final URL after the site processes it.
 * Used for Perplexity (https://v.tuangouai.com/).
 */
async function redeemCdkSession({ url, token, stepTimeoutMs = 60000 }) {
    if (!url || !token) throw new Error('redeemCdkSession requires url and token');

    const execPath = (() => {
        const candidates = [
            process.env.PUPPETEER_EXECUTABLE_PATH,
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
        ].filter(Boolean);
        for (const p of candidates) {
            try { if (require('fs').existsSync(p)) return p; } catch (_) {}
        }
        try {
            const p = typeof puppeteer.executablePath === 'function' ? puppeteer.executablePath() : null;
            if (p) return p;
        } catch (_) {}
        return undefined;
    })();

    const browser = await runStep('puppeteer.launch', () =>
        puppeteer.launch({
            headless: true,
            executablePath: execPath,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run'],
        })
    );

    let page;
    try {
        page = await browser.newPage();
        page.setDefaultTimeout(stepTimeoutMs);
        page.setDefaultNavigationTimeout(stepTimeoutMs);

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: stepTimeoutMs });
        // Give the SPA time to hydrate
        await new Promise(r => setTimeout(r, 2500));

        // Find the CDK/token input — try common selector patterns
        const inputSelectors = [
            'input[placeholder*="CDK"]',
            'input[placeholder*="cdk"]',
            'input[placeholder*="激活码"]',
            'input[placeholder*="兑换码"]',
            'input[placeholder*="code"]',
            'input[placeholder*="Code"]',
            'input[placeholder*="token"]',
            'input[placeholder*="Token"]',
            'input[type="text"]',
            'input:not([type="hidden"])',
        ];

        let inputEl = null;
        for (const sel of inputSelectors) {
            inputEl = await page.$(sel);
            if (inputEl) { console.log(`[redeemCdk] found input via "${sel}"`); break; }
        }
        if (!inputEl) throw new Error('Could not find a text input on the CDK page');

        await inputEl.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        await inputEl.type(token, { delay: 15 });

        // Find and click the submit button
        const btnSelectors = [
            'button[type="submit"]',
            'button',
            'a.btn',
            '[class*="submit"]',
            '[class*="confirm"]',
            '[class*="redeem"]',
        ];
        let btnEl = null;
        for (const sel of btnSelectors) {
            const els = await page.$$(sel);
            if (els.length) { btnEl = els[els.length - 1]; console.log(`[redeemCdk] clicking button via "${sel}"`); break; }
        }
        if (!btnEl) throw new Error('Could not find a submit button on the CDK page');

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: stepTimeoutMs }).catch(() => {}),
            btnEl.click(),
        ]);

        // Extra wait for SPA transition
        await new Promise(r => setTimeout(r, 2000));

        const finalUrl = page.url();
        console.log(`[redeemCdk] final URL: ${finalUrl}`);
        return { url: finalUrl };

    } finally {
        try { await browser.close(); } catch (_) {}
    }
}

module.exports = { loginChesspntSession, redeemCdkSession };
