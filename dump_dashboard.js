const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
    console.log("Launching Puppeteer...");
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    
    console.log("Navigating to login page...");
    await page.goto('https://chat.chesspnt.com/list/#/login', { waitUntil: 'networkidle2' });
    
    console.log("Logging in...");
    await page.type('#username', 'claude01');
    await page.type('#password', '@eternalgy2026');
    await page.click('#agree-terms');
    await page.click('button[type="submit"]');
    
    console.log("Waiting for dashboard to load...");
    await new Promise(r => setTimeout(r, 10000));
    
    const textContent = await page.evaluate(() => document.body.innerText);
    fs.writeFileSync('dashboard_text.txt', textContent);
    
    const html = await page.content();
    fs.writeFileSync('dashboard.html', html);
    console.log("Saved dashboard HTML and Text");
    
    await browser.close();
})();
