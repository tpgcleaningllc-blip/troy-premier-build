// =============================================================================
// create-checkout-session.js
//
// Called by index.html (for a new booking) and client.html (for an invoice).
// It never trusts a price sent from the browser: it looks the booking or
// invoice row up in Supabase with the secret service role key, and uses
// whatever amount is stored there, before handing that amount to Stripe.
// =============================================================================
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const { type, id } = body;
  if (!id || (type !== "booking" && type !== "invoice")) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing or invalid type/id" }) };
  }

  const siteUrl = process.env.URL || `https://${event.headers.host}`;

  try {
    let description, amount, metadata, successUrl, cancelUrl;

    if (type === "booking") {
      const { data: booking, error } = await supabaseAdmin
        .from("bookings")
        .select("*")
        .eq("id", id)
        .single();
      if (error || !booking) throw new Error("Booking not found");
      if (booking.status === "paid") {
        return { statusCode: 400, body: JSON.stringify({ error: "This booking is already paid" }) };
      }

      description = booking.service + " for " + booking.first_name + " " + booking.last_name;
      amount = booking.estimated_price;
      metadata = { booking_id: booking.id };
      successUrl = siteUrl + "/?booking=success";
      cancelUrl = siteUrl + "/?booking=cancelled";
    } else {
      const { data: invoice, error } = await supabaseAdmin
        .from("invoices")
        .select("*")
        .eq("id", id)
        .single();
      if (error || !invoice) throw new Error("Invoice not found");
      if (invoice.status === "paid") {
        return { statusCode: 400, body: JSON.stringify({ error: "This invoice is already paid" }) };
      }

      description = invoice.description;
      amount = invoice.amount;
      metadata = { invoice_id: invoice.id };
      successUrl = siteUrl + "/client.html?invoice=success";
      cancelUrl = siteUrl + "/client.html?invoice=cancelled";
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: description },
            unit_amount: Math.round(amount * 100)
          },
          quantity: 1
        }
      ],
      metadata: metadata,
      success_url: successUrl,
      cancel_url: cancelUrl
    });

    // remember the session id so the webhook can find its way back to the row
    if (type === "booking") {
      await supabaseAdmin.from("bookings").update({ stripe_session_id: session.id }).eq("id", id);
    } else {
      await supabaseAdmin.from("invoices").update({ stripe_session_id: session.id }).eq("id", id);
    }

    return { statusCode: 200, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || "Could not start checkout" }) };
  }
};
