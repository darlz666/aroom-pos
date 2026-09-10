import type { Prisma } from "../src/generated/prisma/client";

// Confirmed AROOM menu. Keep IDs stable even when names or prices change.
// Reuse the initial sample IDs to avoid leaving extra sample rows.
// IDs 103 and 105 replace Kopi Susu Aren and Lemon Tea respectively.
export const categories = [
  {
    id: "a2000000-0000-4000-8000-000000000001",
    name: "Signature",
    displayOrder: 1,
    active: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000002",
    name: "Americano Series",
    displayOrder: 2,
    active: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000003",
    name: "Coffee & Drinks",
    displayOrder: 3,
    active: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000004",
    name: "Food & Snacks",
    displayOrder: 4,
    active: true,
  },
] satisfies Prisma.CategoryCreateManyInput[];

export const products = [
  {
    id: "a2000000-0000-4000-8000-000000000103",
    categoryId: "a2000000-0000-4000-8000-000000000001", // Signature
    name: "Aroom Singleshot",
    price: 22000,
    active: true,
    available: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000107",
    categoryId: "a2000000-0000-4000-8000-000000000001", // Signature
    name: "Aroom Doubleshot",
    price: 25000,
    active: true,
    available: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000108",
    categoryId: "a2000000-0000-4000-8000-000000000001", // Signature
    name: "Aroom (Oatmilk) Singleshot",
    price: 25000,
    active: true,
    available: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000109",
    categoryId: "a2000000-0000-4000-8000-000000000001", // Signature
    name: "Aroom (Oatmilk) Doubleshot",
    price: 28000,
    active: true,
    available: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000110",
    categoryId: "a2000000-0000-4000-8000-000000000001", // Signature
    name: "Aroomsbrew",
    price: 25000,
    active: true,
    available: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000101",
    categoryId: "a2000000-0000-4000-8000-000000000002", // Americano Series
    name: "Americano",
    price: 20000,
    active: true,
    available: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000111",
    categoryId: "a2000000-0000-4000-8000-000000000002", // Americano Series
    name: "Americano Cranberry",
    price: 25000,
    active: true,
    available: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000112",
    categoryId: "a2000000-0000-4000-8000-000000000002", // Americano Series
    name: "Americano Mixberry",
    price: 28000,
    active: true,
    available: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000102",
    categoryId: "a2000000-0000-4000-8000-000000000003", // Coffee & Drinks
    name: "Cafe Latte",
    price: 20000,
    active: true,
    available: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000113",
    categoryId: "a2000000-0000-4000-8000-000000000003", // Coffee & Drinks
    name: "Hazelnut",
    price: 22000,
    active: true,
    available: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000114",
    categoryId: "a2000000-0000-4000-8000-000000000003", // Coffee & Drinks
    name: "Matcha Latte",
    price: 25000,
    active: true,
    available: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000115",
    categoryId: "a2000000-0000-4000-8000-000000000003", // Coffee & Drinks
    name: "Matcha Latte (almond)",
    price: 28000,
    active: true,
    available: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000104",
    categoryId: "a2000000-0000-4000-8000-000000000003", // Coffee & Drinks
    name: "Chocolate",
    price: 20000,
    active: true,
    available: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000116",
    categoryId: "a2000000-0000-4000-8000-000000000003", // Coffee & Drinks
    name: "Strawberry Milk",
    price: 23000,
    active: true,
    available: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000105",
    categoryId: "a2000000-0000-4000-8000-000000000003", // Coffee & Drinks
    name: "Lychee Tea",
    price: 15000,
    active: true,
    available: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000117",
    categoryId: "a2000000-0000-4000-8000-000000000003", // Coffee & Drinks
    name: "Air Mineral",
    price: 5000,
    active: true,
    available: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000118",
    categoryId: "a2000000-0000-4000-8000-000000000003", // Coffee & Drinks
    name: "Matcha Coconut Cloud",
    price: 30000,
    active: true,
    available: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000119",
    categoryId: "a2000000-0000-4000-8000-000000000003", // Coffee & Drinks
    name: "V60",
    price: 30000,
    active: true,
    available: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000106",
    categoryId: "a2000000-0000-4000-8000-000000000004", // Food & Snacks
    name: "French Fries",
    price: 16000,
    active: true,
    available: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000120",
    categoryId: "a2000000-0000-4000-8000-000000000004", // Food & Snacks
    name: "Enoki Crispy",
    price: 18000,
    active: true,
    available: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000121",
    categoryId: "a2000000-0000-4000-8000-000000000004", // Food & Snacks
    name: "Katsu Don",
    price: 20000,
    active: true,
    available: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000122",
    categoryId: "a2000000-0000-4000-8000-000000000004", // Food & Snacks
    name: "Kentang Sosis",
    price: 20000,
    active: true,
    available: true,
  },
  {
    id: "a2000000-0000-4000-8000-000000000123",
    categoryId: "a2000000-0000-4000-8000-000000000004", // Food & Snacks
    name: "Poffertjes",
    price: 16000,
    active: true,
    available: true,
  },
] satisfies Prisma.ProductCreateManyInput[];

export async function seedMenu(tx: Prisma.TransactionClient) {
  // Restore menu fields by primary key, categories before products.
  // The caller owns the transaction; historical order snapshots are untouched.
  for (const { id, ...data } of categories) {
    await tx.category.upsert({
      where: { id },
      create: { id, ...data },
      update: data,
    });
  }
  for (const { id, ...data } of products) {
    await tx.product.upsert({
      where: { id },
      create: { id, ...data },
      update: data,
    });
  }
  return { categories: categories.length, products: products.length };
}
