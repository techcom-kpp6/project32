const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const nodemailer = require('nodemailer'); 

const app = express();

// --- Configuration ---
const RATE_PER_MINUTE = 1;
const MINIMUM_PRICE = 10;
const SERVER_URL = process.env.SERVER_URL || 'https://project32-6fek.onrender.com';

// ดึง Stripe Secret Key จาก Environment Variable
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_your_stripe_secret_key');

// Config การส่ง Email ผ่าน Nodemailer (แก้ไขสำหรับ Render Cloud Server)
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false, // ใช้ TLS บนพอร์ต 587
  requireTLS: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  family: 4, // บังคับใช้ IPv4 เพื่อป้องกัน Connection Timeout บน Render
  connectionTimeout: 10000, // 10 วินาที
  greetingTimeout: 5000,
  socketTimeout: 10000
});

// ตรวจสอบสถานะการเชื่อมต่อ Mail Server เมื่อเปิดบริการ
transporter.verify((error, success) => {
  if (error) {
    console.error('[SMTP ERROR] ไม่สามารถเชื่อมต่อกับ Gmail SMTP:', error.message);
  } else {
    console.log('[SMTP SUCCESS] เชื่อมต่อกับ Gmail SMTP เรียบร้อยแล้ว');
  }
});

// ข้อมูลสถานะตู้ในระบบ
const lockers = {
  1: { status: 'FREE', pin: null, startTime: null, paid: false, price: 0, customerEmail: null },
  2: { status: 'FREE', pin: null, startTime: null, paid: false, price: 0, customerEmail: null },
  3: { status: 'FREE', pin: null, startTime: null, paid: false, price: 0, customerEmail: null }
};

app.use(cors());

