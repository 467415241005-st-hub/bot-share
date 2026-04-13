require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const { runCommentBot } = require('./lib/bot-engine');
const session = require('express-session');
const { PrismaSessionStore } = require('@quixo3/prisma-session-store');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const axios = require('axios');

const app = express();
const prisma = global.prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') {
    global.prisma = prisma;
}
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------
// 1. CONFIG & MIDDLEWARE
// ---------------------------------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1); // บังคับให้เชื่อถือ Proxy ของ Vercel (ป้องกัน Session หลุด)

// ⭐ เปลี่ยนที่เก็บ Session ไปไว้ในฐานข้อมูล (แก้ปัญหาเด้งไปหน้า Login)
app.use(session({
    secret: 'bot-share-master-secret-key',
    resave: false,
    saveUninitialized: false,
    store: new PrismaSessionStore(
        prisma,
        {
            checkPeriod: 2 * 60 * 1000,
            dbRecordIdIsSessionId: true,
            dbRecordIdFunction: undefined,
        }
    ),
    cookie: { 
        secure: process.env.NODE_ENV === 'production', 
        maxAge: 24 * 60 * 60 * 1000 
    }
}));

// โยนข้อมูล user ไปให้ทุกหน้า EJS
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

// ---------------------------------------------------
// 2. AUTH MIDDLEWARE
// ---------------------------------------------------
const isLogin = (req, res, next) => {
    if (req.session.userId) return next();
    res.redirect('/login');
};

const isAdmin = (req, res, next) => {
    // เช็กตัวพิมพ์เล็ก 'admin' ให้ตรงกับในฐานข้อมูล
    if (req.session.userId && req.session.role === 'admin') return next();
    res.status(403).send("เฉพาะแอดมินเท่านั้น!");
};

// ---------------------------------------------------
// 3. STORAGE CONFIG
// ---------------------------------------------------
const storage = multer.diskStorage({
    destination: './public/uploads/slips',
    filename: (req, file, cb) => {
        cb(null, 'slip-' + Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// ---------------------------------------------------
// 4. ROUTES & API
// ---------------------------------------------------

// หน้า Dashboard หลัก
app.get('/', isLogin, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
        const accounts = await prisma.botAccount.findMany({ where: { userId: req.session.userId } });
        res.render('index', { user, accounts, page: 'facebook' });
    } catch (error) {
        res.status(500).send("Error loading dashboard");
    }
});

// Login & Register
app.get('/login', (req, res) => res.render('login'));
app.get('/register', (req, res) => res.render('register'));

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await prisma.user.findUnique({ where: { username } });

    if (user && await bcrypt.compare(password, user.password)) {
        req.session.userId = user.id;
        req.session.role = user.role.toLowerCase(); // บังคับเป็นพิมพ์เล็กเพื่อความปลอดภัย
        req.session.user = {
            id: user.id,
            username: user.username,
            role: user.role.toLowerCase(),
            credits: user.credits || 0
        };
        res.redirect('/home');
    } else {
        res.status(401).send("ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง");
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// ⭐ NEW: API สำหรับให้ Vercel Cron มาสั่งรันบอท (แก้ปัญหาบอทไม่คอมเมนต์)
app.get('/api/cron/worker', async (req, res) => {
    const now = new Date();
    const pendingJobs = await prisma.jobQueue.findMany({
        where: { status: "PENDING", runAt: { lte: now } },
        include: { account: true }
    });

    for (const job of pendingJobs) {
        await prisma.jobQueue.update({ where: { id: job.id }, data: { status: "RUNNING" } });
        const success = await runCommentBot(job);
        await prisma.jobQueue.update({
            where: { id: job.id },
            data: { status: success ? "SUCCESS" : "FAILED" }
        });
    }
    res.json({ processed: pendingJobs.length });
});

// Admin Payments (ฉบับแก้ไขส่งค่า User)
app.get('/admin/payments', isAdmin, async (req, res) => {
    const pendingPayments = await prisma.payment.findMany({
        where: { status: 'PENDING' },
        include: { user: true }
    });
    res.render('admin_payments', { 
        payments: pendingPayments,
        user: req.session.user,
        page: 'admin_payments' 
    });
});

// --- อื่นๆ (เหมือนเดิม) ---
app.get('/home', isLogin, async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    res.render('home', { user, page: 'home' });
});

app.get('/add-bot', isLogin, async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    res.render('add_bot', { user, page: 'add-bot' });
});

// ... (Route อื่นๆ ของคุณแทนคงไว้ตามเดิมได้เลยครับ) ...

app.listen(PORT, () => {
    console.log(`✅ Server is running on http://localhost:${PORT}`);
});