/** Id and enum schemas shared by the catalog, the action allowlist and the trusted text keys. */
import { z } from 'zod';
import { CATEGORIES, PRODUCTS } from '@/lib/catalog';

const ids = PRODUCTS.map((p) => p.id) as [string, ...string[]];
export const ProductIdSchema = z.enum(ids);
export const CategorySchema = z.enum(CATEGORIES as [string, ...string[]]);
export const OrderIdSchema = z.string().regex(/^ord_[A-Za-z0-9_-]{16}$/);
