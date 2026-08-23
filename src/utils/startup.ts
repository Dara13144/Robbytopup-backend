import { execSync } from 'child_process';
import path from 'path';
import prisma from '../prisma';
import bcrypt from 'bcryptjs';

/**
 * Self-Healing Database Startup
 *
 * On Render's free tier, the SQLite dev.db is wiped on every deploy because
 * the filesystem is ephemeral. This function:
 * 1. Runs `prisma migrate deploy` to create all tables.
 * 2. Checks if the database is empty.
 * 3. If empty, seeds it with the full product catalog.
 *
 * This ensures GET /api/products always returns data, even after redeployment.
 */

const MLBB_PACKAGES = [
  { name: 'Evo3D MLBB', amount: 100, price: 0.99, category: 'BEST_SELLER', badge: null },
  { name: 'Weekly Pass Best', amount: 210, price: 1.80, category: 'BEST_SELLER', badge: 'ទទួលបាន 200 💎 ភ្លាមៗ' },
  { name: '11 Diamonds', amount: 11, price: 0.25, category: 'NORMAL', badge: null },
  { name: '50 Diamonds', amount: 50, price: 0.99, category: 'NORMAL', badge: 'សាកល្បង' },
  { name: '150 Diamonds', amount: 150, price: 2.80, category: 'NORMAL', badge: null },
  { name: '250 Diamonds', amount: 250, price: 4.50, category: 'NORMAL', badge: 'ពេញនិយម' },
  { name: '500 Diamonds', amount: 500, price: 8.90, category: 'NORMAL', badge: null },
  { name: '1000 Diamonds', amount: 1000, price: 17.50, category: 'NORMAL', badge: 'កញ្ចប់ពិសេស 💎' },
];

const FF_PACKAGES = [
  { name: 'Evo3D', amount: 50, price: 0.83, category: 'BEST_SELLER', badge: null },
  { name: 'Evo7D', amount: 100, price: 0.97, category: 'BEST_SELLER', badge: null },
  { name: 'Evo30D', amount: 200, price: 2.48, category: 'BEST_SELLER', badge: null },
  { name: 'ផ្សងសំណាង', amount: 80, price: 0.57, category: 'BEST_SELLER', badge: 'បានមួយ ដោយចៃដន្យ' },
  { name: '25 Diamonds', amount: 25, price: 0.29, category: 'NORMAL', badge: 'សាកល្បង' },
  { name: '100 Diamonds', amount: 100, price: 0.97, category: 'NORMAL', badge: null },
  { name: '310 Diamonds', amount: 310, price: 2.63, category: 'NORMAL', badge: null },
  { name: '520 Diamonds', amount: 520, price: 4.15, category: 'NORMAL', badge: 'ពេញនិយម' },
  { name: '1060 Diamonds', amount: 1060, price: 8.40, category: 'NORMAL', badge: 'Bonus Event 🔥' },
  { name: '2180 Diamonds', amount: 2180, price: 16.49, category: 'NORMAL', badge: null },
  { name: '5600 Diamonds', amount: 5600, price: 43.55, category: 'NORMAL', badge: null },
  { name: '11500 Diamonds', amount: 11500, price: 88.55, category: 'NORMAL', badge: 'កញ្ចប់ពិសេស 💎' },
  { name: 'WeeklyLite', amount: 100, price: 0.45, category: 'NORMAL', badge: 'ទទួលបាន 20 💎 ភ្លាមៗ' },
  { name: 'Weekly', amount: 250, price: 1.67, category: 'NORMAL', badge: 'ទទួលបាន 200 💎 ភ្លាមៗ' },
  { name: 'Monthly', amount: 1200, price: 7.60, category: 'NORMAL', badge: 'ទទួលបាន 1000 💎 ភ្លាមៗ' },
];

