const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();

  await page.goto('https://www.linkedin.com/in/oshin-catherein-kujur-426534310/', { waitUntil: 'domcontentloaded' });

  await page.waitForSelector('a');

  const results = await page.$('a');

  console.log(results);

  await browser.close();
})();