const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

const app = express();

// --- Configuration ---
const RATE_PER_MINUTE = 1;
const MINIMUM_PRICE = 10;

// ดึง Stripe Secret Key จาก Environment Variable
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_your_stripe_secret_key');

// ข้อมูลสถานะตู้ในระบบ (In-Memory Data)
const lockers = {
  1: { status: 'FREE', pin: null, startTime: null, paid: false, price: 0 },
  2: { status: 'FREE', pin: null, startTime: null, paid: false, price: 0 },
  3: { status: 'FREE', pin: null, startTime: null, paid: false, price: 0 }
};

app.use(cors());

// ============================================================
// 1. STRIPE WEBHOOK ROUTE 
// *** ต้องวางไว้ก่อน express.json() และใช้ express.raw() เท่านั้น ***
// ============================================================
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  // อ่านค่า Signing Secret (รองรับทั้งชื่อ STRIPE_WEBHOOK_SECRET และ WEBHOOK_SECRET)
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('[WEBHOOK ERROR] Webhook secret is not defined in environment variables!');
    return res.status(500).send('Webhook secret missing');
  }

  try {
    // ยืนยันข้อมูลดิบ (Raw Buffer) ร่วมกับ Signature จาก Stripe
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error(`[WEBHOOK ERROR] ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // เมื่อชำระเงินสำเร็จผ่าน Stripe Checkout
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const lockerId = session.metadata.lockerId;

    if (lockers[lockerId]) {
      lockers[lockerId].paid = true;
      console.log(`[PAYMENT SUCCESS] Locker ${lockerId} marked as PAID via Webhook`);
    }
  }

  res.json({ received: true });
});

// ============================================================
// 2. GENERAL MIDDLEWARES
// *** แปลง JSON สำหรับ Route ทั่วไป (วางไว้ใต้ Webhook) ***
// ============================================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// 3. API ENDPOINTS
// ============================================================

// Home / Health check
app.get('/', (req, res) => {
  res.send('Smart Locker Backend with Stripe Webhook is running!');
});

// GET /api/lockers - ดึงสถานะตู้ทั้งหมด
app.get('/api/lockers', (req, res) => {
  res.json({ success: true, lockers });
});

// POST /api/deposit - ฝากของและตั้งรหัส PIN
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
    price: 0
  };

  console.log(`[DEPOSIT] Locker ${lockerId} locked successfully with PIN: ${pin}`);
  res.json({ success: true, message: 'Deposit recorded successfully' });
});

// POST /api/retrieve - คำนวณเวลา และสร้าง Stripe Checkout Session
app.post('/api/retrieve', async (req, res) => {
  const { lockerId, pin } = req.body;
  const locker = lockers[lockerId];

  if (!locker || locker.status === 'FREE') {
    return res.status(400).json({ success: false, message: 'Locker is empty' });
  }

  if (locker.pin !== pin) {
    return res.status(401).json({ success: false, message: 'Incorrect PIN' });
  }

  // คำนวณระยะเวลาใช้งาน (ปัดเศษนาทีขึ้น)
  const durationMs = Date.now() - locker.startTime;
  let minutes = Math.ceil(durationMs / 60000);
  if (minutes < 1) minutes = 1;

  // คำนวณราคา (นาทีละ 1 บาท, ขั้นต่ำ 10 บาท)
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
          unit_amount: totalPrice * 100, // สตางค์
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

// GET /check - ESP32 Polling เช็คการชำระเงิน
app.get('/check', (req, res) => {
  const lockerId = req.query.lockerId || 1;
  const locker = lockers[lockerId];

  if (locker && locker.paid) {
    // เมื่อชำระเงินแล้ว รีเซ็ตสถานะตู้เป็นว่างทันที
    lockers[lockerId] = { status: 'FREE', pin: null, startTime: null, paid: false, price: 0 };
    console.log(`[UNLOCK] Locker ${lockerId} paid! Sending ON signal to ESP32.`);
    return res.json({ status: 'ON' });
  }

  res.json({ status: 'OFF' });
});

// --- Start Server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SERVER] Smart Locker Backend running on port ${PORT}`);
});
