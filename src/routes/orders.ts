import { Router, Response } from 'express';
import prisma from '../prisma';
import { AuthenticatedRequest } from '../middleware/auth';
import { lookupPlayerNickname } from '../utils/gameProviderMock';
import { generateABAMockPayment, generateBakongKHQR, verifyBakongWebhook } from '../utils/paymentMock';
import { sendTelegramNotification, formatTelegramBotOrderMessage } from '../utils/telegram';
import { verifyAbaKhqrPayment, processVerifiedPayment } from '../utils/paymentVerification';
import { PRODUCTS_SEED, seedDatabase } from '../utils/startup';

const router = Router();

async function resolvePackageSafely(packageId: string) {
  // 1. Try finding package by direct ID in database
  let pkg = await prisma.package.findUnique({
    where: { id: packageId },
    include: { product: true },
  }).catch(() => null);

  if (pkg) return pkg;

  // 2. If not found in DB, search seed catalog
  for (const p of PRODUCTS_SEED) {
    const matchedSeedPkg = p.packages.find((sp, idx) =>
      packageId === `pkg_${p.slug}_${idx}` ||
      packageId.startsWith(p.slug) ||
      packageId.includes(sp.name.toLowerCase().replace(/\s+/g, '-')) ||
      packageId === sp.name ||
      packageId === sp.amount.toString()
    );

    if (matchedSeedPkg) {
      // Find or create product in DB
      let dbProduct = await prisma.product.findUnique({
        where: { slug: p.slug },
        include: { packages: true },
      }).catch(() => null);

      if (!dbProduct) {
        dbProduct = await prisma.product.create({
          data: {
            name: p.name,
            slug: p.slug,
            image: p.image,
            category: p.category,
            isActive: true,
            packages: {
              create: p.packages.map((sp) => ({
                name: sp.name,
                amount: sp.amount,
                price: sp.price,
                category: sp.category,
                badge: sp.badge || null,
                isActive: true,
              })),
            },
          },
          include: { packages: true },
        }).catch(() => null);
      }

      if (dbProduct && dbProduct.packages.length > 0) {
        const foundPkg =
          dbProduct.packages.find((pk) => pk.name === matchedSeedPkg.name || pk.amount === matchedSeedPkg.amount) ||
          dbProduct.packages[0];
        return {
          ...foundPkg,
          product: dbProduct,
        };
      }
    }
  }

  // 3. Fallback: return first package from DB or create a default one
  const anyPkg = await prisma.package.findFirst({
    include: { product: true },
  }).catch(() => null);

  if (anyPkg) return anyPkg;

  // Trigger database seed
  await seedDatabase().catch(() => {});
  return await prisma.package.findFirst({
    include: { product: true },
  }).catch(() => null);
}

