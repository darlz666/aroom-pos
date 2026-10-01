"use client";

import { useRef, useState } from "react";
import { getStockDashboardAction } from "@/lib/inventory/actions";
import {
  card,
  control,
  dateTime,
  quantity,
  rupiah,
} from "./presentation";

export type StockDashboardResult =
  Awaited<ReturnType<typeof getStockDashboardAction>>;

type Dashboard = Extract<
  StockDashboardResult,
  { success: true }
>["dashboard"];

type Period = Dashboard["period"]["type"];

const periodOptions: {
  value: Period;
  label: string;
}[] = [
  { value: "TODAY", label: "Hari ini" },
  { value: "7D", label: "7 Hari" },
  { value: "30D", label: "30 Hari" },
  { value: "MONTH", label: "Bulan Ini" },
];

const movementLabels: Record<string, string> = {
  PURCHASE: "Stock In",
  SALE_CONSUMPTION: "Pemakaian Penjualan",
  ADJUSTMENT_IN: "Penyesuaian Masuk",
  ADJUSTMENT_OUT: "Penyesuaian Keluar",
};

const attentionLabels: Record<string, string> = {
  NEGATIVE: "Stok negatif",
  EMPTY: "Kosong",
  MISSING_COST: "Biaya belum lengkap",
  LOW: "Hampir habis",
};

function shortDate(value: string) {
  const [, month, day] = value.split("-");
  return `${day}/${month}`;
}

function isInbound(type: string) {
  return type === "PURCHASE" || type === "ADJUSTMENT_IN";
}

