const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

const app = express();

// ==========================================
// ตั้งค่าราคาบริการตรงนี้
// ==========================================
const RATE_PER_MINUTE = 2; // <--- แก้ไขตัวเลขนี้เพื่อเปลี่ยนราคาต่อนาที (เช่น 2 = นาทีละ 2 บาท, 5 = นาทีละ 5 บาท)
const MINIMUM_PRICE = 10;   // ราคาขั้นต่ำของระบบ (Stripe บังคับขั้นต่ำ 10 THB)

// ใส่ Stripe Secret Key (หรือใช้ผ่าน Environment Variable บน Render)
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_your_stripe_secret_key');

app.use(cors());

app.get('/', (req, res) => {
  res.send('Smart Locker API Server is running!');
});

// Webhook Route ต้องอยู่ก่อน express.json() เพื่อรับ Raw Body สำหรับตรวจสอบ Signature
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET || 'whsec_your_webhook_secret'
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

app.use(express.json());

// ข้อมูลตู้ในระบบ
const lockers = {
  1: { status: 'FREE', pin: null, startTime: null, paid: false, price: 0 },
  2: { status: 'FREE', pin: null, startTime: null, paid: false, price: 0 },
  3: { status: 'FREE', pin: null, startTime: null, paid: false, price: 0 }
};

// GET /api/lockers - ดึงสถานะตู้ทั้งหมด
app.get('/api/lockers', (req, res) => {
  res.json({ success: true, lockers });
});

// POST /api/deposit - บันทึกการฝากของ
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
    startTime: Date.now(), // บันทึก เวลาจริง ณ ปัจจุบัน
    paid: false,
    price: 0
  };

  console.log(`[DEPOSIT] Locker ${lockerId} locked with PIN ${pin} at ${new Date().toLocaleTimeString()}`);
  res.json({ success: true, message: 'Deposit recorded successfully' });
});

// POST /api/retrieve - ตรวจสอบรหัสผ่าน คำนวณเวลา และสร้าง Stripe Link
app.post('/api/retrieve', async (req, res) => {
  const { lockerId, pin } = req.body;
  const locker = lockers[lockerId];

  if (!locker || locker.status === 'FREE') {
    return res.status(400).json({ success: false, message: 'Locker is empty' });
  }

  if (locker.pin !== pin) {
    return res.status(401).json({ success: false, message: 'Incorrect PIN' });
  }

  // คำนวณเวลานาทีจริงจาก Server
  const durationMs = Date.now() - locker.startTime;
  let minutes = Math.ceil(durationMs / 60000);
  if (minutes < 1) minutes = 1;

  // คำนวณราคาตามอัตราต่อนาทีที่กำหนดไว้
  let totalPrice = minutes * RATE_PER_MINUTE;

  // กำหนดขั้นต่ำที่ 10 THB เพื่อให้ผ่านเงื่อนไขของ Stripe
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
            name: `Smart Locker #${lockerId} (${minutes} Mins @ ${RATE_PER_MINUTE} THB/Min)`,
          },
          unit_amount: totalPrice * 100, // สตางค์
        },
        quantity: 1,
      }],
      mode: 'payment',
      metadata: { lockerId: String(lockerId) },
      success_url: 'https://stripe-esp32.onrender.com/success',
      cancel_url: 'https://stripe-esp32.onrender.com/cancel',
    });

    console.log(`[RETRIEVE] Locker ${lockerId} - Time: ${minutes} min(s), Rate: ${RATE_PER_MINUTE} THB/min, Total: ${totalPrice} THB`);

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
    // รีเซ็ตสถานะตู้กลับเป็นว่าง
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
