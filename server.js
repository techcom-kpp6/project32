const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

const app = express();

const RATE_PER_MINUTE = 1;
const MINIMUM_PRICE = 10;

const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_your_stripe_secret_key');

app.use(cors());

app.get('/', (req, res) => {
  res.send('Smart Locker API Server is running!');
});

// ============================================================
// 1. WEBHOOK ROUTE (ต้องวางไว้ก่อน express.json() เสมอ!)
// ============================================================
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // ต้องใช้ req.body ที่เป็น Raw Buffer จาก express.raw()
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error(`[WEBHOOK ERROR] ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const lockerId = session.metadata.lockerId;

    if (lockers[lockerId]) {
      lockers[lockerId].paid = true;
      console.log(`[PAYMENT SUCCESS] Locker ${lockerId} marked as PAID`);
    }
  }

  res.json({ received: true });
});

// ============================================================
// 2. MIDDLEWARE สำหรับ API อื่นๆ (วางไว้หลัง Webhook)
// ============================================================
app.use(express.json());

// ข้อมูลตู้ในระบบ
const lockers = {
  1: { status: 'FREE', pin: null, startTime: null, paid: false, price: 0 },
  2: { status: 'FREE', pin: null, startTime: null, paid: false, price: 0 },
  3: { status: 'FREE', pin: null, startTime: null, paid: false, price: 0 }
};

// GET /api/lockers
app.get('/api/lockers', (req, res) => {
  res.json({ success: true, lockers });
});

// POST /api/deposit
app.post('/api/deposit', (req, res) => {
  const { lockerId, pin } = req.body;

  if (!lockers[lockerId]) {
    return res.status(400).json({ success: false, message: 'Invalid locker ID' });
  }
  if (lockers[lockerId].status !== 'FREE') {
    return res.status(400).json({ success: false, message: 'Locker is already in use' });
  }

  lockers[lockerId] = {
    status: 'BUSY',
    pin: pin,
    startTime: Date.now(),
    paid: false,
    price: 0
  };

  console.log(`[DEPOSIT] Locker ${lockerId} locked with PIN ${pin}`);
  res.json({ success: true, message: 'Deposit recorded successfully' });
});

// POST /api/retrieve
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

// GET /check
app.get('/check', (req, res) => {
  const lockerId = req.query.lockerId || 1;
  const locker = lockers[lockerId];

  if (locker && locker.paid) {
    lockers[lockerId] = { status: 'FREE', pin: null, startTime: null, paid: false, price: 0 };
    console.log(`[UNLOCK] Payment confirmed for Locker ${lockerId}. Sending ON signal.`);
    return res.json({ status: 'ON' });
  }

  res.json({ status: 'OFF' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SERVER] Smart Locker Backend running on port ${PORT}`);
});
