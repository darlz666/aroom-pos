import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { seedMenu } from "./seed-menu";

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Development seed cannot run in production.");
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL must be configured for the development seed.");
  }

  // Standalone CLI: the application client uses Next.js's server-only boundary.
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    const seeded = await prisma.$transaction(seedMenu);
    console.log(`Development menu seeded: ${seeded.categories} categories and ${seeded.products} products restored/upserted.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  // Do not print provider errors that could contain connection credentials.
  console.error("Development seed failed. Use a non-production environment and check DATABASE_URL, database availability, and applied migrations.");
  process.exitCode = 1;
});
