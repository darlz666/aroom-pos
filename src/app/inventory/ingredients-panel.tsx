"use client";
import { useState } from "react";
import {
  type IngredientsResult,
} from "./presentation";

import {
  card,
  control,
  primary,
  inputError,
} from "./presentation";

import {
  createIngredientAction,
} from "@/lib/inventory/actions";

const blank = {
  name: "",
  baseUnit: "pcs",
};

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
    const [fields, setFields] = useState(blank);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState<"ALL" | "ACTIVE" | "EMPTY">("ALL");
    const filteredIngredients = result.success
  ? result.ingredients.filter(ingredient => {
      const matchSearch = ingredient.name
        .toLowerCase()
        .includes(search.toLowerCase());

      const stock = Number(ingredient.currentStock);

      const matchStatus =
        statusFilter === "ALL"
          ? true
          : statusFilter === "ACTIVE"
            ? stock > 0
            : stock <= 0;

      return matchSearch && matchStatus;
    })
  : [];

  const activeCount = result.success
  ? result.ingredients.filter(
      item => Number(item.currentStock) > 0
    ).length
  : 0;

const emptyCount = result.success
  ? result.ingredients.filter(
      item => Number(item.currentStock) <= 0
    ).length
  : 0;
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-semibold">
          Master Bahan
        </h2>
        <p className="text-[#62685c]">
          Kelola daftar bahan untuk Stock In dan resep.          
        </p>
        <form
            className={`${card} space-y-5`}
            onSubmit={async (event) => {
                event.preventDefault();

                setBusy(true);
                setError("");
                setNotice("");

                const response = await createIngredientAction(fields);

                if (!response.success) {
                setError(inputError(response.code));
                setBusy(false);
                return;
                }

                setFields(blank);
                setNotice("Bahan berhasil ditambahkan.");
                await reload();
                setBusy(false);
            }}
            >
            <h3 className="text-xl font-semibold">
                Tambah bahan
            </h3>

            <label className="grid gap-3">
                Nama bahan
                <input
                className={control}
                value={fields.name}
                onChange={(event) =>
                    setFields(current => ({
                    ...current,
                    name: event.target.value,
                    }))
                }
                required
                />
            </label>

            <label className="grid gap-3">
                Satuan dasar
                <select
                className={control}
                value={fields.baseUnit}
                onChange={(event) =>
                    setFields(current => ({
                    ...current,
                    baseUnit: event.target.value,
                    }))
                }
                >
                <option value="g">Gram (g)</option>
                <option value="kg">Kilogram (kg)</option>
                <option value="ml">Milliliter (ml)</option>
                <option value="L">Liter (L)</option>
                <option value="pcs">Piece (pcs)</option>
                </select>
            </label>

            <button
              className={`${primary} mt-4`}
              disabled={busy}
            >
                {busy ? "Menyimpan..." : "Simpan bahan"}
            </button>

            {error && (
                <p role="alert">{error}</p>
            )}

            {notice && (
                <p role="status">{notice}</p>
            )}
          </form>
      </div>

      {loading ? (
        <p>Memuat bahan...</p>
      ) : !result.success ? (
        <p>Data bahan belum dapat dimuat.</p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-3">

  <input
    className={`${control} flex-1`}
    placeholder="Cari bahan..."
    value={search}
    onChange={(event) => setSearch(event.target.value)}
  />

  <button
    type="button"
    className={`${control} ${
      statusFilter === "ACTIVE"
        ? "border-[#344631] bg-[#e9eade]"
        : ""
    }`}
    onClick={() =>
      setStatusFilter(
        statusFilter === "ACTIVE" ? "ALL" : "ACTIVE"
      )
    }
  >
    Aktif {activeCount}
  </button>


  <button
    type="button"
    className={`${control} ${
      statusFilter === "EMPTY"
        ? "border-[#344631] bg-[#e9eade]"
        : ""
    }`}
    onClick={() =>
      setStatusFilter(
        statusFilter === "EMPTY" ? "ALL" : "EMPTY"
      )
    }
  >
    Kosong {emptyCount}
  </button>

</div>

          {filteredIngredients.length === 0 ? (
  <p className="text-[#62685c]">
    Bahan tidak ditemukan.
  </p>
) : (
  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
    {filteredIngredients.map(ingredient => (
      <article key={ingredient.id} className={card}>
        <h3 className="text-xl font-semibold">
          {ingredient.name}
        </h3>

        <p>
          Stok: {ingredient.currentStock} {ingredient.baseUnit}
        </p>

        <p>
          Status: {Number(ingredient.currentStock) > 0 ? "Aktif" : "Kosong"}
        </p>
      </article>
    ))}
  </div>
    )}
  </>
)}
    </div>
  );
}