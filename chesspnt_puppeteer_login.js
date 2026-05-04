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

    const bundled = typeof puppeteer.executablePath === 'function' ? puppeteer.executablePath() : undefined;
    const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || bundled || undefined;

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

        await runStep('click submit', () => page.click('button[type="submit"]'));

        try {
            await page.waitForFunction(
                () => Boolean(window.localStorage && window.localStorage.getItem('accessToken')),
                { timeout: stepTimeoutMs, polling: 500 }
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
                `After submit, accessToken never appeared in localStorage within ${stepTimeoutMs}ms. url=${url} waitError=${waitErr.message}. Page text (truncated): ${snippet.replace(/\s+/g, ' ').slice(0, 600)}`,
                { cause: waitErr }
            );
            detail.pageUrl = url;
            throw detail;
        }

        await new Promise((r) => setTimeout(r, 1200));

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

        return { cookieHeader, localStorageObj };
    } finally {
        try {
            await browser.close();
        } catch (closeErr) {
            console.error('[chesspnt_puppeteer_login] browser.close failed:', closeErr && closeErr.stack ? closeErr.stack : closeErr);
        }
    }
}

module.exports = { loginChesspntSession };