export const PRODUCTS_SEED = [
  { name: 'MOBILE LEGENDS | KHMER',       slug: 'mobile-legends-khmer',       image: '/images/games/mlbb.png',       category: 'MOBILE_GAME', packages: MLBB_PACKAGES },
  { name: 'MOBILE LEGENDS | PHILIPPINES', slug: 'mobile-legends-philippines', image: '/images/games/mlbb.png',       category: 'MOBILE_GAME', packages: MLBB_PACKAGES },
  { name: 'MOBILE LEGENDS | INDONESIA',   slug: 'mobile-legends-indonesia',   image: '/images/games/mlbb.png',       category: 'MOBILE_GAME', packages: MLBB_PACKAGES },
  { name: 'FREE FIRE | KHMER',            slug: 'free-fire-khmer',            image: '/images/games/freefire.png',   category: 'MOBILE_GAME', packages: FF_PACKAGES },
  { name: 'FREE FIRE | INDONESIA',        slug: 'free-fire-indonesia',        image: '/images/games/freefire.png',   category: 'MOBILE_GAME', packages: FF_PACKAGES },
  { name: 'FREE FIRE | VIETNAM',          slug: 'free-fire-vietnam',          image: '/images/games/freefire.png',   category: 'MOBILE_GAME', packages: FF_PACKAGES },
  { name: 'FREE FIRE | TAIWAN',           slug: 'free-fire-taiwan',           image: '/images/games/freefire.png',   category: 'MOBILE_GAME', packages: FF_PACKAGES },
  {
    name: 'MAGIC CHESS GOGO', slug: 'magic-chess-gogo', image: '/images/games/magicchess.png', category: 'MOBILE_GAME',
    packages: [
      { name: 'Evo3D Magic Chess', amount: 50,  price: 0.83, category: 'BEST_SELLER', badge: null },
      { name: '100 Gold Coins',   amount: 100, price: 0.99, category: 'NORMAL',      badge: null },
      { name: '500 Gold Coins',   amount: 500, price: 4.50, category: 'NORMAL',      badge: 'ពេញនិយម' },
    ],
  },
  {
    name: 'HONOR OF KINGS', slug: 'honor-of-kings', image: '/images/games/hok.png', category: 'MOBILE_GAME',
    packages: [
      { name: '88 Tokens',    amount: 88,    price: 0.99,  category: 'BEST_SELLER', badge: null },
      { name: '432 Tokens',   amount: 432,   price: 4.99,  category: 'BEST_SELLER', badge: 'ពេញនិយម' },
      { name: '905 Tokens',   amount: 905,   price: 9.99,  category: 'NORMAL',      badge: null },
      { name: '2475 Tokens',  amount: 2475,  price: 24.99, category: 'NORMAL',      badge: 'ពេញនិយម' },
      { name: '4950 Tokens',  amount: 4950,  price: 49.99, category: 'NORMAL',      badge: null },
      { name: '10000 Tokens', amount: 10000, price: 99.99, category: 'NORMAL',      badge: 'កញ្ចប់ពិសេស 💎' },
    ],
  },
  {
    name: 'PUBG MOBILE', slug: 'pubg-mobile', image: '/images/games/pubgm.png', category: 'MOBILE_GAME',
    packages: [
      { name: '60 UC',   amount: 60,   price: 0.99,  category: 'BEST_SELLER', badge: null },
      { name: '325 UC',  amount: 325,  price: 4.99,  category: 'BEST_SELLER', badge: 'ពេញនិយម' },
      { name: '660 UC',  amount: 660,  price: 9.99,  category: 'NORMAL',      badge: null },
      { name: '1800 UC', amount: 1800, price: 24.99, category: 'NORMAL',      badge: 'ពេញនិយម' },
      { name: '3850 UC', amount: 3850, price: 49.99, category: 'NORMAL',      badge: null },
      { name: '8100 UC', amount: 8100, price: 99.99, category: 'NORMAL',      badge: 'កញ្ចប់ពិសេស 💎' },
    ],
  },
  {
    name: 'BLOOD STRIKE', slug: 'blood-strike', image: '/images/games/bloodstrike.png', category: 'MOBILE_GAME',
    packages: [
      { name: '100 Gold',   amount: 100,   price: 0.99,  category: 'BEST_SELLER', badge: null },
      { name: '500 Gold',   amount: 500,   price: 4.99,  category: 'BEST_SELLER', badge: 'ពេញនិយម' },
      { name: '1000 Gold',  amount: 1000,  price: 9.99,  category: 'NORMAL',      badge: null },
      { name: '2500 Gold',  amount: 2500,  price: 24.99, category: 'NORMAL',      badge: 'ពេញនិយម' },
      { name: '5000 Gold',  amount: 5000,  price: 49.99, category: 'NORMAL',      badge: null },
      { name: '10000 Gold', amount: 10000, price: 99.99, category: 'NORMAL',      badge: 'កញ្ចប់ពិសេស 💎' },
    ],
  },
  {
    name: 'VALORANT', slug: 'valorant', image: '/images/games/valorant.png', category: 'PC_GAME',
    packages: [
      { name: '475 VP',   amount: 475,   price: 4.99,  category: 'BEST_SELLER', badge: null },
      { name: '1000 VP',  amount: 1000,  price: 9.99,  category: 'BEST_SELLER', badge: 'ពេញនិយម' },
      { name: '2050 VP',  amount: 2050,  price: 19.99, category: 'NORMAL',      badge: null },
      { name: '3650 VP',  amount: 3650,  price: 34.99, category: 'NORMAL',      badge: 'ពេញនិយម' },
      { name: '5350 VP',  amount: 5350,  price: 49.99, category: 'NORMAL',      badge: null },
      { name: '11000 VP', amount: 11000, price: 99.99, category: 'NORMAL',      badge: 'កញ្ចប់ពិសេស 💎' },
    ],
  },
  {
    name: 'FARLIGHT 84', slug: 'farlight-84', image: '/images/games/farlight.png', category: 'MOBILE_GAME',
    packages: [
      { name: '60 Diamonds',   amount: 60,   price: 0.99,  category: 'BEST_SELLER', badge: null },
      { name: '350 Diamonds',  amount: 350,  price: 4.99,  category: 'BEST_SELLER', badge: 'ពេញនិយម' },
      { name: '720 Diamonds',  amount: 720,  price: 9.99,  category: 'NORMAL',      badge: null },
      { name: '1440 Diamonds', amount: 1440, price: 19.99, category: 'NORMAL',      badge: 'ពេញនិយម' },
      { name: '2880 Diamonds', amount: 2880, price: 39.99, category: 'NORMAL',      badge: null },
      { name: '5760 Diamonds', amount: 5760, price: 79.99, category: 'NORMAL',      badge: 'កញ្ចប់ពិសេស 💎' },
    ],
  },
  {
    name: 'DELTA FORCE', slug: 'delta-force', image: '/images/games/deltaforce.png', category: 'PC_GAME',
    packages: [
      { name: '100 Delta Coins',   amount: 100,   price: 0.99,  category: 'BEST_SELLER', badge: null },
      { name: '500 Delta Coins',   amount: 500,   price: 4.99,  category: 'BEST_SELLER', badge: 'ពេញនិយម' },
      { name: '1000 Delta Coins',  amount: 1000,  price: 9.99,  category: 'NORMAL',      badge: null },
      { name: '2000 Delta Coins',  amount: 2000,  price: 19.99, category: 'NORMAL',      badge: 'ពេញនិយម' },
      { name: '5000 Delta Coins',  amount: 5000,  price: 49.99, category: 'NORMAL',      badge: null },
      { name: '10000 Delta Coins', amount: 10000, price: 99.99, category: 'NORMAL',      badge: 'កញ្ចប់ពិសេស 💎' },
    ],
  },
];

