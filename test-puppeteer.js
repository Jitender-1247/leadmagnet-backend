const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { executablePath } = require('puppeteer');  // ← add this line
puppeteer.use(StealthPlugin());

(async () => {
    const browser = await puppeteer.launch({
        headless: false,
        executablePath: executablePath(),  // ← points to downloaded Chrome
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    console.log('Browser launched ✅');

    try {
        await page.goto('https://www.google.com', { 
            waitUntil: 'domcontentloaded',
            timeout: 60000 
        });
        console.log('Google loaded ✅');

        await page.goto('https://www.linkedin.com/login', { 
            waitUntil: 'domcontentloaded',
            timeout: 60000 
        });
        console.log('LinkedIn loaded ✅');
    } catch (err) {
        console.log('❌ Error:', err.message);
    }

    await browser.close();
})();