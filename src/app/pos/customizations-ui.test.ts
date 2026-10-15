import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CupCustomizationEditor } from "./cup-customizations";
import { defaultCup, type CupCustomization } from "../../lib/orders/customizations";

type Element = ReactElement<{ children?: ReactNode; [key: string]: unknown }>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
const cups: CupCustomization[] = [defaultCup(), { sugar: "NO_SUGAR", ice: "NO_ICE", cup: "LARGE", notes: "Meja 4" }];
test("per-cup inputs show each saved choice with large controls and escaped notes", () => {
  const html = renderToStaticMarkup(createElement(CupCustomizationEditor, {
    cups: [cups[0], { ...cups[1], notes: "<script>" }], idPrefix: "drink", disabled: false, onChange() {},
  }));
  for (const text of ["Gelas 1", "Gelas 2", "NO SUGAR", "NO ICE", "LARGE", "min-h-12", "&lt;script&gt;"]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<script>/);
});
test("all readable selector labels retain their saved option values and affect only the selected cup", () => {
  let updated: CupCustomization[] | undefined;
  const original = structuredClone(cups);
  const tree = CupCustomizationEditor({ cups: original, idPrefix: "drink", disabled: false, onChange(value) { updated = value; } });
  const nodes = elements(tree);
  for (const [name, field, options] of [
    ["Sugar", "sugar", [["NORMAL", "NORMAL"], ["LESS", "LESS"], ["NO_SUGAR", "NO SUGAR"]]],
    ["Ice", "ice", [["NORMAL", "NORMAL"], ["LESS", "LESS"], ["NO_ICE", "NO ICE"]]],
    ["Cup", "cup", [["REGULAR", "REGULAR"], ["LARGE", "LARGE"]]],
  ] as const) {
    for (let cup = 1; cup <= cups.length; cup++) {
      const select = nodes.find(element => element.props["aria-label"] === `${name} gelas ${cup}`)!;
      assert.deepEqual(elements(select.props.children).map(option => [option.props.value, option.props.children]), options);
      for (const [value] of options) {
        (select.props.onChange as (event: unknown) => void)({ target: { value } });
        assert.deepEqual(updated?.[cup - 1], { ...original[cup - 1], [field]: value });
        assert.deepEqual(updated?.[cup === 1 ? 1 : 0], original[cup === 1 ? 1 : 0]);
      }
    }
  }
  assert.deepEqual(original, cups);
});
test("changing a cup field preserves other units without mutating the input", () => {
  let updated: CupCustomization[] | undefined;
  const original = structuredClone(cups);
  const tree = CupCustomizationEditor({ cups: original, idPrefix: "drink", disabled: false, onChange(value) { updated = value; } });
  const sugar = elements(tree).find(element => element.props["aria-label"] === "Sugar gelas 2")!;
  (sugar.props.onChange as (event: unknown) => void)({ target: { value: "LESS" } });
  assert.equal(updated?.[1].sugar, "LESS");
  assert.deepEqual(updated?.[0], original[0]);
  assert.deepEqual(original, cups);
});
test("disabled inputs reject stale change handlers", () => {
  let changes = 0;
  const tree = CupCustomizationEditor({ cups, idPrefix: "drink", disabled: true, onChange() { changes++; } });
  const controls = elements(tree).filter(element => element.type === "input" || element.type === "select");
  for (const control of controls) {
    assert.equal(control.props.disabled, true);
    (control.props.onChange as (event: unknown) => void)({ target: { value: "LESS" } });
  }
  assert.equal(changes, 0);
});