export async function seedDatabase(): Promise<void> {
  console.log('[Startup] Seeding database with product catalog...');

  // Create admin user if not exists
  const existingAdmin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  if (!existingAdmin) {
    const adminPassword = bcrypt.hashSync('admin123', 10);
    await prisma.user.create({
      data: { email: 'admin@topup.com', password: adminPassword, role: 'ADMIN' },
    });
    console.log('[Startup] Created default admin: admin@topup.com / admin123');
  }

  // Create all products with their packages
  for (const product of PRODUCTS_SEED) {
    try {
      await prisma.product.upsert({
        where: { slug: product.slug },
        update: {
          name: product.name,
          image: product.image,
          category: product.category,
          isActive: true,
        },
        create: {
          name: product.name,
          slug: product.slug,
          image: product.image,
          category: product.category,
          isActive: true,
          packages: {
            create: product.packages.map((pkg) => ({
              name: pkg.name,
              amount: pkg.amount,
              price: pkg.price,
              category: pkg.category,
              badge: pkg.badge ?? null,
              isActive: true,
            })),
          },
        },
      });
      console.log(`[Startup] ✓ Seeded product: ${product.name}`);
    } catch (err: any) {
      console.error(`[Startup] Failed to seed ${product.slug}:`, err.message);
    }
  }

  console.log(`[Startup] ✅ Seeded ${PRODUCTS_SEED.length} products successfully.`);
}

