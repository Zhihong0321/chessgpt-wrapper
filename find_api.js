const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    
    // Intercept responses to find the API endpoint
    page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('/api/') || url.includes('json') || url.includes('list')) {
            try {
                if (response.request().resourceType() === 'fetch' || response.request().resourceType() === 'xhr') {
                    const text = await response.text();
                    if (text.includes('Idle') || text.includes('cfaBc1VE') || text.includes('Sass')) {
                        console.log('FOUND API:', url);
                        require('fs').writeFileSync('api_response.json', text);
                        require('fs').writeFileSync('api_url.txt', url);
                    }
                }
            } catch (e) {}
        }
    });
    
    await page.goto('https://chat.chesspnt.com/list/#/login', { waitUntil: 'networkidle2' });
    await page.type('#username', 'claude01');
    await page.type('#password', '@eternalgy2026');
    await page.click('#agree-terms');
    await page.click('button[type="submit"]');
    
    await new Promise(r => setTimeout(r, 6000));
    await browser.close();
})();
