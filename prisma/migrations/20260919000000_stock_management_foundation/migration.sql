BEGIN;

CREATE TYPE "InventoryUnit" AS ENUM ('g', 'kg', 'ml', 'L', 'pcs');
CREATE TYPE "StockMovementType" AS ENUM ('PURCHASE', 'SALE_CONSUMPTION', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT');

CREATE TABLE "Ingredient" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "baseUnit" "InventoryUnit" NOT NULL,
  "currentStock" DECIMAL(18,3) NOT NULL DEFAULT 0,
  "minimumStock" DECIMAL(18,3) NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "unitCost" INTEGER,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Ingredient_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Ingredient_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 128),
  CONSTRAINT "Ingredient_base_unit_check" CHECK ("baseUnit" IN ('g', 'ml', 'pcs')),
  CONSTRAINT "Ingredient_stock_check" CHECK (
    "currentStock" >= 0 AND "currentStock" < 'NaN'::numeric AND
    "minimumStock" >= 0 AND "minimumStock" < 'NaN'::numeric
  ),
  CONSTRAINT "Ingredient_unit_cost_check" CHECK ("unitCost" >= 0)
);
CREATE UNIQUE INDEX "Ingredient_name_normalized_key" ON "Ingredient" (lower(btrim("name")));
CREATE UNIQUE INDEX "Ingredient_id_baseUnit_key" ON "Ingredient" ("id", "baseUnit");

CREATE TABLE "Supplier" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "contact" TEXT,
  "phone" TEXT,
  "address" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Supplier_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 128)
);

CREATE TABLE "Recipe" (
  "id" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Recipe_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Recipe_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Recipe_productId_key" ON "Recipe" ("productId");

CREATE TABLE "RecipeItem" (
  "id" UUID NOT NULL,
  "recipeId" UUID NOT NULL,
  "ingredientId" UUID NOT NULL,
  "quantity" DECIMAL(18,3) NOT NULL,
  "unit" "InventoryUnit" NOT NULL,
  CONSTRAINT "RecipeItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RecipeItem_quantity_check" CHECK ("quantity" > 0 AND "quantity" < 'NaN'::numeric),
  CONSTRAINT "RecipeItem_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RecipeItem_ingredientId_unit_fkey" FOREIGN KEY ("ingredientId", "unit") REFERENCES "Ingredient"("id", "baseUnit") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "RecipeItem_recipeId_ingredientId_key" ON "RecipeItem" ("recipeId", "ingredientId");
CREATE INDEX "RecipeItem_ingredientId_unit_idx" ON "RecipeItem" ("ingredientId", "unit");

CREATE TABLE "StockMovement" (
  "id" UUID NOT NULL,
  "ingredientId" UUID NOT NULL,
  "type" "StockMovementType" NOT NULL,
  "quantity" DECIMAL(18,3) NOT NULL,
  "unit" "InventoryUnit" NOT NULL,
  "stockAfter" DECIMAL(18,3) NOT NULL,
  "sourceType" TEXT,
  "sourceId" UUID,
  "actorId" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StockMovement_quantity_check" CHECK ("quantity" > 0 AND "quantity" < 'NaN'::numeric),
  CONSTRAINT "StockMovement_stock_after_check" CHECK ("stockAfter" >= 0 AND "stockAfter" < 'NaN'::numeric),
  CONSTRAINT "StockMovement_source_check" CHECK (
    ("sourceType" IS NULL AND "sourceId" IS NULL) OR
    ("sourceType" IS NOT NULL AND length(btrim("sourceType")) > 0 AND "sourceId" IS NOT NULL)
  ),
  CONSTRAINT "StockMovement_ingredientId_unit_fkey" FOREIGN KEY ("ingredientId", "unit") REFERENCES "Ingredient"("id", "baseUnit") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "StockMovement_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "StockMovement_ingredientId_createdAt_idx" ON "StockMovement" ("ingredientId", "createdAt");
CREATE INDEX "StockMovement_sourceType_sourceId_idx" ON "StockMovement" ("sourceType", "sourceId");
CREATE INDEX "StockMovement_actorId_idx" ON "StockMovement" ("actorId");

-- Units cannot be reinterpreted after creation, including balances and costs.
CREATE FUNCTION protect_ingredient_base_unit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."baseUnit" IS DISTINCT FROM OLD."baseUnit" THEN
    RAISE EXCEPTION 'Ingredient base unit is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Ingredient_base_unit_immutable"
BEFORE UPDATE OF "baseUnit" ON "Ingredient"
FOR EACH ROW EXECUTE FUNCTION protect_ingredient_base_unit();

CREATE FUNCTION protect_stock_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Stock movements are append-only' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER "StockMovement_immutable"
BEFORE UPDATE OR DELETE ON "StockMovement"
FOR EACH ROW EXECUTE FUNCTION protect_stock_movement();

COMMIT;