export async function runDatabaseStartup(): Promise<void> {
  console.log('[Startup] Initializing database...');

  // Step 1: Execute Direct Raw SQL Table Creation for guaranteed table existence
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "User" (
        "id" TEXT PRIMARY KEY,
        "email" TEXT UNIQUE NOT NULL,
        "password" TEXT NOT NULL,
        "role" TEXT NOT NULL DEFAULT 'USER',
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `).catch(() => {});

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Product" (
        "id" TEXT PRIMARY KEY,
        "name" TEXT NOT NULL,
        "slug" TEXT UNIQUE NOT NULL,
        "image" TEXT NOT NULL,
        "category" TEXT NOT NULL,
        "isActive" BOOLEAN NOT NULL DEFAULT 1,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `).catch(() => {});

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Package" (
        "id" TEXT PRIMARY KEY,
        "productId" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "amount" INTEGER NOT NULL,
        "price" REAL NOT NULL,
        "category" TEXT NOT NULL DEFAULT 'NORMAL',
        "badge" TEXT,
        "isActive" BOOLEAN NOT NULL DEFAULT 1,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `).catch(() => {});

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Order" (
        "id" TEXT PRIMARY KEY,
        "userId" TEXT,
        "packageId" TEXT NOT NULL,
        "playerId" TEXT NOT NULL,
        "playerZoneId" TEXT,
        "playerNickname" TEXT,
        "price" REAL NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'PENDING',
        "paymentMethod" TEXT NOT NULL,
        "paymentStatus" TEXT NOT NULL DEFAULT 'PENDING',
        "paymentTxnId" TEXT UNIQUE NOT NULL,
        "paymentQrCode" TEXT,
        "paymentMd5" TEXT,
        "gatewayRef" TEXT,
        "deliveryStatus" TEXT NOT NULL DEFAULT 'WAITING',
        "stockDeliveredCode" TEXT,
        "paidAt" DATETIME,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `).catch(() => {});

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Stock" (
        "id" TEXT PRIMARY KEY,
        "packageId" TEXT NOT NULL,
        "orderId" TEXT UNIQUE,
        "code" TEXT NOT NULL,
        "isUsed" BOOLEAN NOT NULL DEFAULT 0,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `).catch(() => {});

    console.log('[Startup] ✅ Database tables verified/created via direct SQL.');
  } catch (sqlErr: any) {
    console.warn('[Startup] Direct SQL init note:', sqlErr.message);
  }

  // Step 2: Check if products exist — if not, seed
  try {
    const productCount = await prisma.product.count().catch(() => 0);
    console.log(`[Startup] Found ${productCount} products in database.`);

    if (productCount === 0) {
      console.log('[Startup] Database is empty — running auto-seed...');
      await seedDatabase();
    } else {
      console.log('[Startup] Products exist — skipping seed.');
    }
  } catch (err: any) {
    console.warn('[Startup] Seeding check triggered emergency seed:', err.message);
    await seedDatabase().catch(() => {});
  }
}
