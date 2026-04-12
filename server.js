require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const { runCommentBot } = require('./lib/bot-engine');
const session = require('express-session');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const axios = require('axios');

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------
// 1. CONFIG & MIDDLEWARE (ต้องวางก่อน ROUTES เสมอ)
// ---------------------------------------------------

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors());
app.use(express.static('public'));
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

// 🌟 จุดสำคัญ: ต้องวาง Session ไว้ตรงนี้เพื่อให้ทุก Route รู้จัก req.session
app.use(session({
    secret: 'bot-share-master-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false, 
        maxAge: 24 * 60 * 60 * 1000 
    }
}));

// ---------------------------------------------------
// 2. AUTH MIDDLEWARE
// ---------------------------------------------------

const isLogin = (req, res, next) => {
    if (req.session.userId) return next();
    res.redirect('/login');
};

const isAdmin = (req, res, next) => {
    if (req.session.userId && req.session.role === 'ADMIN') return next();
    res.status(403).send("เฉพาะแอดมินเท่านั้น!");
};

// ---------------------------------------------------
// 3. STORAGE CONFIG (MULTER)
// ---------------------------------------------------

const storage = multer.diskStorage({
    destination: './public/uploads/slips',
    filename: (req, file, cb) => {
        cb(null, 'slip-' + Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// ---------------------------------------------------
// 4. ROUTES (หน้าเว็บหลัก)
// ---------------------------------------------------

app.get('/', isLogin, async (req, res) => {
    try {
        // ดึงข้อมูล User เพื่อเอาค่าเครดิตมาโชว์ที่ Navbar
        const user = await prisma.user.findUnique({
            where: { id: req.session.userId }
        });
        // ดึงข้อมูลบอทเฟสบุ๊ก
        const accounts = await prisma.botAccount.findMany({
            where: { userId: req.session.userId }
        });

        res.render('index', {
            userId: req.session.userId,
            role: req.session.role,
            user: user, // <--- ต้องมีตัวนี้ Navbar ถึงจะโชว์เครดิตได้
            accounts: accounts, // 🌟 เติมคอมม่าตรงนี้ครับ!
            page: 'facebook'
        });
    } catch (error) {
        res.status(500).send("Error loading dashboard");
    }
});

// --- Register & Login ---
app.get('/register', (req, res) => res.render('register'));
app.get('/login', (req, res) => res.render('login'));

app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await prisma.user.create({
            data: { username, email, password: hashedPassword }
        });
        res.send("<script>alert('สมัครสมาชิกสำเร็จ!'); window.location='/login';</script>");
    } catch (err) {
        res.status(400).send("Username หรือ Email นี้ถูกใช้ไปแล้ว");
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await prisma.user.findUnique({ where: { username } });

    if (user && await bcrypt.compare(password, user.password)) {
        req.session.userId = user.id;
        req.session.role = user.role;
        res.redirect('/home');
    } else {
        res.status(401).send("ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง");
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// ---------------------------------------------------
// 5. API: BOT & JOBS
// ---------------------------------------------------

app.post('/api/accounts/add', isLogin, async (req, res) => {
    const { fbEmail, fbPassword, cookies } = req.body;
    try {
        await prisma.botAccount.create({
            data: {
                fbEmail: fbEmail,
                fbPassword: fbPassword,
                cookies: cookies,
                userId: req.session.userId // ใช้ ID จากคนที่ Login อยู่จริง ๆ
            }
        });
        res.redirect('/');
    } catch (error) {
        console.error(error);
        res.status(500).send("บันทึกข้อมูลไม่สำเร็จ");
    }
});

app.post('/api/jobs/add', isLogin, async (req, res) => {
    const { accountId, targetUrl, message, runAt } = req.body;
    try {
        await prisma.jobQueue.create({
            data: {
                accountId: parseInt(accountId),
                targetUrl: targetUrl,
                message: message,
                runAt: runAt ? new Date(runAt) : new Date(),
                status: "PENDING"
            }
        });
        res.redirect('/');
    } catch (error) {
        console.error(error);
        res.status(500).send("เพิ่มคิวงานไม่สำเร็จ");
    }
});

// ---------------------------------------------------
// 6. API: PAYMENTS & ADMIN
// ---------------------------------------------------

app.post('/api/payments/upload', isLogin, upload.single('slip'), async (req, res) => {
    const { amount } = req.body;
    if (!req.file) return res.status(400).send("กรุณาแนบรูปสลิป");
    try {
        await prisma.payment.create({
            data: {
                amount: parseFloat(amount),
                slipUrl: '/uploads/slips/' + req.file.filename,
                userId: req.session.userId
            }
        });
        res.send("<script>alert('ส่งสลิปเรียบร้อย!'); window.location='/';</script>");
    } catch (error) {
        res.status(500).send("เกิดข้อผิดพลาด");
    }
});

app.get('/admin/payments', isAdmin, async (req, res) => {
    const pendingPayments = await prisma.payment.findMany({
        where: { status: 'PENDING' },
        include: { user: true }
    });
    res.render('admin_payments', { payments: pendingPayments });
});

app.post('/api/admin/payments/approve', isAdmin, async (req, res) => {
    const { paymentId } = req.body;
    try {
        const payment = await prisma.payment.findUnique({ where: { id: parseInt(paymentId) } });
        await prisma.$transaction([
            prisma.payment.update({ where: { id: payment.id }, data: { status: 'APPROVED' } }),
            prisma.user.update({ where: { id: payment.userId }, data: { credits: { increment: payment.amount } } })
        ]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// ---------------------------------------------------
// 7. SYSTEM: WORKER SCHEDULER (30 วินาที)
// ---------------------------------------------------
setInterval(async () => {
    const now = new Date();
    const pendingJobs = await prisma.jobQueue.findMany({
        where: { status: "PENDING", runAt: { lte: now } },
        include: { account: true }
    });

    for (const job of pendingJobs) {
        console.log(`🚀 รันคิวงาน ID: ${job.id}`);
        await prisma.jobQueue.update({ where: { id: job.id }, data: { status: "RUNNING" } });
        const success = await runCommentBot(job);
        await prisma.jobQueue.update({
            where: { id: job.id },
            data: { status: success ? "SUCCESS" : "FAILED" }
        });
    }
}, 30000);

// ---------------------------------------------------
// 8. SEED & START SERVER
// ---------------------------------------------------
async function seedUser() {
    const userCount = await prisma.user.count();
    if (userCount === 0) {
        const hashedPassword = await bcrypt.hash("password123", 10);
        await prisma.user.create({
            data: {
                id: "1",
                username: "admin",
                email: "admin@botshare.com",
                password: hashedPassword, // แก้จากเดิมที่เซฟเป็น Text ตรงๆ
                role: "ADMIN"
            }
        });
        console.log("✅ Default Admin Created (User: admin / Pass: password123)");
    }
}
seedUser();

app.post('/api/packages/buy', isLogin, async (req, res) => {
    const { planName, price, fbLimit, lineLimit } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });

    if (user.credits < price) {
        return res.status(400).json({ error: "เครดิตไม่เพียงพอ กรุณาเติมเงิน" });
    }

    await prisma.user.update({
        where: { id: user.id },
        data: {
            credits: { decrement: price },
            plan: planName,
            fbLimit: fbLimit,
            lineLimit: lineLimit
        }
    });
    res.json({ success: true });
});

app.post('/api/admin/payments/approve', isAdmin, async (req, res) => {
    const { paymentId } = req.body;
    const payment = await prisma.payment.findUnique({ where: { id: parseInt(paymentId) } });

    await prisma.$transaction([
        prisma.payment.update({ where: { id: payment.id }, data: { status: 'APPROVED' } }),
        prisma.user.update({ 
            where: { id: payment.userId }, 
            data: { credits: { increment: payment.amount } } // 1 บาท = 1 เครดิต
        })
    ]);
    res.json({ success: true });
});

app.get('/line', isLogin, async (req, res) => {
    try {
        const lineAccounts = await prisma.lineAccount.findMany({
            where: { userId: req.session.userId }
        });
        const user = await prisma.user.findUnique({
            where: { id: req.session.userId }
        });

        res.render('line_dashboard', { 
            role: req.session.role,
            user: user,
            lineAccounts: lineAccounts,
            page: 'line'
        });
    } catch (error) {
        res.status(500).send("Error loading LINE Dashboard");
    }
});

// API สำหรับเพิ่มบัญชีไลน์
app.post('/api/line/add', isLogin, async (req, res) => {
    const { groupName, groupId, groupUrl } = req.body;
    try {
        await prisma.lineAccount.create({
            data: {
                groupName, // อย่าลืมเพิ่มฟิลด์นี้ใน Schema ด้วยนะคุณแทน
                groupId,
                groupUrl,
                userId: req.session.userId
            }
        });
        res.redirect('/line');
    } catch (error) {
        res.status(500).send("ไม่สามารถเพิ่มกลุ่มไลน์ได้");
    }
});

// --- หน้าแสดงแพ็คเกจ ---
app.get('/packages', isLogin, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
        res.render('packages', { 
            role: req.session.role,
            user: user,
            page: 'packages',
        });
    } catch (error) {
        res.status(500).send("Error loading packages");
    }
});

// --- หน้าเติมเครดิต ---
app.get('/topup', isLogin, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
        res.render('topup', { 
            role: req.session.role,
            user: user 
        });
    } catch (error) {
        res.status(500).send("Error loading topup page");
    }
});

// --- หน้าประวัติการเติมเครดิต ---
app.get('/history', isLogin, async (req, res) => {
    try {
        // 1. ดึงข้อมูล User (สำหรับ Navbar)
        const user = await prisma.user.findUnique({ where: { id: req.session.userId } });

        // 2. ดึงประวัติการเติมเงิน (เรียงจากล่าสุดขึ้นก่อน)
        const payments = await prisma.payment.findMany({
            where: { userId: req.session.userId },
            orderBy: { createdAt: 'desc' }
        });

        res.render('history', { 
            role: req.session.role,
            user: user,
            payments: payments 
        });
    } catch (error) {
        res.status(500).send("ไม่สามารถโหลดหน้าประวัติได้");
    }
});

// --- หน้าแรก (Landing Page หลัง Login) ---
app.get('/home', isLogin, async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    res.render('home', { 
        user: user, 
        role: req.session.role,
        page: 'home' 
    });
});

// --- หน้าคู่มือการใช้งาน ---
app.get('/guide', isLogin, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
        res.render('guide', { 
            user: user, 
            role: req.session.role,
            page: 'guide' 
        });
    } catch (error) {
        res.status(500).send("ไม่สามารถโหลดหน้าคู่มือได้");
    }
});

