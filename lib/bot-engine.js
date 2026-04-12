const puppeteer = require('puppeteer');

async function runCommentBot(job) {
    const browser = await puppeteer.launch({ 
        headless: true, // ตั้งเป็น false ถ้าอยากดูบอททำงานสดๆ
        args: ['--no-sandbox'] 
    });
    const page = await browser.newPage();

    try {
        // 1. โหลดคุกกี้จาก Database มาใส่ในเบราว์เซอร์
        const cookies = JSON.parse(job.account.cookies);
        await page.setCookie(...cookies);

        // 2. ไปยังโพสต์เป้าหมาย
        await page.goto(job.targetUrl, { waitUntil: 'networkidle2' });

        // 3. หาช่องคอมเมนต์และพิมพ์ข้อความ (จุดนี้คุณแทนต้องจูน Selector ตามหน้าเว็บบ่อยๆ ครับ)
        await page.waitForSelector('div[role="textbox"]'); 
        await page.type('div[role="textbox"]', job.message);
        await page.keyboard.press('Enter');

        console.log(`✅ ยิงคอมเมนต์สำเร็จ: ${job.message}`);
        return true;
    } catch (error) {
        console.error("❌ บอททำงานพลาด:", error.message);
        return false;
    } finally {
        await browser.close();
    }
}

module.exports = { runCommentBot };