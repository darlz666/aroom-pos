import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { categoryInput } from "./domain";

test("category fields, identifiers and revisions reject malformed/client-authority input", () => {
  const input = { key: randomUUID(), id: null, expectedRevision: null, name: " Coffee ", displayOrder: 0, active: true };
  assert.equal(categoryInput(input).name, "Coffee");
  for (const patch of [{ name: " " }, { name: "x".repeat(129) }, { name: "bad\nname" }, { displayOrder: -1 }, { displayOrder: 0.5 },
    { displayOrder: 2147483648 }, { active: "true" }, { role: "ADMIN" }, { expectedRevision: 1 }, { id: randomUUID(), expectedRevision: null },
    { id: randomUUID(), expectedRevision: 0 }, { key: "bad" }, { delete: true }]) {
    assert.throws(() => categoryInput({ ...input, ...patch }), { code: "INVALID_INPUT" });
  }
});
