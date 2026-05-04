const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
    const browser = await puppeteer.launch({ 
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    
    try {
        console.log('Navigating to Qwen Signin...');
        await page.goto('https://chat.qwen.ai/auth?action=signin', { waitUntil: 'networkidle2' });
        
        console.log('Filling credentials...');
        // Wait for email field
        await page.waitForSelector('input[type="email"], input[name="email"], #email', { timeout: 15000 });
        await page.type('input[type="email"], input[name="email"], #email', 'qwen01@eternalgy.com');
        
        // Sometimes there's a "Next" button
        const nextBtn = await page.$('button[type="submit"], .next-btn');
        if (nextBtn) {
            await nextBtn.click();
            await new Promise(r => setTimeout(r, 1000));
        }

        // Wait for password field
        await page.waitForSelector('input[type="password"], input[name="password"], #password', { timeout: 15000 });
        await page.type('input[type="password"], input[name="password"], #password', '@eternalgy2026');
        
        console.log('Submitting login...');
        await page.click('button[type="submit"]');

        // Wait for successful login (redirect to chat)
        console.log('Waiting for successful login...');
        await page.waitForFunction(() => window.location.href.includes('chat.qwen.ai') && !window.location.href.includes('auth'), { timeout: 60000 });

        console.log('Login successful! Extracting session...');
        const cookies = await page.cookies();
        const localStorage = await page.evaluate(() => JSON.stringify(localStorage));
        
        const sessionData = {
            cookies,
            localStorage: JSON.parse(localStorage)
        };
        
        fs.writeFileSync('qwen_session.json', JSON.stringify(sessionData, null, 2));
        console.log('Session saved to qwen_session.json');

    } catch (error) {
        console.error('Error during login:', error);
        await page.screenshot({ path: 'qwen_signin_error.png' });
    } finally {
        await browser.close();
    }
})();
