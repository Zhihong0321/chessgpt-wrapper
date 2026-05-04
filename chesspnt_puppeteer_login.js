const path = require('path');
const puppeteer = require('puppeteer');

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

    const browser = await puppeteer.launch({
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
    });

    let page;
    try {
        page = await browser.newPage();
        page.setDefaultTimeout(stepTimeoutMs);
        page.setDefaultNavigationTimeout(stepTimeoutMs);

        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: stepTimeoutMs });
        await page.waitForSelector('#username', { visible: true, timeout: 60000 });
        await page.waitForSelector('#password', { visible: true, timeout: 60000 });

        await page.click('#username', { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type('#username', username, { delay: 12 });

        await page.click('#password', { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type('#password', password, { delay: 12 });

        const agree = await page.$('#agree-terms');
        if (agree) {
            const checked = await page.evaluate((el) => el.checked, agree);
            if (!checked) await agree.click();
        }

        await page.click('button[type="submit"]');

        try {
            await page.waitForFunction(
                () => Boolean(window.localStorage && window.localStorage.getItem('accessToken')),
                { timeout: stepTimeoutMs, polling: 500 }
            );
        } catch (waitErr) {
            const snippet = await page
                .evaluate(() => (document.body && document.body.innerText ? document.body.innerText.slice(0, 800) : ''))
                .catch(() => '');
            try {
                await page.screenshot({ path: path.join(dataDir, 'chesspnt_login_fail.png') });
            } catch (_) {}
            throw new Error(
                `accessToken not set after submit (${waitErr.message || waitErr}). Page text (truncated): ${snippet.replace(/\s+/g, ' ').slice(0, 400)}`
            );
        }

        await new Promise((r) => setTimeout(r, 1200));

        const cookies = await page.cookies();
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

        const localStorageObj = await page.evaluate(() => {
            const out = {};
            try {
                for (let i = 0; i < window.localStorage.length; i++) {
                    const k = window.localStorage.key(i);
                    if (k) out[k] = window.localStorage.getItem(k);
                }
            } catch (_) {}
            return out;
        });

        if (!cookieHeader || !localStorageObj.accessToken) {
            throw new Error('Login finished but session looks empty (no cookies or accessToken)');
        }

        return { cookieHeader, localStorageObj };
    } finally {
        try {
            await browser.close();
        } catch (_) {}
    }
}

module.exports = { loginChesspntSession };
