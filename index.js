const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const { error } = require("console");
require("dotenv").config();

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);

app.use(cors());
app.use(express.json());

// Firebase Admin Init
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

const db = admin.firestore();

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
  // const {userId} = req.body;
  const userId = "OnFeLYY9Y4PnmmsoYKQsN7HIE8G3";

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
      return_url: "https://example.com/return",
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
      const { amount, destinationAccountId } = req.body;
  
      const transfer = await stripe.transfers.create({
        amount: amount,
        currency: 'usd',
        destination: destinationAccountId, // Vendor's connected Stripe Account ID
      });
  
      res.send({ success: true, transfer });
    } catch (error) {
      console.error('Transfer error:', error);
      res.status(400).send({ error: error.message });
    }
  });

// Refund to user
app.post("/refund", async (req, res) => {
  try {
    const { paymentIntentId } = req.body;

    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
    });

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
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: 'Order from MyApp',
              },
              unit_amount: req.body.amount, // in cents (e.g., 5000 = $50.00)
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        success_url: 'https://example.com/success',
        cancel_url: 'https://example.com/cancel',
      });
  
      res.send({ url: session.url });
    } catch (err) {
      res.status(400).send({ error: err.message });
    }
  });

 app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
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
    const account = event.data.object;
    const userId = account.metadata?.userId; // ✅
  
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

  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("Stripe backend is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
