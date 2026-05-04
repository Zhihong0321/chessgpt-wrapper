const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

(async () => {
    const browser = await puppeteer.launch({ 
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    
    try {
        console.log('Navigating to Qwen...');
        await page.goto('https://tongyi.aliyun.com/', { waitUntil: 'networkidle2' });
        
        // Wait for login button and click
        // Note: Selectors might need adjustment
        console.log('Waiting for login button...');
        await page.waitForSelector('.login-btn, [class*="login"], .header-login', { timeout: 10000 }).catch(e => console.log('Login button not found via simple selectors, trying manual click...'));
        
        // Sometimes it's better to just wait for user to login if there are captchas
        // But the user wants ME to do it.
        
        // Let's try to find the login button by text
        const loginBtn = await page.evaluateHandle(() => {
            const elements = Array.from(document.querySelectorAll('div, span, a, button'));
            return elements.find(el => el.textContent.includes('登录') || el.textContent.includes('Login'));
        });
        
        if (loginBtn) {
            await loginBtn.click();
            console.log('Clicked login button.');
        }

        // Wait for login page to load
        await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
        
        // Fill in credentials if possible
        // This part is tricky because Alibaba login has many variations (QR, password, etc.)
        // We'll try to find the email/password fields
        
        console.log('Filling credentials...');
        // Common Alibaba/Qwen login selectors
        await page.waitForSelector('#fm-login-id', { timeout: 5000 }).then(async () => {
            await page.type('#fm-login-id', 'qwen01@eternalgy.com');
            await page.type('#fm-login-password', '@eternalgy2026');
            await page.click('.password-login'); // submit button
        }).catch(() => console.log('Standard login fields not found.'));

        // Wait for successful login (redirect back to tongyi.aliyun.com)
        console.log('Waiting for successful login...');
        await page.waitForFunction(() => window.location.href.includes('tongyi.aliyun.com') && !window.location.href.includes('login'), { timeout: 60000 });

        console.log('Login successful! Extracting session...');
        const cookies = await page.cookies();
        const localStorage = await page.evaluate(() => JSON.stringify(localStorage));
        
        const sessionData = {
            cookies,
            localStorage: JSON.parse(localStorage)
        };
        
        const outDir = process.env.PERSISTENT_STORAGE_DIR
            ? path.resolve(process.env.PERSISTENT_STORAGE_DIR)
            : process.cwd();
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, 'qwen_session.json');
        fs.writeFileSync(outPath, JSON.stringify(sessionData, null, 2));
        console.log('Session saved to', outPath);

    } catch (error) {
        console.error('Error during login:', error);
        // Take screenshot for debugging
        await page.screenshot({ path: 'qwen_error.png' });
    } finally {
        await browser.close();
    }
})();
