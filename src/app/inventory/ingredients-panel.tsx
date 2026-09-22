"use client";

import {
  createIngredientAction,
  updateIngredientAction,
} from "@/lib/inventory/actions";

import {
  card,
  control,
  primary,
  readError,
  type IngredientsResult,
} from "./presentation";

export function IngredientsPanel({
  result,
  loading,
  reload,
  onWriting,
  onSaved,
}: {
  result: IngredientsResult;
  loading: boolean;
  reload: () => Promise<void>;
  onWriting: (busy: boolean) => void;
  onSaved: (ingredient: any) => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-semibold">
          Master Bahan
        </h2>
        <p className="text-[#62685c]">
          Kelola daftar bahan untuk Stock In dan resep.
        </p>
      </div>
    </div>
  );
}