// ============================================================
// 1. STRIPE WEBHOOK ROUTE (ต้องอยู่ก่อน express.json())
// ============================================================
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('[WEBHOOK ERROR] Webhook secret is not defined in environment variables!');
    return res.status(500).send('Webhook secret missing');
  }

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error(`[WEBHOOK ERROR] ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const lockerId = session.metadata.lockerId;
    const email = session.customer_details ? session.customer_details.email : null;

    if (lockers[lockerId]) {
      lockers[lockerId].paid = true;
      if (email) {
        lockers[lockerId].customerEmail = email;
      }
      console.log(`[PAYMENT SUCCESS] Locker ${lockerId} marked as PAID. Email: ${email}`);
    }
  }

  res.json({ received: true });
});

// ============================================================
// 2. GENERAL MIDDLEWARES
// ============================================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// 3. API & WEB FORM ENDPOINTS
// ============================================================

app.get('/', (req, res) => {
  res.send('Smart Locker Backend with Web Form & Stripe is running!');
});

app.get('/api/lockers', (req, res) => {
  res.json({ success: true, lockers });
});

// --- สร้างลิงก์หน้าเว็บฟอร์มสำหรับสแกน QR Code ---
app.post('/api/generate-deposit-qr', (req, res) => {
  const { lockerId } = req.body;

  if (!lockers[lockerId]) {
    return res.status(400).json({ success: false, message: 'Invalid locker ID' });
  }
  if (lockers[lockerId].status !== 'FREE') {
    return res.status(400).json({ success: false, message: 'Locker is currently in use' });
  }

  const formUrl = `${SERVER_URL}/form?lockerId=${lockerId}`;
  res.json({ success: true, formUrl: formUrl });
});

// --- หน้าเว็บฟอร์มสำหรับมือถือสแกนกรอก Email และ PIN ---
app.get('/form', (req, res) => {
  const lockerId = req.query.lockerId;
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Smart Locker Deposit</title>
      <style>
        body { font-family: sans-serif; background: #0f172a; color: #fff; padding: 20px; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .card { background: #1e293b; padding: 24px; border-radius: 12px; width: 100%; max-width: 320px; border: 1px solid #334155; box-sizing: border-box; }
        h2 { text-align: center; color: #38bdf8; margin-top: 0; }
        label { display: block; margin-bottom: 6px; font-size: 14px; color: #94a3b8; }
        input { width: 100%; padding: 12px; margin-bottom: 16px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #fff; box-sizing: border-box; font-size: 16px; }
        button { width: 100%; padding: 12px; background: #38bdf8; color: #0f172a; border: none; border-radius: 8px; font-weight: bold; font-size: 16px; cursor: pointer; }
        button:active { background: #0ea5e9; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>Locker #${lockerId}</h2>
        <form action="/submit-deposit" method="POST">
          <input type="hidden" name="lockerId" value="${lockerId}">
          <label>Email Address</label>
          <input type="email" name="email" required placeholder="name@gmail.com">
          <label>6-Digit PIN Code</label>
          <input type="password" name="pin" maxlength="6" pattern="\\d{6}" required placeholder="******">
          <button type="submit">CONFIRM DEPOSIT</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

// --- รับค่าจากเว็บฟอร์มมือถือ เปลี่ยนสถานะตู้เป็น BUSY และส่งอีเมลยืนยัน PIN ---
app.post('/submit-deposit', async (req, res) => {
  const { lockerId, email, pin } = req.body;

  if (!lockers[lockerId]) {
    return res.status(400).send('Invalid locker ID');
  }
  if (lockers[lockerId].status !== 'FREE') {
    return res.status(400).send('Locker is already in use');
  }

  lockers[lockerId] = {
    status: 'BUSY',
    pin: pin,
    startTime: Date.now(),
    paid: false, 
    price: 0,
    customerEmail: email
  };

  console.log(`[WEB DEPOSIT] Locker ${lockerId} locked via Mobile QR. Email: ${email}, PIN: ${pin}`);

  try {
    await transporter.sendMail({
      from: `"Smart Locker System" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `Deposit Confirmed - Locker #${lockerId}`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>Locker Deposit Successful</h2>
          <p>You have successfully stored your items in Locker <b>#${lockerId}</b>.</p>
          <p>Your 6-digit PIN code for retrieval is:</p>
          <h1 style="color: #2563eb; letter-spacing: 5px; font-size: 36px;">${pin}</h1>
          <p>Please keep this code safe. You will need it to retrieve your items.</p>
        </div>
      `
    });
    console.log(`[EMAIL SENT] Confirmation sent to ${email}`);
  } catch (error) {
    console.error('[EMAIL ERROR]', error.message);
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Success</title></head>
    <body style="background:#0f172a;color:#fff;text-align:center;padding-top:50px;font-family:sans-serif;">
      <h1 style="color:#22c55e;">Success!</h1>
      <p>Locker #${lockerId} has been locked securely.</p>
      <p>Check your email for your PIN code.</p>
      <p style="color:#94a3b8; font-size:14px; margin-top:30px;">You can close this window now.</p>
    </body>
    </html>
  `);
});

// --- API สำหรับตรวจสอบ PIN ตอนกดนำของออก และสร้าง Stripe Checkout Session ---
app.post('/api/retrieve', async (req, res) => {
  const { lockerId, pin } = req.body;
  const locker = lockers[lockerId];

  if (!locker || locker.status === 'FREE') {
    return res.status(400).json({ success: false, message: 'Locker is empty' });
  }

  if (locker.pin !== pin) {
    return res.status(401).json({ success: false, message: 'Incorrect PIN' });
  }

  const durationMs = Date.now() - locker.startTime;
  let minutes = Math.ceil(durationMs / 60000);
  if (minutes < 1) minutes = 1;

  let totalPrice = minutes * RATE_PER_MINUTE;
  if (totalPrice < MINIMUM_PRICE) {
    totalPrice = MINIMUM_PRICE;
  }
  locker.price = totalPrice;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'promptpay'],
      line_items: [{
        price_data: {
          currency: 'thb',
          product_data: {
            name: `Smart Locker #${lockerId} (${minutes} Mins)`,
          },
          unit_amount: totalPrice * 100,
        },
        quantity: 1,
      }],
      mode: 'payment',
      metadata: { lockerId: String(lockerId) },
      success_url: `${SERVER_URL}/success`,
      cancel_url: `${SERVER_URL}/cancel`,
    });

    console.log(`[RETRIEVE] Session created for Locker ${lockerId}: ${totalPrice} THB (${minutes} mins)`);

    res.json({
      success: true,
      minutes: minutes,
      amount: `${totalPrice}.00 THB`,
      stripeUrl: session.url
    });
  } catch (error) {
    console.error('[STRIPE ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Failed to create payment session' });
  }
});

