import { test, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Order, OrderItem, Payment } from "../../src/generated/prisma/client";
import { products } from "../../prisma/seed-menu";
import { SignJWT } from "jose";

test("real cashier sale, snapshots, printing, reload and tablet acceptance", async ({ page, context }) => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost","127.0.0.1","[::1]"].includes(url.hostname));
  assert.match(url.pathname,/^\/aroom_access_test_[a-f0-9]{32}$/);
  assert.equal(url.pathname.slice(1),process.env.AROOM_BROWSER_DATABASE);
  const probe = () => JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--conditions=react-server", "tests/browser/database-probe.ts"], { env: process.env, encoding: "utf8", windowsHide: true })) as {
    database: string; orders: (Order & { items: OrderItem[]; payments: Payment[] })[];
    successfulPayments: number; stock: string; movementCount: number; snapshot: string;
    cashier: { id: string; credentialsVersion: number };
  };
  const screenshots: string[] = [], findings: unknown[] = [];
  page.on("pageerror", error => findings.push({ browserError: error.message }));
  const shot = async (name:string) => { const file=join(process.env.AROOM_BROWSER_EVIDENCE!,`${name}.png`); await page.screenshot({path:file,fullPage:true,caret:"initial"});screenshots.push(file); };
  const tap = async (name:string) => { await page.getByRole("button",{name,exact:true}).tap(); };
  try {
    assert.equal(probe().database,url.pathname.slice(1));
    await page.goto("/login"); await shot("01-login");
    await page.getByLabel("Login",{exact:true}).fill("browser-cashier");
    await page.getByLabel("Password",{exact:true}).fill(process.env.AROOM_BROWSER_PASSWORD!);
    await tap("Masuk"); await expect(page.getByLabel("Kas awal",{exact:true})).toBeVisible();
    await expect(page.getByRole("link",{name:"Admin",exact:true})).toHaveCount(0);
    await page.goto("/admin/users");await expect(page).toHaveURL(`${process.env.AROOM_BROWSER_URL}/`);
    findings.push({cashierLogin:true,directAdminRouteDenied:true});
    await page.getByLabel("Kas awal",{exact:true}).fill("100000");await tap("Buka Shift");
    await page.getByRole("link",{name:"Buka POS",exact:true}).tap();
    await expect(page.getByRole("button",{name:"Tambah Aroom Singleshot",exact:true})).toBeVisible();await shot("02-pos-landscape");
    const beverage=products.find(p=>p.name==="Aroom Singleshot")!, food=products.find(p=>p.name==="French Fries")!;
    expect(beverage.price*2+food.price).toBe(60000);
    await tap("Signature");
    await expect(page.getByRole("button",{name:"Tambah Aroom Singleshot",exact:true})).toContainText("Rp22.000");
    await expect(page.getByRole("button",{name:"Tambah French Fries",exact:true})).toHaveCount(0);
    await tap("Tambah Aroom Singleshot");await tap("Tambah jumlah Aroom Singleshot");
    await page.getByLabel("Label gelas Aroom Singleshot",{exact:true}).check();
    await page.locator("#cart summary").filter({hasText:/^Gelas 1 /}).tap();
    await page.getByLabel("Sugar gelas 1",{exact:true}).selectOption("LESS");
    await page.getByLabel("Ice gelas 1",{exact:true}).selectOption("LESS");
    await page.getByLabel("Catatan gelas 1",{exact:true}).fill("Cup one less sweet");
    await page.locator("#cart summary").filter({hasText:/^Gelas 2 /}).tap();
    await page.getByLabel("Sugar gelas 2",{exact:true}).selectOption("NO_SUGAR");
    await page.getByLabel("Ice gelas 2",{exact:true}).selectOption("NO_ICE");
    await page.getByLabel("Cup gelas 2",{exact:true}).selectOption("LARGE");
    await page.getByLabel("Catatan gelas 2",{exact:true}).fill("Cup two no ice");
    await page.getByLabel("Nama pelanggan",{exact:true}).fill("Dina Browser");
    await tap("Food & Snacks");
    await expect(page.getByRole("button",{name:"Tambah French Fries",exact:true})).toContainText("Rp16.000");
    await tap("Tambah French Fries");
    await expect(page.getByLabel("Label gelas French Fries",{exact:true})).not.toBeChecked();
    await expect(page.locator("#cart")).toContainText("Rp60.000");await shot("03-custom-order-cart");
    for(const [width,height] of [[1280,800],[1024,768],[800,1280],[768,1024],[800,700]]) {
      await page.setViewportSize({width,height});
      await page.getByLabel("Nama pelanggan",{exact:true}).scrollIntoViewIfNeeded();
      await expect(page.getByLabel("Nama pelanggan",{exact:true})).toBeVisible();
      const layout=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));
      const controls=await page.locator("#cart button").evaluateAll(nodes=>nodes.map(n=>({text:n.textContent,height:n.getBoundingClientRect().height,width:n.getBoundingClientRect().width})));
      findings.push({width,height,layout,controls,keyboardApproximation:height===700});
      expect.soft(layout.scrollWidth,`horizontal overflow at ${width}x${height}`).toBeLessThanOrEqual(width);
      expect.soft(controls.every(c=>c.height>=44),`touch height at ${width}x${height}`).toBeTruthy();
      await shot(`tablet-${width}x${height}`);
      // Check text space for every option, reserving room for the native arrow.
      // Selection cycles are restored so the saved transaction intent is unchanged.
      const selects=page.locator("#cart select");
      const sizing=await selects.evaluateAll(nodes=>nodes.map(node=>{
        const select=node as HTMLSelectElement, style=getComputedStyle(select);
        const canvas=document.createElement("canvas"),ctx=canvas.getContext("2d")!;
        ctx.font=`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        return {label:select.getAttribute("aria-label"),width:select.clientWidth,
          textSpace:select.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-24,
          options:Array.from(select.options).map(option=>({text:option.text,measuredWidth:ctx.measureText(option.text).width}))};
      }));
      for(const field of sizing) for(const option of field.options) {
        expect.soft(field.textSpace,`${field.label}: ${option.text} must fit at ${width}x${height}`).toBeGreaterThanOrEqual(option.measuredWidth);
      }
      for(const field of ["Sugar gelas 2","Ice gelas 2","Cup gelas 2"]) {
        const select=page.getByLabel(field,{exact:true}), original=await select.inputValue();
        const values=await select.locator("option").evaluateAll(options=>options.map(option=>(option as HTMLOptionElement).value));
        for(const value of values) {await select.selectOption(value);await expect(select).toHaveValue(value);}
        await select.selectOption(original);
      }
      await page.getByLabel("Sugar gelas 2",{exact:true}).scrollIntoViewIfNeeded();
      await shot(`selectors-${width}x${height}`);
      findings.push({stage:"selector-readability",width,height,sizing});
    }
    await page.setViewportSize({width:1280,height:800});
    await tap("Buat Pesanan");await shot("04-order-confirmation");
    await tap("Konfirmasi Pesanan");
    await expect(page.getByText("Pesanan berhasil dibuat",{exact:true})).toBeVisible();
    const saved=probe(); const order=saved.orders.find(o=>o.customerName==="Dina Browser")!;
    expect(order.total).toBe(60000);expect(saved.orders.length).toBe(1);
    const cups=[{sugar:"LESS",ice:"LESS",cup:"REGULAR",notes:"Cup one less sweet"},{sugar:"NO_SUGAR",ice:"NO_ICE",cup:"LARGE",notes:"Cup two no ice"}];
    expect(order.items.find(i=>i.productId===beverage.id)!.cupCustomizations).toEqual(cups);
    expect(order.items.find(i=>i.productId===food.id)!.cupCustomizations).toBeNull();
    await page.getByRole("button",{name:new RegExp(order.orderNumber)}).last().tap();
    await tap("Bayar pesanan");await expect(page.getByRole("button",{name:"QRIS (belum tersedia)",exact:true})).toBeDisabled();
    await page.getByLabel("Uang diterima (Rp)").fill("70000");
    for (const [width,height] of [[1024,768],[768,1024],[800,700]]) {
      await page.setViewportSize({width,height});
      const confirm=page.getByRole("button",{name:"Konfirmasi uang diterima",exact:true});
      await confirm.scrollIntoViewIfNeeded();await expect(confirm).toBeVisible();await expect(confirm).toBeEnabled();
      const box=await confirm.boundingBox();expect.soft(box!.height).toBeGreaterThanOrEqual(44);
      const layout=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));
      expect.soft(layout.scrollWidth).toBeLessThanOrEqual(width);
      findings.push({stage:"payment",width,height,layout,confirmHeight:box!.height});await shot(`payment-${width}x${height}`);
    }
    await page.setViewportSize({width:1280,height:800});
    // Repeat the same physical location while the original POST is in flight.
    let paymentRequests=0;
    await page.route("**/pos",async route=>{
      if(route.request().method()==="POST") {
        paymentRequests++;await new Promise(r=>setTimeout(r,1000));
        if(paymentRequests===1) {
          // Deliver the write to the real server, but drop its response.
          const response=await route.fetch();expect(response.ok()).toBeTruthy();
          await route.abort("connectionreset");return;
        }
      }
      await route.continue();
    });
    const payButton=page.getByRole("button",{name:"Konfirmasi uang diterima",exact:true});
    await payButton.scrollIntoViewIfNeeded(); const payBox=await payButton.boundingBox();assert.ok(payBox);
    await page.touchscreen.tap(payBox.x+payBox.width/2,payBox.y+payBox.height/2);
    await expect(page.getByRole("button",{name:"Memproses...",exact:true})).toBeDisabled();
    await page.touchscreen.tap(payBox.x+payBox.width/2,payBox.y+payBox.height/2);
    await expect(page.getByRole("button",{name:"Periksa pembayaran yang sama",exact:true})).toBeVisible();
    expect(paymentRequests).toBe(1);expect(probe().successfulPayments).toBe(1);
    await shot("payment-lost-response");
    await tap("Periksa pembayaran yang sama");
    await expect(page.getByText(/Pembayaran berhasil/)).toBeVisible();await page.unroute("**/pos");await shot("05-cash-completed");
    expect(paymentRequests).toBe(2);findings.push({duplicatePaymentTaps:2,initialPaymentRequests:1,lostResponseAfterServerCommit:true,explicitRetryRequests:1,successfulPayments:probe().successfulPayments});
    const paid=probe(); expect(paid.successfulPayments).toBe(1);
    expect(paid.stock).toBe("750");expect(paid.movementCount).toBe(1);
    const snapshot=async()=>probe().snapshot;
    const before=await snapshot();
    await tap("Lihat Struk");await expect(page.getByLabel("Pratinjau struk 58 mm",{exact:true})).toContainText("Dina Browser");
    await page.getByLabel("Pratinjau struk 58 mm",{exact:true}).scrollIntoViewIfNeeded();await shot("06-receipt-preview");
    await expect(page.getByRole("article",{name:/Label cup/})).toHaveCount(2);
    await expect(page.getByLabel("Pratinjau label cup 2",{exact:true})).toContainText("NO SUGAR");
    await page.getByLabel("Pratinjau label cup 2",{exact:true}).scrollIntoViewIfNeeded();await shot("07-cup-label-preview");
    for (const [width,height] of [[1024,768],[768,1024]]) {
      await page.setViewportSize({width,height});
      await page.getByLabel("Pratinjau struk 58 mm",{exact:true}).scrollIntoViewIfNeeded();
      await expect(page.getByLabel("Pratinjau struk 58 mm",{exact:true})).toBeVisible();await shot(`receipt-${width}x${height}`);
      await page.getByLabel("Pratinjau label cup 2",{exact:true}).scrollIntoViewIfNeeded();
      await expect(page.getByRole("button",{name:"Simulasikan Label Cup 2",exact:true})).toBeEnabled();await shot(`labels-${width}x${height}`);
      const layout=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));
      expect.soft(layout.scrollWidth).toBeLessThanOrEqual(width);findings.push({stage:"previews",width,height,layout});
    }
    await page.setViewportSize({width:1280,height:800});
    await tap("Simulasikan Struk");await tap("Simulasikan Label Cup 1");await tap("Simulasikan Label Cup 2");
    await expect(page.getByText(/Belum dicetak secara fisik/)).toHaveCount(3);await shot("08-print-simulations");
    expect(await snapshot()).toBe(before);
    await page.goto("/orders");await page.getByRole("button",{name:`Lihat ${order.orderNumber}`,exact:true}).tap();
    const details=page.getByLabel("Detail riwayat pesanan",{exact:true});
    await expect(details).toContainText("Rp60.000");await expect(details).toContainText("Pelanggan: Dina Browser");
    const cupDetails=details.getByRole("list",{name:"Gelas tersimpan Aroom Singleshot",exact:true}).getByRole("listitem");
    await expect(cupDetails).toHaveCount(2);
    await expect(cupDetails.nth(0).locator("dt")).toHaveText(["Sugar","Ice","Cup Size","Catatan"]);
    await expect(cupDetails.nth(0).locator("dd")).toHaveText(["LESS","LESS","REGULAR","Cup one less sweet"]);
    await expect(cupDetails.nth(1).locator("dt")).toHaveText(["Sugar","Ice","Cup Size","Catatan"]);
    await expect(cupDetails.nth(1).locator("dd")).toHaveText(["NO SUGAR","NO ICE","LARGE","Cup two no ice"]);
    await expect(cupDetails.nth(0)).not.toContainText("Cup two no ice");await expect(cupDetails.nth(1)).not.toContainText("Cup one less sweet");
    await expect(details.getByRole("list",{name:"Gelas tersimpan French Fries",exact:true})).toHaveCount(0);
    for(const [width,height] of [[1024,768],[768,1024]]) {
      await page.setViewportSize({width,height});await cupDetails.nth(0).scrollIntoViewIfNeeded();await shot(`history-details-${width}x${height}`);
      const layout=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));
      expect.soft(layout.scrollWidth).toBeLessThanOrEqual(width);findings.push({stage:"history-details",width,height,layout});
    }
    await page.setViewportSize({width:1280,height:800});
    findings.push({historyDetailCustomerVisible:true,independentCupDetailsVisible:true});
    await tap("Cetak ulang struk");await expect(page.getByLabel("Pratinjau struk 58 mm",{exact:true})).toContainText("COPY");
    await page.getByLabel("Pratinjau struk 58 mm",{exact:true}).scrollIntoViewIfNeeded();await shot("09-history-copy");
    expect(await snapshot()).toBe(before);
    await page.reload();await page.getByRole("button",{name:`Lihat ${order.orderNumber}`,exact:true}).tap();
    await expect(details).toContainText("Pelanggan: Dina Browser");
    await expect(details.getByRole("list",{name:"Gelas tersimpan Aroom Singleshot",exact:true}).getByRole("listitem").nth(1)).toContainText("Cup two no ice");
    await tap("Cetak ulang struk");
    await expect(page.getByLabel("Pratinjau struk 58 mm",{exact:true})).toContainText("Dina Browser");
    await expect(page.getByLabel("Pratinjau label cup 2",{exact:true})).toContainText("Cup two no ice");
    await page.getByLabel("Pratinjau label cup 2",{exact:true}).scrollIntoViewIfNeeded();await shot("10-history-refresh");
    await context.setOffline(true);await tap("Muat ulang halaman");
    await expect(page.getByRole("alert").first()).toBeVisible();await shot("11-network-interruption");
    await context.setOffline(false);await page.reload();await expect(page.getByRole("button",{name:`Lihat ${order.orderNumber}`,exact:true})).toBeVisible();
    // A cryptographically valid expired session exercises server expiry verification.
    const cashier=probe().cashier;
    const now=Math.floor(Date.now()/1000);
    const expired=await new SignJWT({userId:cashier.id,credentialsVersion:cashier.credentialsVersion}).setProtectedHeader({alg:"HS256",typ:"JWT"}).setIssuer("aroom-pos").setAudience("aroom-pos:staff-session").setIssuedAt(now-43201).setExpirationTime(now-1).sign(new TextEncoder().encode(process.env.SESSION_SECRET!));
    await context.addCookies([{name:"aroom_session",value:expired,url:process.env.AROOM_BROWSER_URL!,httpOnly:true,sameSite:"Lax"}]);
    await page.goto("/pos");await expect(page).toHaveURL(/\/login/);await shot("12-expired-session");
    expect(await snapshot()).toBe(before);
  } finally {writeFileSync(join(process.env.AROOM_BROWSER_EVIDENCE!,"screenshots-and-layout.json"),JSON.stringify({screenshots,findings},null,2));}
});
