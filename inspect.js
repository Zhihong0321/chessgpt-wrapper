const puppeteer = require('puppeteer');

(async () => {
    console.log("Launching Puppeteer...");
    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();
    
    console.log("Navigating to login page...");
    // Assuming the login page is here, or we go to /list/#/home and it redirects
    await page.goto('https://chat.chesspnt.com/list/#/login', { waitUntil: 'networkidle2' });
    
    // We don't know the exact selectors for username/password, let's dump the HTML or find inputs
    const html = await page.content();
    require('fs').writeFileSync('login_page.html', html);
    console.log("Saved login page HTML to login_page.html");
    
    await browser.close();
})();