// --- API สำหรับส่ง OTP / PIN ใหม่ไปยังอีเมล (กรณีลืมรหัสผ่าน) ---
app.post('/api/send-otp', async (req, res) => {
  const { lockerId } = req.body;
  const locker = lockers[lockerId];

  if (!locker) {
    return res.status(400).json({ success: false, message: 'Invalid locker ID' });
  }
  if (!locker.customerEmail) {
    return res.status(400).json({ success: false, message: 'No email found for this locker.' });
  }

  const newPin = Math.floor(100000 + Math.random() * 900000).toString();
  locker.pin = newPin;

  try {
    await transporter.sendMail({
      from: `"Smart Locker System" <${process.env.EMAIL_USER}>`,
      to: locker.customerEmail,
      subject: `Your New Unlock Code for Locker #${lockerId}`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>Smart Locker OTP Code</h2>
          <p>Your new 6-digit PIN code to unlock Locker <b>#${lockerId}</b> is:</p>
          <h1 style="color: #2563eb; letter-spacing: 5px; font-size: 36px;">${newPin}</h1>
          <p>Please enter this code on the locker screen to retrieve your items.</p>
        </div>
      `
    });

    console.log(`[OTP SENT] New PIN ${newPin} sent to ${locker.customerEmail} for Locker ${lockerId}`);
    res.json({ success: true, message: 'OTP email sent successfully' });
  } catch (error) {
    console.error('[EMAIL ERROR]', error.message);
    res.status(500).json({ success: false, message: 'Failed to send email' });
  }
});

// --- API เช็คสถานะการชำระเงินเพื่อสั่งปลดล็อกตู้ฝั่ง ESP32 ---
app.get('/check', (req, res) => {
  const lockerId = req.query.lockerId || 1;
  const locker = lockers[lockerId];

  if (locker && locker.paid) {
    lockers[lockerId] = { status: 'FREE', pin: null, startTime: null, paid: false, price: 0, customerEmail: null };
    console.log(`[UNLOCK] Locker ${lockerId} paid/completed! Sending ON signal to ESP32.`);
    return res.json({ status: 'ON' });
  }

  res.json({ status: 'OFF' });
});

// --- หน้าเว็บ Success หลังจ่ายเงินสำเร็จผ่าน Stripe ---
app.get('/success', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Payment Success</title></head>
    <body style="background:#0f172a;color:#fff;text-align:center;padding-top:50px;font-family:sans-serif;">
      <h1 style="color:#22c55e;">Payment Successful!</h1>
      <p>Your locker is now unlocking. Please retrieve your items.</p>
      <p style="color:#94a3b8; font-size:14px; margin-top:30px;">You can close this window now.</p>
    </body>
    </html>
  `);
});

// --- หน้าเว็บ Cancel หากผู้ใช้ยกเลิกการจ่ายเงินผ่าน Stripe ---
app.get('/cancel', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Payment Cancelled</title></head>
    <body style="background:#0f172a;color:#fff;text-align:center;padding-top:50px;font-family:sans-serif;">
      <h1 style="color:#ef4444;">Payment Cancelled</h1>
      <p>You have cancelled the payment process.</p>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SERVER] Smart Locker Backend running on port ${PORT}`);
});