// 1. Create a top-up order (Public / Authenticated)
// Matches route POST /api/orders/
router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { packageId, playerId, playerZoneId, paymentMethod, email } = req.body;

    if (!packageId || !playerId || !paymentMethod) {
      return res.status(400).json({ error: 'Required fields missing' });
    }

    if (paymentMethod !== 'ABA' && paymentMethod !== 'BAKONG' && paymentMethod !== 'CANADIA') {
      return res.status(400).json({ error: 'Invalid payment method. Use ABA, BAKONG, or CANADIA' });
    }

    // Fetch the package details safely
    const pkg = await resolvePackageSafely(packageId);

    if (!pkg) {
      return res.status(404).json({ error: 'Package not found' });
    }

    // Validate Player ID and retrieve nickname
    const lookup = await lookupPlayerNickname(pkg.product.slug, playerId, playerZoneId);
    if (!lookup.success) {
      return res.status(400).json({ error: `Player ID validation failed: ${lookup.error}` });
    }
    const nickname = lookup.nickname || 'Unknown Player';

    // Generate unique payment transaction ID
    const timeCode = Date.now().toString().slice(-6);
    const randCode = Math.floor(1000 + Math.random() * 9000);
    let paymentTxnId = `TOPUP-${timeCode}-${randCode}`;

    // Map order to logged-in user if available
    let userId: string | null = null;
    let contactEmail = email || 'guest@topup.com';
    
    // Check if auth token header exists
    if (req.headers.authorization) {
      const authHeader = req.headers.authorization;
      const token = authHeader.split(' ')[1];
      const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-in-production-12345';
      try {
        const decoded = require('jsonwebtoken').verify(token, JWT_SECRET) as { id: string; email: string };
        // Verify user actually exists in DB to avoid FK constraint violation
        const userExists = await prisma.user.findUnique({ where: { id: decoded.id }, select: { id: true } });
        if (userExists) {
          userId = decoded.id;
          contactEmail = decoded.email;
        }
        // If user not found in DB, continue as guest (userId remains null)
      } catch (err) {
        // Ignore invalid token and create as guest
      }
    }

    // Generate payment details depending on gateway choice
    let paymentDetails: any = {};
    let paymentQrCode: string | null = null;
    let paymentMd5: string | null = null;
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    if (paymentMethod === 'ABA') {
      const abaMerchantId = process.env.ABA_PAYWAY_MERCHANT_ID || 'MOCK_MERCHANT';
      const abaApiKey = process.env.ABA_PAYWAY_API_KEY || 'MOCK_KEY';
      paymentDetails = generateABAMockPayment(
        paymentTxnId,
        pkg.price,
        `${pkg.product.name} - ${pkg.name}`,
        abaMerchantId,
        abaApiKey,
        baseUrl
      );
    } else if (paymentMethod === 'CANADIA') {
      const qrData = `00020101021230480012canadia_topup0110topup@cnb5204599953038405404${pkg.price.toFixed(2)}5802KH5919CANADIA BANK PLC.6008Phnom Penh62180710${paymentTxnId}6304E5F6`;
      const md5 = require('crypto').createHash('md5').update(qrData).digest('hex');
      paymentQrCode = qrData;
      paymentMd5 = md5;
      paymentDetails = {
        qrCode: qrData,
        md5,
        txnId: paymentTxnId,
        bankName: 'Canadia Bank',
        logo: '/images/payments/canadia.png'
      };
    } else {
      const bakongQr = await generateBakongKHQR(
        paymentTxnId,
        pkg.price,
        `${pkg.product.name} - ${pkg.name}`
      );
      paymentQrCode = bakongQr.qrCode;
      paymentMd5 = bakongQr.md5;
      // Use the khpay transaction_id (bk_...) if returned, else keep local ID
      if (bakongQr.txnId && bakongQr.txnId !== paymentTxnId) {
        paymentTxnId = bakongQr.txnId;
      }
      paymentDetails = bakongQr;
    }

    // Create Order in Database
    const order = await prisma.order.create({
      data: {
        userId,
        packageId: pkg.id,
        playerId,
        playerZoneId: playerZoneId || null,
        playerNickname: nickname,
        price: pkg.price,
        status: 'PENDING',
        paymentMethod,
        paymentStatus: 'PENDING',
        paymentTxnId,
        paymentQrCode,
        paymentMd5,
        gatewayRef: (paymentDetails as any)?.gatewayRef || null,
        deliveryStatus: 'WAITING',
      },
    });

    return res.status(201).json({
      message: 'Order created successfully',
      order: {
        id: order.id,
        paymentTxnId,
        price: order.price,
        status: order.status,
        paymentStatus: order.paymentStatus,
        playerNickname: nickname,
      },
      paymentDetails,
    });
  } catch (error) {
    console.error('Order creation error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});



// 2. Fetch specific order status (Public - used by polling)
// GET /api/orders/status/:txnId
router.get('/status/:txnId', async (req, res) => {
  try {
    const { txnId } = req.params;
    let order = await prisma.order.findUnique({
      where: { paymentTxnId: txnId },
      include: { package: { include: { product: true } } },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Auto payment checking for pending orders (server-side only, gateway validated)
    if ((order.paymentStatus === 'PENDING') && (order.paymentMethod === 'BAKONG' || order.paymentMethod === 'ABA')) {
      const isPaid = await verifyAbaKhqrPayment(order);
      if (isPaid) {
        console.log(`[Status Polling] Order ${txnId} payment confirmed. Processing delivery...`);
        const result = await processVerifiedPayment(order, `POLL-AUTO-${order.paymentMd5 || txnId}`);
        const updatedOrder = await prisma.order.findUnique({
          where: { paymentTxnId: txnId },
          include: { package: { include: { product: true } } },
        });
        if (updatedOrder) order = updatedOrder;
      }
    }

    let abaPayload = null;
    let abaApiUrl = null;
    if (order.paymentMethod === 'ABA') {
      const abaMerchantId = process.env.ABA_PAYWAY_MERCHANT_ID || 'MOCK_MERCHANT';
      const abaApiKey = process.env.ABA_PAYWAY_API_KEY || 'MOCK_KEY';
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const paymentDetails = generateABAMockPayment(
        order.paymentTxnId,
        order.price,
        `${order.package.product.name} - ${order.package.name}`,
        abaMerchantId,
        abaApiKey,
        baseUrl
      );
      abaPayload = paymentDetails.payload;
      abaApiUrl = process.env.ABA_PAYWAY_API_URL || 'https://checkout-sandbox.ababank.com/api/payment-gateway/v1/payments/purchase';
    }

    return res.status(200).json({
      id: order.id,
      paymentTxnId: order.paymentTxnId,
      gameName: order.package.product.name,
      gameSlug: order.package.product.slug,
      packageName: order.package.name,
      playerId: order.playerId,
      playerNickname: order.playerNickname,
      price: order.price,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      stockDeliveredCode: order.stockDeliveredCode,
      paymentQrCode: order.paymentQrCode,
      paymentMd5: order.paymentMd5,
      createdAt: order.createdAt,
      merchantName: process.env.BAKONG_MERCHANT_NAME || 'Daratopup',
      abaPayload,
      abaApiUrl,
    });
  } catch (error) {
    console.error('Fetch order status error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 2b. Force-verify payment now (called when user clicks "I've Paid")
// POST /api/orders/verify/:txnId
router.post('/verify/:txnId', async (req, res) => {
  try {
    const { txnId } = req.params;
    console.log(`[Verify] Manual verify request for order: ${txnId}`);

    const order = await prisma.order.findUnique({
      where: { paymentTxnId: txnId },
      include: { package: { include: { product: true } } },
    });

    if (!order) {
      return res.status(404).json({ verified: false, error: 'Order not found' });
    }

    // Already paid — return success immediately
    if (order.paymentStatus === 'PAID' || order.paymentStatus === 'SUCCESS') {
      return res.status(200).json({
        verified: true,
        status: order.status,
        paymentStatus: order.paymentStatus,
        message: 'Payment already verified',
      });
    }

    if (order.paymentStatus === 'EXPIRED') {
      return res.status(410).json({ verified: false, error: 'Order has expired. Please create a new order.' });
    }

    // Expire orders older than 5 minutes
    const orderAgeMs = Date.now() - new Date(order.createdAt).getTime();
    if (orderAgeMs > 5 * 60 * 1000) {
      await prisma.order.update({
        where: { id: order.id },
        data: { paymentStatus: 'EXPIRED', status: 'CANCELLED', deliveryStatus: 'FAILED' },
      });
      return res.status(410).json({ verified: false, error: 'Order has expired. Please create a new order.' });
    }

    if (order.paymentMethod !== 'BAKONG' && order.paymentMethod !== 'ABA' && process.env.SANDBOX_MODE !== 'true') {
      return res.status(400).json({ verified: false, error: 'Verify only supports BAKONG/ABA orders' });
    }

    // Delegate verification to paymentVerification service
    const isPaid = await verifyAbaKhqrPayment(order);

    if (!isPaid) {
      return res.status(200).json({
        verified: false,
        status: order.status,
        paymentStatus: order.paymentStatus,
        message: 'Payment not yet confirmed. Please wait and try again.',
      });
    }

    console.log(`[Verify] Payment confirmed for order ${txnId}. Processing delivery...`);
    const result = await processVerifiedPayment(order, `VERIFY-${order.paymentMd5 || txnId}`);

    return res.status(200).json({
      verified: true,
      status: result.currentOrder.status,
      paymentStatus: result.currentOrder.paymentStatus,
      deliverySuccess: result.deliverySuccess,
      deliveredCode: result.deliveredCode,
      message: result.deliverySuccess
        ? 'Payment verified and product delivered!'
        : 'Payment verified but delivery failed. Please contact support.',
    });
  } catch (error) {
    console.error('[Verify] Error:', error);
    return res.status(500).json({ verified: false, error: 'Internal server error' });
  }
});

// 3. User Order History (Public or Auth)
router.get('/history/:emailOrId', async (req, res) => {
  try {
    const { emailOrId } = req.params;
    
    // Find all orders linked to either user ID or user email
    const orders = await prisma.order.findMany({
      where: {
        OR: [
          { userId: emailOrId },
          { user: { email: emailOrId } }
        ]
      },
      include: {
        package: {
          include: { product: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    return res.status(200).json(orders);
  } catch (error) {
    console.error('History fetch error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 4. MOCK PAYMENT WEBHOOK CALLBACK (Simulated payment trigger)
// Anyone can call this to simulate a successful payment trigger for testing.
router.post('/simulate-callback', async (req, res) => {
  try {
    const { txnId, paymentStatus } = req.body;

    if (!txnId) {
      return res.status(400).json({ error: 'Transaction ID (txnId) is required' });
    }

    const order = await prisma.order.findUnique({
      where: { paymentTxnId: txnId },
      include: { package: { include: { product: true } } },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.paymentStatus === 'PAID') {
      return res.status(400).json({ error: 'Order has already been paid and processed' });
    }

    const statusValue = paymentStatus || 'PAID';

    if (statusValue !== 'PAID') {
      // Simulate failed/cancelled payment
      const updatedOrder = await prisma.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: 'EXPIRED',
          status: 'FAILED',
          deliveryStatus: 'FAILED',
        },
      });

      await sendTelegramNotification(
        `❌ <b>Payment Cancelled/Expired</b>\n` +
        `-----------------------------------------\n` +
        `<b>Txn ID:</b> <code>${txnId}</code>\n` +
        `<b>Amount:</b> $${order.price.toFixed(2)}\n` +
        `<b>Gateway:</b> ${order.paymentMethod}`
      );

      return res.status(200).json({ message: 'Order payment status set to failed', order: updatedOrder });
    }

    // Process order payment using the verification service
    const ref = `REF-${Math.floor(100000 + Math.random() * 900000)}`;
    console.log(`[Payment Callback] Payment successful for order ${txnId}. Processing top-up...`);
    const result = await processVerifiedPayment(order, ref);

    return res.status(200).json({
      message: 'Simulated payment callback executed successfully',
      delivery: {
        success: result.deliverySuccess,
        code: result.deliveredCode,
        error: '',
      },
      order: result.currentOrder,
    });
  } catch (error) {
    console.error('Mock callback processing error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 5. REAL BAKONG KHQR PAYMENT WEBHOOK (Production)
router.post('/bakong-callback', async (req, res) => {
  try {
    console.log('[Bakong Webhook] 📥 Received callback request.');
    console.log('[Bakong Webhook] Request headers:', JSON.stringify(req.headers));
    console.log('[Bakong Webhook] Request body:', JSON.stringify(req.body, null, 2));

    // Resolve MD5 using all possible paths
    const rawMd5 = req.body.md5 || 
                   req.body.md5Hash || 
                   req.body.req_khqr?.md5 || 
                   req.body.data?.md5 || 
                   req.body.data?.md5Hash;

    const sanitizedMd5 = rawMd5 ? rawMd5.toLowerCase().trim() : '';

    // Resolve Transaction ID using all possible paths
    const transactionId = req.body.transactionId || 
                           req.body.transaction_id || 
                           req.body.trans_id || 
                           req.body.bill_number || 
                           req.body.req_khqr?.bill_number || 
                           req.body.data?.bill_number || 
                           req.body.data?.transaction_id || 
                           req.body.data?.trans_id;

    // Resolve Session ID
    const sessionId = req.body.session_id || 
                      req.body.data?.session_id || 
                      req.body.id;

    // Resolve Status using all possible paths
    const rawStatus = req.body.status || 
                      req.body.paymentStatus || 
                      req.body.data?.status;

    // Resolve Amount using all possible paths
    const amount = req.body.amount || 
                   req.body.req_khqr?.amount || 
                   req.body.data?.amount;

    // Resolve Currency using all possible paths
    const currency = req.body.currency ||
                     req.body.req_khqr?.currency ||
                     req.body.data?.currency;

    console.log(`[Bakong Webhook] Parsed variables: MD5="${sanitizedMd5}", TxnID="${transactionId || 'N/A'}", SessionID="${sessionId || 'N/A'}", Status="${rawStatus || 'N/A'}", Amount="${amount || 'N/A'}", Currency="${currency || 'N/A'}"`);

    const signature = req.headers['x-bakong-signature'] as string;
    const bakongApiKey = process.env.BAKONG_API_KEY || '';

    // Webhook signature verification
    if (bakongApiKey && signature) {
      const isValid = verifyBakongWebhook(rawMd5 || '', transactionId || '', signature, bakongApiKey);
      if (!isValid) {
        console.warn('[Bakong Webhook] ⚠️ Invalid signature! Rejecting.');
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
      console.log('[Bakong Webhook] ✅ Signature verified.');
    } else {
      console.log('[Bakong Webhook] ⚠️ BAKONG_API_KEY not set — skipping signature verification (sandbox mode).');
    }

    if (!transactionId && !sanitizedMd5 && !sessionId) {
      console.warn('[Bakong Webhook] ❌ Error: Neither transactionId, md5, nor sessionId is present.');
      return res.status(400).json({ error: 'transactionId, md5, or session_id is required' });
    }

    // Find Order
    let order = null;
    if (sessionId) {
      order = await prisma.order.findFirst({
        where: { gatewayRef: sessionId },
        include: { package: { include: { product: true } } },
      });
    }

    if (!order && transactionId) {
      order = await prisma.order.findUnique({
        where: { paymentTxnId: transactionId },
        include: { package: { include: { product: true } } },
      });
    }

    if (!order && sanitizedMd5) {
      order = await prisma.order.findFirst({
        where: {
          OR: [
            { paymentMd5: sanitizedMd5 },
            { paymentMd5: sanitizedMd5.toUpperCase() }
          ]
        },
        include: { package: { include: { product: true } } },
      });
    }

    if (!order) {
      console.warn(`[Bakong Webhook] ❌ Order NOT found for sessionId: "${sessionId || 'N/A'}", txnId: "${transactionId || 'N/A'}" or md5: "${sanitizedMd5 || 'N/A'}"`);
      return res.status(200).json({ message: 'Order not found, acknowledged' });
    }

    if (order.paymentStatus === 'PAID') {
      console.log(`[Bakong Webhook] Order ${order.paymentTxnId} already marked PAID. Skipping.`);
      return res.status(200).json({ message: 'Order already processed' });
    }

    // Verify Amount and Currency
    if (amount) {
      const parsedAmount = parseFloat(amount);
      const webhookCurrency = currency ? currency.toString().toUpperCase().trim() : 'USD';
      
      let isAmountMatch = false;
      if (webhookCurrency === 'KHR') {
        const expectedKhr = Math.round(order.price * 4100);
        isAmountMatch = Math.abs(parsedAmount - expectedKhr) <= 10;
        if (!isAmountMatch) {
          console.warn(`[Bakong Webhook] ❌ Amount mismatch (KHR)! Webhook=${parsedAmount}, Order expected KHR=${expectedKhr} (Order price USD=${order.price})`);
        }
      } else {
        isAmountMatch = Math.abs(parsedAmount - order.price) <= 0.05;
        if (!isAmountMatch) {
          console.warn(`[Bakong Webhook] ❌ Amount mismatch (USD)! Webhook=${parsedAmount}, Order expected USD=${order.price}`);
        }
      }

      if (!isAmountMatch) {
        return res.status(400).json({ error: 'Amount mismatch' });
      }
    }

    if (currency) {
      const normalizedCurrency = currency.toString().toUpperCase().trim();
      if (normalizedCurrency !== 'USD' && normalizedCurrency !== 'KHR') {
        console.warn(`[Bakong Webhook] ❌ Currency not supported! Webhook currency=${normalizedCurrency}`);
        return res.status(400).json({ error: 'Currency not supported' });
      }
    }

    const isSuccess = typeof rawStatus === 'string' && 
      ['PAID', 'SUCCESS', 'paid', 'success'].includes(rawStatus.toUpperCase());

    if (!isSuccess) {
      console.warn(`[Bakong Webhook] ⚠️ Payment reported unsuccessful. Raw status: "${rawStatus}"`);
      await prisma.order.update({
        where: { id: order.id },
        data: { paymentStatus: 'FAILED', status: 'FAILED', deliveryStatus: 'FAILED' },
      });
      await sendTelegramNotification(
        `❌ <b>Bakong Payment Failed</b>\n` +
        `-----------------------------------------\n` +
        `<b>Txn ID:</b> <code>${order.paymentTxnId}</code>\n` +
        `<b>Status from Bakong:</b> ${rawStatus}\n` +
        `<b>Amount:</b> $${order.price.toFixed(2)}`
      );
      return res.status(200).json({ message: 'Payment failure recorded' });
    }

    // Replay attack check
    const replayCheck = await prisma.order.findFirst({
      where: {
        paymentMd5: sanitizedMd5 || order.paymentMd5 || '',
        paymentStatus: 'PAID',
        id: { not: order.id }
      }
    });
    if (replayCheck) {
      console.warn(`[Bakong Webhook] ❌ Replay attack detected! MD5 "${sanitizedMd5}" already used by paid order "${replayCheck.paymentTxnId}".`);
      return res.status(409).json({ error: 'Transaction already used' });
    }

    const ref = `BAKONG-${sanitizedMd5 || Date.now()}`;
    console.log(`[Bakong Webhook] ✅ Payment confirmed for order "${order.paymentTxnId}". Processing delivery...`);
    const result = await processVerifiedPayment(order, ref);

    console.log(`[Bakong Webhook] Order update complete. finalStatus="${result.currentOrder.status}"`);
    return res.status(200).json({
      message: 'Bakong payment processed and top-up delivered',
      status: result.currentOrder.status,
    });
  } catch (error) {
    console.error('[Bakong Webhook] ❌ Unhandled error processing callback:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
