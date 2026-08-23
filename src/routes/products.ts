import { Router, Request, Response } from 'express';
import prisma from '../prisma';
import { authenticateJWT, requireAdmin, AuthenticatedRequest } from '../middleware/auth';
import { lookupPlayerNickname } from '../utils/gameProviderMock';

const router = Router();

import { PRODUCTS_SEED, seedDatabase } from '../utils/startup';

// 1. Get all products with active packages (Public)
router.get('/', async (req: Request, res: Response) => {
  try {
    const products = await prisma.product.findMany({
      where: { isActive: true },
      include: {
        packages: {
          where: { isActive: true },
          orderBy: { price: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
    });
    if (products && products.length > 0) {
      return res.status(200).json(products);
    }
  } catch (error: any) {
    console.warn("[Products API] Database query warning, using fallback catalog:", error.message);
  }

  // Trigger background seed attempt
  seedDatabase().catch(() => {});

  // Return formatted seed catalog with IDs
  const fallbackCatalog = PRODUCTS_SEED.map((p, idx) => ({
    id: `prod_${p.slug}`,
    name: p.name,
    slug: p.slug,
    image: p.image,
    category: p.category,
    isActive: true,
    packages: p.packages.map((pkg, pidx) => ({
      id: `pkg_${p.slug}_${pidx}`,
      productId: `prod_${p.slug}`,
      name: pkg.name,
      amount: pkg.amount,
      price: pkg.price,
      category: pkg.category,
      badge: pkg.badge || null,
      isActive: true,
    })),
  }));

  return res.status(200).json(fallbackCatalog);
});


// 2. Lookup Player Nickname by Game and Player ID (Public)
// IMPORTANT: This route MUST be before /:slug to avoid Express matching 'lookup' as a slug.
router.get('/lookup/:gameSlug', async (req: Request, res: Response) => {
  try {
    const { gameSlug } = req.params;
    const playerId = req.query.playerId as string;
    const playerZoneId = req.query.playerZoneId as string;

    if (!playerId) {
      return res.status(400).json({ error: 'Player ID is required' });
    }

    const result = await lookupPlayerNickname(gameSlug, playerId, playerZoneId);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    return res.status(200).json({ nickname: result.nickname });
  } catch (error) {
    console.error('Nickname lookup error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 3. Get specific product by slug (Public)
router.get('/:slug', async (req: Request, res: Response) => {
  const { slug } = req.params;

  try {
    const product = await prisma.product.findUnique({
      where: { slug },
      include: {
        packages: {
          where: { isActive: true },
          orderBy: { price: 'asc' },
        },
      },
    });

    if (product) {
      return res.status(200).json(product);
    }
  } catch (error: any) {
    console.warn(`[Products API] Database query warning for ${slug}:`, error.message);
  }

  const seed = PRODUCTS_SEED.find((p) => p.slug === slug);
  if (seed) {
    return res.status(200).json({
      id: `prod_${seed.slug}`,
      name: seed.name,
      slug: seed.slug,
      image: seed.image,
      category: seed.category,
      isActive: true,
      packages: seed.packages.map((pkg, pidx) => ({
        id: `pkg_${seed.slug}_${pidx}`,
        productId: `prod_${seed.slug}`,
        name: pkg.name,
        amount: pkg.amount,
        price: pkg.price,
        category: pkg.category,
        badge: pkg.badge || null,
        isActive: true,
      })),
    });
  }

  return res.status(404).json({ error: 'Product not found' });
});

// ADMIN ONLY CRUD ROUTES BELOW
// 4. Create Product
router.post('/', authenticateJWT, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, slug, image, category, isActive } = req.body;
    if (!name || !slug || !image || !category) {
      return res.status(400).json({ error: 'Required fields missing' });
    }

    const product = await prisma.product.create({
      data: {
        name,
        slug,
        image,
        category,
        isActive: isActive !== undefined ? isActive : true,
      },
    });

    return res.status(201).json(product);
  } catch (error: any) {
    console.error('Error creating product:', error);
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Product slug already exists' });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 5. Update Product
router.put('/:id', authenticateJWT, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { name, slug, image, category, isActive } = req.body;

    const product = await prisma.product.update({
      where: { id },
      data: { name, slug, image, category, isActive },
    });

    return res.status(200).json(product);
  } catch (error) {
    console.error('Error updating product:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 6. Delete Product
router.delete('/:id', authenticateJWT, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.product.delete({
      where: { id },
    });
    return res.status(200).json({ message: 'Product deleted successfully' });
  } catch (error) {
    console.error('Error deleting product:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 7. Add Package to Product
router.post('/:productId/packages', authenticateJWT, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { productId } = req.params;
    const { name, amount, price, isActive } = req.body;

    if (!name || amount === undefined || price === undefined) {
      return res.status(400).json({ error: 'Required fields missing' });
    }

    const newPackage = await prisma.package.create({
      data: {
        productId,
        name,
        amount: parseInt(amount),
        price: parseFloat(price),
        isActive: isActive !== undefined ? isActive : true,
      },
    });

    return res.status(201).json(newPackage);
  } catch (error) {
    console.error('Error creating package:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 8. Update Package
router.put('/packages/:packageId', authenticateJWT, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { packageId } = req.params;
    const { name, amount, price, isActive } = req.body;

    const updatedPackage = await prisma.package.update({
      where: { id: packageId },
      data: {
        name,
        amount: amount !== undefined ? parseInt(amount) : undefined,
        price: price !== undefined ? parseFloat(price) : undefined,
        isActive,
      },
    });

    return res.status(200).json(updatedPackage);
  } catch (error) {
    console.error('Error updating package:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 9. Delete Package
router.delete('/packages/:packageId', authenticateJWT, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { packageId } = req.params;
    await prisma.package.delete({
      where: { id: packageId },
    });
    return res.status(200).json({ message: 'Package deleted successfully' });
  } catch (error) {
    console.error('Error deleting package:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
