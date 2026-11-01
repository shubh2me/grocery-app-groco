GROCO v4  (customer store + picker app + rider app + admin panel, all live)

1) SETUP (fresh folder, terminal inside it, next to server.js)
     npm install
     node setup-db.js --reset
     node server.js
   Already running v3 with real orders? Do NOT use --reset. Just copy the new files over and run
     npm install
     node setup-db.js          (adds the new tables and columns, keeps your data)
   then start the server again.

2) OPEN
     Store  http://localhost:3000
     Admin  http://localhost:3000/admin.html    admin@groco.com / admin123 (or ADMIN_PASSWORD)
     Staff  http://localhost:3000/staff.html    picker@groco.com / picker123    rider@groco.com / rider123 (demo accounts)

3) SWITCH ON THE REAL SERVICES (all optional, copy .env.example to .env)
     Razorpay payments  RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET   (until then: clearly labelled DEMO payment)
     SMS / WhatsApp     TWILIO_* , or WEBHOOK_URL for MSG91 / Fast2SMS / Zapier / n8n
     Email              SMTP_URL + MAIL_FROM
     Phone alerts       installed automatically (web-push); staff tap Me > "Turn on phone alerts"; needs HTTPS or localhost
   Admin > Settings & Backup shows what is connected, a test-message button, and every message sent.

4) WHAT'S NEW IN v4
     Delivery rules     minimum order, delivery fee, free delivery above X, pincode list, store hours, delivery slots
     Payments           online payment, unpaid orders released after 15 min, paid-order cancel = refund
     Missing items      picker taps "Not found": bill reduced, refund if paid, customer told
     Problems / refunds customer reports damaged / missing item (48h), admin approves, refund list
     Rider cash         cash collected on COD is tracked; admin receives it and any shortage is recorded
     Forgot password    6-digit code by SMS / email (customers, staff, admin)
     Purchasing         suppliers, reorder levels, low-stock suggestions, purchase orders, receive with expiry
     GST invoice        printable tax invoice per order (Admin > Orders > invoice, customer > order > Invoice)
     Ratings            customers rate the rider; shown to admin and the rider
     Leave & overtime   staff request leave, admin approves (paid day); overtime after shift at 1.5x
     Backups            automatic daily + download; HTTPS support; see DEPLOY.md

5) KNOWN LIMITS (read these)
     * No Razorpay webhook yet: if a customer pays but closes the browser before the app confirms it, the order is
       cancelled after 15 min while the payment may be captured. Check the Razorpay dashboard and refund those.
     * GST percentages are starter values; confirm them with your accountant. Invoice tax is carved out of GST-inclusive prices.
     * WhatsApp business messages in production need Meta-approved templates; use Twilio sandbox for testing.
     * Rider GPS and "pin my location" work only on https:// or localhost.
     * Money refunds for cash orders are manual (you pay the customer, then press "Mark refunded").
