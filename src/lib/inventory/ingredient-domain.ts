import { canonicalUnit, inventoryObject, name } from "./domain";

export function ingredientMasterInput(input: unknown) {
  const raw = inventoryObject(input, ["name", "baseUnit"]);

  return {
    name: name(raw.name),
    baseUnit: canonicalUnit(raw.baseUnit),
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