// --- ส่วนรับข้อมูลจาก LINE (Webhook) ---
app.post('/webhook', async (req, res) => {
    const events = req.body.events;
    
    // พิมพ์ค่าที่ได้รับลงใน Terminal เพื่อดูรหัสแบบไม่ง้อบอทตอบ
    console.log('--- มีข้อความเข้า ---');
    console.log(JSON.stringify(req.body, null, 2));

    for (let event of events) {
        if (event.type === 'message' && event.message.text === '/getid') {
            const id = event.source.groupId || event.source.userId;
            
            try {
                // ส่งคำตอบกลับไปหาผู้ใช้
                await axios.post('https://api.line.me/v2/bot/message/reply', {
                    replyToken: event.replyToken,
                    messages: [{ type: 'text', text: `รหัสของคุณคือ:\n${id}` }]
                }, {
                    headers: { 
                        'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
                        'Content-Type': 'application/json'
                    }
                });
            } catch (error) {
    if (error.response) {
        // มี Error ตอบกลับมาจาก Server ของ LINE
        console.error("LINE API Error:", error.response.data);
    } else {
        // เกิด Error ก่อนจะส่งถึง Server (เช่น พิมพ์ URL ผิด หรือไม่ได้ติดตั้ง axios)
        console.error("Request Error:", error.message);
    }
}
        }
    }
    res.sendStatus(200);
});

