// =============================================================================
// stripe-webhook.js
//
// Stripe calls this function after a Checkout payment succeeds.
//
// IMPORTANT:
// This function is the authority for marking bookings/invoices as paid.
// The browser success page does NOT mark anything as paid.
//
// Stripe may deliver the same webhook more than once, so this function
// must be safe to run repeatedly.
// =============================================================================

const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async function (event) {
  // Stripe sends its signature in this header.
  const signature =
    event.headers?.["stripe-signature"] ||
    event.headers?.["Stripe-Signature"];

  if (!signature) {
    console.error("Missing Stripe signature");

    return {
      statusCode: 400,
      body: "Missing Stripe signature"
    };
  }

  let stripeEvent;

  // ============================================================
  // VERIFY STRIPE WEBHOOK
  // ============================================================

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error(
      "Webhook signature verification failed:",
      err.message
    );

    return {
      statusCode: 400,
      body: "Webhook signature verification failed"
    };
  }

  // ============================================================
  // ONLY PROCESS CHECKOUT COMPLETION
  // ============================================================

  if (stripeEvent.type !== "checkout.session.completed") {
    return {
      statusCode: 200,
      body: JSON.stringify({
        received: true
      })
    };
  }

  const session = stripeEvent.data.object;
  const metadata = session.metadata || {};

  console.log(
    "Stripe checkout completed:",
    session.id
  );

  // ============================================================
  // BOOKING PAYMENT
  // ============================================================

  if (metadata.booking_id) {
    try {
      const bookingId = metadata.booking_id;

      // First make sure the booking exists.
      const {
        data: booking,
        error: bookingLookupError
      } = await supabaseAdmin
        .from("bookings")
        .select(
          "id, status, preferred_date, stripe_payment_intent_id"
        )
        .eq("id", bookingId)
        .single();

      if (bookingLookupError || !booking) {
        console.error(
          "Booking not found:",
          bookingId,
          bookingLookupError
        );

        return {
          statusCode: 500,
          body: "Booking not found"
        };
      }

      // ----------------------------------------------------------
      // Mark booking as paid.
      // ----------------------------------------------------------

      if (booking.status !== "paid") {
        const { error: updateError } =
          await supabaseAdmin
            .from("bookings")
            .update({
              status: "paid",
              stripe_payment_intent_id:
                session.payment_intent
            })
            .eq("id", bookingId);

        if (updateError) {
          console.error(
            "Failed to mark booking paid:",
            updateError
          );

          return {
            statusCode: 500,
            body: "Could not update booking"
          };
        }
      }

      // ----------------------------------------------------------
      // Check whether a job already exists.
      //
      // This makes repeated Stripe webhook deliveries safe.
      // ----------------------------------------------------------

      const {
        data: existingJob,
        error: jobLookupError
      } = await supabaseAdmin
        .from("jobs")
        .select("id")
        .eq("booking_id", bookingId)
        .maybeSingle();

      if (jobLookupError) {
        console.error(
          "Failed checking for existing job:",
          jobLookupError
        );

        return {
          statusCode: 500,
          body: "Could not check existing job"
        };
      }

      // ----------------------------------------------------------
      // Create job only if one does not already exist.
      // ----------------------------------------------------------

      if (!existingJob) {
        const { error: jobInsertError } =
          await supabaseAdmin
            .from("jobs")
            .insert({
              booking_id: bookingId,
              scheduled_date: booking.preferred_date,
              status: "unassigned"
            });

        if (jobInsertError) {
          // PostgreSQL unique-index protection may catch a race
          // where another webhook created the job simultaneously.
          //
          // The UNIQUE index recommended above makes duplicate
          // creation impossible.
          console.error(
            "Failed creating job:",
            jobInsertError
          );

          return {
            statusCode: 500,
            body: "Could not create job"
          };
        }

        console.log(
          "Created job for booking:",
          bookingId
        );
      } else {
        console.log(
          "Job already exists for booking:",
          bookingId
        );
      }
    } catch (err) {
      console.error(
        "Booking webhook processing failed:",
        err
      );

      // IMPORTANT:
      // Return 500 so Stripe knows processing failed and can retry.
      return {
        statusCode: 500,
        body: "Webhook processing failed"
      };
    }
  }

  // ============================================================
  // INVOICE PAYMENT
  // ============================================================

  if (metadata.invoice_id) {
    try {
      const invoiceId = metadata.invoice_id;

      const {
        data: invoice,
        error: invoiceLookupError
      } = await supabaseAdmin
        .from("invoices")
        .select("id, status")
        .eq("id", invoiceId)
        .single();

      if (invoiceLookupError || !invoice) {
        console.error(
          "Invoice not found:",
          invoiceId,
          invoiceLookupError
        );

        return {
          statusCode: 500,
          body: "Invoice not found"
        };
      }

      // Updating an already-paid invoice is harmless,
      // but avoiding unnecessary writes makes the webhook cleaner.
      if (invoice.status !== "paid") {
        const { error: updateError } =
          await supabaseAdmin
            .from("invoices")
            .update({
              status: "paid",
              stripe_payment_intent_id:
                session.payment_intent
            })
            .eq("id", invoiceId);

        if (updateError) {
          console.error(
            "Failed to mark invoice paid:",
            updateError
          );

          return {
            statusCode: 500,
            body: "Could not update invoice"
          };
        }
      }

      console.log(
        "Invoice marked paid:",
        invoiceId
      );
    } catch (err) {
      console.error(
        "Invoice webhook processing failed:",
        err
      );

      return {
        statusCode: 500,
        body: "Invoice webhook processing failed"
      };
    }
  }

  // ============================================================
  // DONE
  // ============================================================

  return {
    statusCode: 200,
    body: JSON.stringify({
      received: true
    })
  };
};
