const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const nodemailer = require('nodemailer'); // 1. เพิ่ม Nodemailer

const app = express();

// --- Configuration ---
const RATE_PER_MINUTE = 1;
const MINIMUM_PRICE = 10;

// ดึง Stripe Secret Key จาก Environment Variable
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_your_stripe_secret_key');

// Config การส่ง Email (แนะนำให้ตั้งค่าผ่าน Environment Variables)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'your_email@gmail.com', // อีเมลผู้ส่ง
    pass: process.env.EMAIL_PASS || 'your_app_password'     // Gmail App Password
  }
});

// ข้อมูลสถานะตู้ในระบบ (เพิ่ม customerEmail)
const lockers = {
  1: { status: 'FREE', pin: null, startTime: null, paid: false, price: 0, customerEmail: null },
  2: { status: 'FREE', pin: null, startTime: null, paid: false, price: 0, customerEmail: null },
  3: { status: 'FREE', pin: null, startTime: null, paid: false, price: 0, customerEmail: null }
};

app.use(cors());

// ============================================================
// 1. STRIPE WEBHOOK ROUTE 
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

  // เมื่อชำระเงินสำเร็จผ่าน Stripe Checkout
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const lockerId = session.metadata.lockerId;
    const email = session.customer_details ? session.customer_details.email : null;

    if (lockers[lockerId]) {
      lockers[lockerId].paid = true;
      lockers[lockerId].customerEmail = email; // บันทึกอีเมลที่กรอกตอนจ่ายเงิน
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
// 3. API ENDPOINTS
// ============================================================

app.get('/', (req, res) => {
  res.send('Smart Locker Backend with Stripe Webhook is running!');
});

app.get('/api/lockers', (req, res) => {
  res.json({ success: true, lockers });
});

app.post('/api/deposit', (req, res) => {
  const { lockerId, pin } = req.body;

  if (!lockers[lockerId]) {
    return res.status(400).json({ success: false, message: 'Invalid locker ID' });
  }
  if (lockers[lockerId].status !== 'FREE') {
    return res.status(400).json({ success: false, message: 'Locker is currently in use' });
  }

  lockers[lockerId] = {
    status: 'BUSY',
    pin: pin,
    startTime: Date.now(),
    paid: false,
    price: 0,
    customerEmail: null
  };

  console.log(`[DEPOSIT] Locker ${lockerId} locked successfully with PIN: ${pin}`);
  res.json({ success: true, message: 'Deposit recorded successfully' });
});

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
      success_url: 'https://project32-6fek.onrender.com/success',
      cancel_url: 'https://project32-6fek.onrender.com/cancel',
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

// API ใหม่: ส่งรหัสผ่านสุ่ม OTP ไปที่อีเมลที่กรอกตอนชำระเงิน
app.post('/api/send-otp', async (req, res) => {
  const { lockerId } = req.body;
  const locker = lockers[lockerId];

  if (!locker) {
    return res.status(400).json({ success: false, message: 'Invalid locker ID' });
  }

  if (!locker.customerEmail) {
    return res.status(400).json({ success: false, message: 'No email found for this locker. Please complete payment first.' });
  }

  // สุ่มรหัส PIN ใหม่ 6 หลัก
  const newPin = Math.floor(100000 + Math.random() * 900000).toString();
  locker.pin = newPin; // อัปเดตรหัส PIN ในระบบทันที

  try {
    await transporter.sendMail({
      from: '"Smart Locker System" <no-reply@smartlocker.com>',
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
    console.error('[EMAIL ERROR]', error);
    res.status(500).json({ success: false, message: 'Failed to send email' });
  }
});

app.get('/check', (req, res) => {
  const lockerId = req.query.lockerId || 1;
  const locker = lockers[lockerId];

  if (locker && locker.paid) {
    lockers[lockerId] = { status: 'FREE', pin: null, startTime: null, paid: false, price: 0, customerEmail: null };
    console.log(`[UNLOCK] Locker ${lockerId} paid! Sending ON signal to ESP32.`);
    return res.json({ status: 'ON' });
  }

  res.json({ status: 'OFF' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SERVER] Smart Locker Backend running on port ${PORT}`);
});