// --- API สำหรับส่งข้อความ LINE ทันที ---
app.post('/api/jobs/send-now', isLogin, async (req, res) => {
    const { accountId, message } = req.body;

    try {
        // 1. ดึงข้อมูลกลุ่มจากฐานข้อมูล
        const account = await prisma.lineAccount.findUnique({
            where: { id: parseInt(accountId) }
        });

        if (!account) return res.status(404).send("ไม่พบข้อมูลกลุ่ม");

        // 2. ยิงข้อความเข้า LINE API ตรงๆ ไม่ต้องลงตาราง JobQueue
        await axios.post('https://api.line.me/v2/bot/message/push', {
            to: account.groupId, // รหัส C... ที่เราได้มา
            messages: [{ type: 'text', text: message }]
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        // 3. (Optional) บันทึกประวัติการส่งลงตาราง History
        // ... โค้ดบันทึกประวัติ ...

        res.redirect('/line?status=success');
    } catch (error) {
        console.error("ส่งข้อความทันทีไม่สำเร็จ:", error.response?.data || error.message);
        res.status(500).send("เกิดข้อผิดพลาดในการส่งข้อความ");
    }
});

app.get('/add-bot', isLogin, (req, res) => {
    res.render('add_bot', {
        user: req.user // ส่งข้อมูล user ไปเผื่อใช้ใน navbar
    });
});

app.listen(PORT, () => {
    console.log(`✅ Bot Share Master is running on http://localhost:${PORT}`);
});