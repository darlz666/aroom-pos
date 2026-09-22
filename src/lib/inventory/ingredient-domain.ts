import { InventoryUnit } from "../../generated/prisma/client";
import { inventoryObject, name } from "./domain";

export function ingredientMasterInput(input: unknown) {
  const raw = inventoryObject(input, ["name", "baseUnit"]);

  if (!Object.values(InventoryUnit).includes(raw.baseUnit as InventoryUnit)) {
    throw new Error("INVALID_INPUT");
  }

  return {
    name: name(raw.name),
    baseUnit: raw.baseUnit as InventoryUnit,
  };
}

export function ingredientUpdateInput(input: unknown) {
  const raw = inventoryObject(input, ["id", "name", "active"]);

  if (typeof raw.active !== "boolean") {
    throw new Error("INVALID_INPUT");
  }

  return {
    id: raw.id,
    name: name(raw.name),
    active: raw.active,
  };
}

export function ingredientIdInput(input: unknown) {
  const raw = inventoryObject(input, ["id"]);

  return {
    id: raw.id,
  };
}
