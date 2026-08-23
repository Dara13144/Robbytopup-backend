import { Router, Response } from 'express';
import prisma from '../prisma';
import { AuthenticatedRequest } from '../middleware/auth';
import { lookupPlayerNickname } from '../utils/gameProviderMock';
import { generateABAMockPayment, generateBakongKHQR } from '../utils/paymentMock';
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

// POST /api/payments/create
router.post('/create', async (req: AuthenticatedRequest, res: Response) => {
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
        userId = decoded.id;
        contactEmail = decoded.email;
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

// GET /api/payments/status/:transactionId
router.get('/status/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;
    let order = await prisma.order.findUnique({
      where: { paymentTxnId: transactionId },
      include: { package: { include: { product: true } } },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Auto payment checking for pending orders
    if (order.paymentStatus === 'PENDING' && (order.paymentMethod === 'BAKONG' || order.paymentMethod === 'ABA')) {
      const isPaid = await verifyAbaKhqrPayment(order);
      if (isPaid) {
        console.log(`[Status Polling] Order ${transactionId} payment confirmed. Processing delivery...`);
        const result = await processVerifiedPayment(order, `POLL-AUTO-${order.paymentMd5 || transactionId}`);
        const updatedOrder = await prisma.order.findUnique({
          where: { paymentTxnId: transactionId },
          include: { package: { include: { product: true } } },
        });
        if (updatedOrder) order = updatedOrder;
      }
    }

    return res.status(200).json({
      id: order.id,
      transactionId: order.paymentTxnId,
      gameName: order.package.product.name,
      gameSlug: order.package.product.slug,
      packageName: order.package.name,
      playerId: order.playerId,
      playerNickname: order.playerNickname,
      amount: order.price,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      stockDeliveredCode: order.stockDeliveredCode,
      paymentQrCode: order.paymentQrCode,
      createdAt: order.createdAt,
    });
  } catch (error) {
    console.error('Fetch order status error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/verify
// SECURE PAYMENT VERIFICATION ENDPOINT
// 1. Validates txnId & paymentMd5 are present
// 2. Fetches order from OUR database (amount is always from DB, never trust client)
// 3. Checks idempotency (already paid)
// 4. Calls NBC Bakong API directly (server-to-server) using the stored MD5
// 5. Logs fraud attempts if MD5 doesn't match what's stored
// 6. Processes delivery atomically and idempotently
// ─────────────────────────────────────────────────────────────────────────────
router.post('/verify', async (req, res) => {
  try {
    const transactionId = req.body.transactionId || req.body.txnId || req.body.paymentTxnId;
    const clientMd5     = req.body.paymentMd5 || req.body.md5 || null;

    if (!transactionId) {
      return res.status(400).json({ verified: false, error: 'transactionId or txnId is required in request body' });
    }

    // ── RULE 1: Fetch order from OUR database (single source of truth) ────────
    const order = await prisma.order.findUnique({
      where: { paymentTxnId: transactionId },
      include: { package: { include: { product: true } } },
    });

    if (!order) {
      return res.status(404).json({ verified: false, error: 'Transaction ID not found in system.' });
    }

    // ── RULE 2: Idempotency guard — prevent double processing ─────────────────
    if (order.paymentStatus === 'PAID' || order.paymentStatus === 'SUCCESS' || order.status === 'PAID' || order.status === 'SUCCESS') {
      console.log(`[Verify] Order ${transactionId} already processed. Returning cached success.`);
      return res.status(200).json({
        verified: true,
        status: order.status,
        paymentStatus: order.paymentStatus,
        message: 'Payment already verified and processed.',
      });
    }

    // ── RULE 3: Expire orders older than 5 minutes ───────────────────────────
    const orderAgeMs = Date.now() - new Date(order.createdAt).getTime();
    if (orderAgeMs > 5 * 60 * 1000) {
      await prisma.order.update({
        where: { id: order.id },
        data: { paymentStatus: 'EXPIRED', status: 'CANCELLED', deliveryStatus: 'FAILED' },
      });
      return res.status(410).json({ verified: false, error: 'Order has expired. Please create a new order.' });
    }

    // ── RULE 4: MD5 fraud check (if client sends a paymentMd5, verify it matches DB) ─
    if (clientMd5 && order.paymentMd5) {
      const storedMd5 = order.paymentMd5.toLowerCase().trim();
      const incomingMd5 = clientMd5.toLowerCase().trim();
      if (storedMd5 !== incomingMd5) {
        console.error(`[SECURITY ALERT] MD5 mismatch on verify! TxnId=${transactionId} stored=${storedMd5} received=${incomingMd5}. Possible fraud.`);
        return res.status(403).json({ verified: false, error: 'Security signature mismatch. Verification failed.' });
      }
    }

    // ── RULE 5: Delegate to comprehensive gateway verification (CutLuy + Bakong MD5) ─
    const isPaid = await verifyAbaKhqrPayment(order);

    if (!isPaid) {
      // Re-read DB in case concurrent sweep or webhook processed it
      const freshCheck = await prisma.order.findUnique({ where: { id: order.id } });
      if (freshCheck && (freshCheck.paymentStatus === 'SUCCESS' || freshCheck.paymentStatus === 'PAID' || freshCheck.status === 'PAID')) {
        return res.status(200).json({
          verified: true,
          status: freshCheck.status,
          paymentStatus: freshCheck.paymentStatus,
          deliverySuccess: true,
          deliveredCode: freshCheck.stockDeliveredCode,
          message: 'Payment verified and processed.',
        });
      }

      return res.status(200).json({
        verified: false,
        status: order.status,
        paymentStatus: order.paymentStatus,
        message: 'Payment not yet confirmed. Please complete the transfer in your banking app.',
      });
    }

    // ── RULE 6: Process atomic fulfillment and send alerts ───────────────────
    console.log(`[Verify] ✅ Payment verified for ${transactionId}. Processing delivery...`);
    const result = await processVerifiedPayment(order, `VERIFY-${order.gatewayRef || order.paymentMd5 || transactionId}`);

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



export default router;