export function StockDashboard({
  initial,
}: {
  initial: StockDashboardResult;
}) {
  const [result, setResult] =
    useState<StockDashboardResult>(initial);

  const [period, setPeriod] = useState<Period>(
    initial.success
      ? initial.dashboard.period.type
      : "30D"
  );

  const [loading, setLoading] = useState(false);
  const requestVersion = useRef(0);

  async function load(nextPeriod: Period) {
    const version = ++requestVersion.current;

    setPeriod(nextPeriod);
    setLoading(true);

    try {
      const next = await getStockDashboardAction({
        period: nextPeriod,
      });

      if (version !== requestVersion.current) return;

      setResult(next);
    } finally {
      if (version === requestVersion.current) {
        setLoading(false);
      }
    }
  }

  if (!result.success) {
    return (
      <section className={card}>
        <h2 className="text-xl font-semibold">
          Dashboard Stok
        </h2>

        <p className="mt-2 text-sm text-[#62685c]">
          Dashboard stok belum dapat dimuat.
          Periksa koneksi atau akses Anda, lalu coba lagi.
        </p>

        <button
          type="button"
          className={`${control} mt-4 font-semibold`}
          disabled={loading}
          onClick={() => load(period)}
        >
          {loading ? "Memuat..." : "Coba lagi"}
        </button>
      </section>
    );
  }

  const dashboard = result.dashboard;
  const {
    snapshot,
    movement,
    attentionItems,
    recentMovements,
  } = dashboard;

  const periodLabel =
    periodOptions.find(
      option => option.value === period
    )?.label ?? period;

  const metrics = [
    {
      label: "Nilai Stok Bahan",
      value:
        snapshot.inventoryValue === null
          ? "—"
          : rupiah(snapshot.inventoryValue),
      helper:
        snapshot.inventoryValue === null
          ? `${snapshot.missingCostCount} bahan belum memiliki nilai biaya/WAC`
          : "Nilai persediaan saat ini",
      current: true,
    },
    {
      label: "Bahan Aktif",
      value: `${snapshot.activeIngredientCount} bahan`,
      helper: "Bahan dengan status aktif",
      current: true,
    },
    {
      label: "Bahan Kosong",
      value: `${snapshot.emptyIngredientCount} bahan`,
      helper: "Bahan aktif dengan stok 0",
      current: true,
    },
    {
      label: "Hampir Habis",
      value: `${snapshot.lowIngredientCount} bahan`,
      helper: "Stok sudah mencapai batas minimum",
      current: true,
    },
    {
      label: "Biaya Belum Lengkap",
      value: `${snapshot.missingCostCount} bahan`,
      helper:
        "Bahan dengan stok positif yang belum memiliki nilai biaya/WAC",
      current: true,
    },
    {
      label: "Stok Masuk",
      value: `${movement.stockInMovementCount} aktivitas`,
      helper: periodLabel,
      current: false,
    },
    {
      label: "Stok Keluar",
      value: `${movement.stockOutMovementCount} aktivitas`,
      helper: periodLabel,
      current: false,
    },
  ];

  const maxMovement = Math.max(
    1,
    ...movement.series.flatMap(row => [
      row.stockIn,
      row.stockOut,
    ])
  );

  return (
    <div className="space-y-6">
      <section className={card}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[#62685c]">
              Ringkasan Persediaan
            </p>

            <h2 className="mt-1 text-2xl font-semibold">
              Dashboard Stok
            </h2>

            <p className="mt-1 max-w-2xl text-sm text-[#62685c]">
              Pantau kondisi persediaan dan pergerakan
              bahan AROOM.
            </p>
          </div>

          <button
            type="button"
            className={`${control} font-semibold`}
            disabled={loading}
            onClick={() => load(period)}
          >
            {loading ? "Memuat..." : "Muat ulang"}
          </button>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {periodOptions.map(option => (
            <button
              type="button"
              key={option.value}
              disabled={loading}
              aria-pressed={period === option.value}
              onClick={() => load(option.value)}
              className={`${control} min-h-11 px-4 py-2 text-sm font-semibold ${
                period === option.value
                  ? "border-[#344631] bg-[#344631] text-white"
                  : "bg-[#fffefa]"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>

      {snapshot.negativeStockCount > 0 && (
        <section className="rounded-2xl border border-[#d9aa83] bg-[#fff3e7] p-5">
          <p className="font-semibold text-[#7a4421]">
            {snapshot.negativeStockCount} bahan memiliki
            stok negatif dan perlu diperiksa.
          </p>

          <p className="mt-1 text-sm text-[#785d49]">
            Sistem tidak mengubah atau menutupi nilai
            tersebut secara otomatis.
          </p>
        </section>
      )}

      <section
        aria-label="Ringkasan stok"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        {metrics.map(metric => (
          <article
            key={metric.label}
            className="rounded-2xl border border-[#dedfd5] bg-[#fffefa] p-5"
          >
            <div className="flex min-h-6 items-start justify-between gap-3">
              <p className="text-sm font-semibold text-[#62685c]">
                {metric.label}
              </p>

              {metric.current && (
                <span className="rounded-full bg-[#edf0e8] px-2 py-1 text-[11px] font-semibold text-[#62685c]">
                  Saat ini
                </span>
              )}
            </div>

            <p className="mt-4 break-words text-2xl font-semibold tracking-tight sm:text-3xl">
              {metric.value}
            </p>

            <p className="mt-2 text-sm leading-5 text-[#777d71]">
              {metric.helper}
            </p>
          </article>
        ))}
      </section>

      <section className={card}>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 className="text-xl font-semibold">
              Pergerakan Stok
            </h3>

            <p className="mt-1 text-sm text-[#62685c]">
              Jumlah aktivitas masuk dan keluar per hari.
              Kuantitas berbeda satuan tidak dijumlahkan.
            </p>
          </div>

          <p className="text-sm font-medium text-[#62685c]">
            {periodLabel}
          </p>
        </div>

        {movement.series.every(
          row =>
            row.stockIn === 0 &&
            row.stockOut === 0
        ) ? (
          <div className="mt-5 rounded-xl border border-dashed border-[#cfd2c7] p-6 text-sm text-[#62685c]">
            Belum ada pergerakan stok pada periode ini.
          </div>
        ) : (
          <div className="mt-6 overflow-x-auto pb-2">
            <div
              className="flex h-48 items-end gap-2"
              style={{
                minWidth: `${Math.max(
                  520,
                  movement.series.length * 42
                )}px`,
              }}
            >
              {movement.series.map(row => (
                <div
                  key={row.date}
                  className="flex min-w-8 flex-1 flex-col items-center"
                >
                  <div className="flex h-32 w-full items-end justify-center gap-1">
                    <div
                      title={`Masuk ${row.stockIn}`}
                      className="w-2/5 rounded-t bg-[#6f8a68]"
                      style={{
                        height:
                          row.stockIn === 0
                            ? "2px"
                            : `${Math.max(
                                8,
                                (row.stockIn /
                                  maxMovement) *
                                  100
                              )}%`,
                      }}
                    />

                    <div
                      title={`Keluar ${row.stockOut}`}
                      className="w-2/5 rounded-t bg-[#b78868]"
                      style={{
                        height:
                          row.stockOut === 0
                            ? "2px"
                            : `${Math.max(
                                8,
                                (row.stockOut /
                                  maxMovement) *
                                  100
                              )}%`,
                      }}
                    />
                  </div>

                  <span className="mt-2 text-[11px] text-[#72776d]">
                    {shortDate(row.date)}
                  </span>
                </div>
              ))}
            </div>

            <div className="mt-4 flex gap-5 text-xs font-medium text-[#62685c]">
              <span className="inline-flex items-center gap-2">
                <span className="h-3 w-3 rounded-sm bg-[#6f8a68]" />
                Stok Masuk
              </span>

              <span className="inline-flex items-center gap-2">
                <span className="h-3 w-3 rounded-sm bg-[#b78868]" />
                Stok Keluar
              </span>
            </div>
          </div>
        )}
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <section className={card}>
          <div>
            <h3 className="text-xl font-semibold">
              Bahan Perlu Perhatian
            </h3>

            <p className="mt-1 text-sm text-[#62685c]">
              Prioritas berdasarkan stok dan kelengkapan
              biaya saat ini.
            </p>
          </div>

          {attentionItems.length === 0 ? (
            <div className="mt-5 rounded-xl border border-dashed border-[#cfd2c7] p-6 text-sm text-[#62685c]">
              Tidak ada bahan yang memerlukan perhatian
              saat ini.
            </div>
          ) : (
            <div className="mt-5 divide-y divide-[#e3e4db]">
              {attentionItems.map(item => (
                <div
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="font-semibold">
                      {item.name}
                    </p>

                    <p className="mt-1 text-sm text-[#62685c]">
                      {quantity(item.currentStock)}{" "}
                      {item.baseUnit}
                      {item.status === "LOW" &&
                        ` · Minimum ${quantity(
                          item.minimumStock
                        )} ${item.baseUnit}`}
                    </p>
                  </div>

                  <span
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${
                      item.status === "NEGATIVE"
                        ? "bg-[#f8dfd8] text-[#8a3526]"
                        : item.status === "EMPTY"
                          ? "bg-[#f3e6dc] text-[#855437]"
                          : item.status ===
                              "MISSING_COST"
                            ? "bg-[#eee8d2] text-[#6f642d]"
                            : "bg-[#e8ecdf] text-[#53634b]"
                    }`}
                  >
                    {attentionLabels[item.status]}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className={card}>
          <div>
            <h3 className="text-xl font-semibold">
              Pergerakan Terbaru
            </h3>

            <p className="mt-1 text-sm text-[#62685c]">
              Aktivitas stok terbaru pada periode{" "}
              {periodLabel.toLowerCase()}.
            </p>
          </div>

          {recentMovements.length === 0 ? (
            <div className="mt-5 rounded-xl border border-dashed border-[#cfd2c7] p-6 text-sm text-[#62685c]">
              Belum ada pergerakan stok pada periode ini.
            </div>
          ) : (
            <div className="mt-5 divide-y divide-[#e3e4db]">
              {recentMovements.map(row => {
                const inbound = isInbound(row.type);

                return (
                  <div
                    key={row.id}
                    className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0"
                  >
                    <div className="flex min-w-0 gap-3">
                      <span
                        aria-hidden="true"
                        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                          inbound
                            ? "bg-[#e7eee4] text-[#4c6c47]"
                            : "bg-[#f3e7df] text-[#895a3c]"
                        }`}
                      >
                        {inbound ? "↓" : "↑"}
                      </span>

                      <div className="min-w-0">
                        <p className="truncate font-semibold">
                          {row.ingredientName}
                        </p>

                        <p className="mt-1 text-sm text-[#62685c]">
                          {movementLabels[row.type] ??
                            row.type}
                        </p>

                        <p className="mt-1 text-xs text-[#858a80]">
                          {dateTime(row.createdAt)}
                          {row.actorName
                            ? ` · ${row.actorName}`
                            : ""}
                        </p>
                      </div>
                    </div>

                    <p
                      className={`shrink-0 text-sm font-semibold ${
                        inbound
                          ? "text-[#4d7048]"
                          : "text-[#87573a]"
                      }`}
                    >
                      {inbound ? "+" : "-"}
                      {quantity(row.quantity)}{" "}
                      {row.baseUnit}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}