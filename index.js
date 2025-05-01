const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");
require("dotenv").config();

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

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
  try {
    const account = await stripe.accounts.create({ type: "express" });

    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: "https://example.com/reauth",
      return_url: "https://example.com/return",
      type: "account_onboarding",
    });

    res.send({ accountId: account.id, onboardingUrl: accountLink.url });
  } catch (error) {
    res.status(400).send({ error: error.message });
  }
});

// Admin transfers to vendor
app.post("/transfer", async (req, res) => {
  try {
    const { amount, vendorAccountId } = req.body;

    const transfer = await stripe.transfers.create({
      amount,
      currency: "usd",
      destination: vendorAccountId,
    });

    res.send({ transferId: transfer.id });
  } catch (error) {
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

    res.send({ refundId: refund.id });
  } catch (error) {
    res.status(400).send({ error: error.message });
  }
});

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
  

app.get("/", (req, res) => res.send("Stripe backend is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
