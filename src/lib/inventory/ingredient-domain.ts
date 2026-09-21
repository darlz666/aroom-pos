import { inventoryObject, name } from "./domain";

export function ingredientMasterInput(input: unknown) {
  const raw = inventoryObject(input, ["name"]);

  return {
    name: name(raw.name),
  };
}

export function ingredientUpdateInput(input: unknown) {
  const raw = inventoryObject(input, ["id", "name"]);

  return {
    id: raw.id,
    name: name(raw.name),
  };
}

export function ingredientIdInput(input: unknown) {
  const raw = inventoryObject(input, ["id"]);

  return {
    id: raw.id,
  };
}