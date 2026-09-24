"use client";

function formatMovementType(type: string) {
  if (type === "SALE_CONSUMPTION") return "Penjualan";
  if (type === "STOCK_IN") return "Stock In";
  return type;
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(date));
}

export function StockMovementHistory({
  movements,
}: {
  movements: any;
}) {
  if (!movements || !movements.success || !movements.movements?.length) {
    return (
      <div className="rounded-lg border border-[#dedfd5] bg-[#fffefa] p-4">
        Tidak ada data pergerakan stok.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[#dedfd5] bg-[#fffefa] p-4">
      <h2 className="mb-4 text-xl font-semibold">
        Pergerakan Stok
      </h2>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px] text-sm">
          <thead>
            <tr className="border-b border-[#dedfd5] text-left">
              <th className="p-3">Tanggal</th>
              <th className="p-3">Jenis</th>
              <th className="p-3">Bahan</th>
              <th className="p-3">Jumlah</th>
              <th className="p-3">Saldo</th>
              <th className="p-3">Oleh</th>
            </tr>
          </thead>

          <tbody>
            {movements.movements.map((row: any) => {
              const isOut = row.type === "SALE_CONSUMPTION";

              return (
                <tr
                  key={row.id}
                  className="border-b border-[#dedfd5]"
                >
                  <td className="p-3">
                    {formatDate(row.createdAt)}
                  </td>

                  <td className="p-3">
                    <span
                      className={
                        isOut
                          ? "rounded-full bg-red-100 px-3 py-1 text-red-700"
                          : "rounded-full bg-green-100 px-3 py-1 text-green-700"
                      }
                    >
                      {formatMovementType(row.type)}
                    </span>
                  </td>

                  <td className="p-3 font-semibold">
                    {row.ingredient.name}
                  </td>

                  <td className="p-3">
                    {isOut ? "-" : "+"}
                    {row.quantity.toString()} {row.unit}
                  </td>

                  <td className="p-3">
                    {row.stockAfter.toString()} {row.unit}
                  </td>

                  <td className="p-3">
                    {row.actor?.name ?? "-"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}