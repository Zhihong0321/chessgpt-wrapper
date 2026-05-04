require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

/** Same pattern as login_qwen_v2.js; override with DEEPSEEK_LOGIN_EMAIL / DEEPSEEK_LOGIN_PASSWORD in .env */
const DEEPSEEK_EMAIL = (process.env.DEEPSEEK_LOGIN_EMAIL || 'claude01@eternalgy.com').trim();
const DEEPSEEK_PASSWORD = (process.env.DEEPSEEK_LOGIN_PASSWORD || '@eternalgy2026').trim();

(async () => {
    const browser = await puppeteer.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();

    try {
        console.log('Navigating to DeepSeek sign-in...');
        await page.goto('https://chat.deepseek.com/sign_in', {
            waitUntil: 'domcontentloaded',
            timeout: 90000,
        });

        console.log('Filling credentials...');
        const emailSelector =
            'input[type="email"], input[name="email"], input[autocomplete="username"], input[placeholder*="mail" i]';
        await page.waitForSelector(emailSelector, { timeout: 25000 });
        const emailEl = await page.$(emailSelector);
        if (!emailEl) throw new Error('DeepSeek email input not found');
        await emailEl.click({ clickCount: 3 });
        await emailEl.type(DEEPSEEK_EMAIL, { delay: 15 });

        const passwordSelector =
            'input[type="password"], input[name="password"], input[autocomplete="current-password"]';
        await page.waitForSelector(passwordSelector, { timeout: 15000 });
        const passEl = await page.$(passwordSelector);
        if (!passEl) throw new Error('DeepSeek password input not found');
        await passEl.click({ clickCount: 3 });
        await passEl.type(DEEPSEEK_PASSWORD, { delay: 15 });

        console.log('Submitting login...');
        const clicked = await page.evaluate(() => {
            const btn = document.querySelector('button[type="submit"]');
            if (btn) {
                btn.click();
                return true;
            }
            const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
            const login = candidates.find((b) => /^(log\s*in|sign\s*in|登录)$/i.test((b.textContent || '').trim()));
            if (login) {
                login.click();
                return true;
            }
            return false;
        });
        if (!clicked) await page.click('button[type="submit"]');

        console.log('Waiting for successful login...');
        await page.waitForFunction(
            () =>
                window.location.hostname === 'chat.deepseek.com' &&
                !window.location.pathname.includes('sign_in'),
            { timeout: 120000 }
        );

        console.log('Login successful! Extracting session...');
        const cookies = await page.cookies();
        const localStorage = await page.evaluate(() => JSON.stringify(localStorage));

        const sessionData = {
            cookies,
            localStorage: JSON.parse(localStorage),
        };

        const outDir = process.env.PERSISTENT_STORAGE_DIR
            ? path.resolve(process.env.PERSISTENT_STORAGE_DIR)
            : process.cwd();
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, 'deepseek_session.json');
        fs.writeFileSync(outPath, JSON.stringify(sessionData, null, 2));
        console.log('Session saved to', outPath);
    } catch (error) {
        console.error('Error during login:', error);
        await page.screenshot({ path: 'deepseek_signin_error.png' });
    } finally {
        await browser.close();
    }
})();
