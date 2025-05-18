const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const { error } = require("console");
require("dotenv").config();

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const isLocal = false;

const endpointSecret = isLocal ? process.env.STRIPE_LOCALHOST_KEY  :  process.env.STRIPE_WEBHOOK_SECRET;
const serviceAccount = isLocal ? require('./serviceAccountKey.json') : JSON.parse(process.env.FIREBASE_CONFIG);
const domainUrl = isLocal ? 'http://localhost:5000' : 'https://eventsjostripebackend.onrender.com';

// Firebase Admin Init
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

const db = admin.firestore();

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  console.log("🔥 Webhook triggered:");
  
  const sig = req.headers['stripe-signature'];
  let event;
  

 try {
   event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
 } catch (err) {
   console.error('❌ Stripe signature verification failed:', err.message);
   return res.status(400).send(`Webhook Error: ${err.message}`);
 }

 // ✅ Listen for account.updated
 if (event.type === 'account.updated') {
  console.log(`🧾 enter account update`);
  const account = event.data.object;
   const userId = account.metadata?.userId;
 
   if (!userId) {
     console.warn(`⚠️ No userId in metadata for account ${account.id}`);
     return res.sendStatus(200);
   }
 
   const onboarded = account.details_submitted;
 
   await db.collection('owners').doc(userId).update({
     onboarded,
     onboardingStatus: onboarded ? 'complete' : 'incomplete',
   });
 
   console.log(`📦 Vendor ${userId} onboarding status updated.`);
 }

 // ✅ Listen for checkout.session.completed
 if (event.type === 'checkout.session.completed') {
  console.log(`💵 checkout session completed`);

  const session = event.data.object;
  const orderId = session.metadata?.orderId;
 
   if (!orderId) {
     console.warn(`⚠️ No userId in metadata for account ${session.id}`);
     return res.sendStatus(200);
   }
 
   await db.collection('orders').doc(orderId).update({
    status: 'pending',
    paymentIntentId: session.payment_intent
   });
 
   console.log(`📦 Order ${orderId} status updated.`);
 }

 res.send();
});

app.use(cors());
app.use(express.json());

// Create PaymentIntent
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount, currency } = req.body;

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      automatic_payment_methods: { enabled: true },
    });

    res.send({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    res.status(400).send({ error: error.message });
  }
});

// Create connected account (vendor)
app.post("/create-connected-account", async (req, res) => {
  const {userId} = req.body;

  if(!userId){
    return res.status(400).json({error:"Missing user id"});
  }

  try {
    const account = await stripe.accounts.create(
      { 
        type: "express",
        metadata: {
          userId: userId,
        },
       });

       await db.collection('owners').doc(userId).update({
        stripeAccountId: account.id,
        onboarded: false,
        onboardingStatus: 'incomplete',
      });

    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: "https://example.com/reauth",
      return_url: `${domainUrl}/return.html`,
      type: "account_onboarding",
    });

    // Return the link + account ID
    res.send({ url: accountLink.url, accountId: account.id });
  } catch (error) {
    res.status(400).send({ error: error.message });
  }
});

// Admin transfers to vendor
app.post('/transfer', async (req, res) => {
    try {
      const { amount, stripeAccountId, orderId } = req.body;

      if (!amount || !stripeAccountId) {
        return res.status(400).json({ error: 'Missing required fields.' });
      }
  
      const transfer = await stripe.transfers.create({
        amount: Math.round(amount * 100),
        currency: 'usd',
        destination: stripeAccountId, 
      });

      await db.collection('orders').doc(orderId).update({
        status: 'paid',
       });
  
  
      console.log(`📩 Transferd ${amount} to ${stripeAccountId}`);
  
      res.send({ success: true, transfer });
    } catch (error) {
      console.error('Transfer error:', error);
      res.status(400).send({ error: error.message });
    }
  });

// Refund to user
app.post("/refund", async (req, res) => {
  try {
    const { paymentIntentId,orderId,cancelledBy,amount } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Missing paymentIntentId' });
    }

    // Calculate refund amount
    let refundAmount = amount;
    if (cancelledBy === 'user') {
      console.log('ddddddddddddd');
      refundAmount = Math.round(amount * 0.9); // 90% refund
    }

    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      amount:refundAmount * 100,
    });

    await db.collection('orders').doc(orderId).update({
      status: 'refunded',
     });


    console.log(`💸 Refunded PaymentIntent ${paymentIntentId} → Refund ID: ${refund.id}`);

     res.send({ success: true, refund });
  } catch (error) {
    res.status(400).send({ error: error.message });
  }
});

//cheackout
app.post("/create-checkout-session", async (req, res) => {
    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        metadata: {
          'orderId':req.body.orderId,
          'ownerId':req.body.ownerId,
          'stripeAccountId': req.body.stripeAccountId,
        },
        payment_intent_data:{
          metadata: {
            'orderId':req.body.orderId,
            'ownerId':req.body.ownerId,
            'stripeAccountId': req.body.stripeAccountId,
          },
        },
        line_items: [
          {
            price_data: {
              currency: 'usd',
              unit_amount: Math.round(req.body.amount * 100),
              product_data: {
                name: req.body.description || 'Product',
              },
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
       success_url: `${domainUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${domainUrl}/cancel.html?session_id={CHECKOUT_SESSION_ID}`,
      });
  
      res.send({ url: session.url });
    } catch (err) {
      console.log(err);
      res.status(400).send({ error: err.message });
    }
  });

app.get('/balance', async (req, res) => {
  try {
    const balance = await stripe.balance.retrieve();
    res.json(balance);
  } catch (error) {
    console.error('❌ Balance fetch failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/payouts', async (req, res) => {
  try {
    const payouts = await stripe.payouts.list({ limit: 10 });
    res.json(payouts);
  } catch (error) {
    console.error('❌ Failed to fetch payouts:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const path = require('path');
const { ref } = require("process");

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

app.get("/", (req, res) => res.send("Stripe backend is running"));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`❤️ Server running on ${PORT}`));
