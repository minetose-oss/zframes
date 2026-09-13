import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoldTradersProvider as GoldTradersProviderType } from "./index";

// The quote cache and the shared fx-rate cache are module-level singletons, so
// each test takes a fresh module via vi.resetModules() + a dynamic import.
type Ctor = typeof GoldTradersProviderType;

/** THB per USD every stub answers, so the expected USD figures are exact. */
const FX = 33.6;

async function loadProvider(): Promise<Ctor> {
  vi.resetModules();
  const mod = await import("./index");
  return mod.GoldTradersProvider;
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function htmlResponse(body: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => body,
  };
}

const FX_HOSTS = [
  "frankfurter",
  "fxratesapi",
  "currency-api",
  "data-api.ecb.europa.eu",
];

/**
 * The provider fetches the announcement page and the USD/THB rate in parallel,
 * so a single-response mock would feed the FX body to the scraper. Frankfurter
 * (the chain's primary) answers here, leaving the fallbacks untouched.
 */
function stubFetch(html: string) {
  const fetchMock = vi.fn((url: string) =>
    Promise.resolve(
      FX_HOSTS.some((host) => String(url).includes(host))
        ? jsonResponse({ rates: { THB: FX } })
        : htmlResponse(html),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * Cut from the live page (2026-09-13). The figures are nested two tags deep
 * inside their span, which is the whole reason the reader takes the span's
 * inner HTML rather than the text right after the opening tag.
 */
function announcementPage(
  overrides: Partial<Record<string, string>> = {},
): string {
  const span = (id: string, inner: string) =>
    `<span id="DetailPlace_uc_goldprices1_${id}">${inner}</span>`;
  const price = (id: string, text: string) =>
    overrides[id] ?? span(id, `<b><font color="Black">${text}</font></b>`);
  return `<html><body>
    <div>&nbspประจำวันที่ ${
      overrides.lblAsTime ??
      span(
        "lblAsTime",
        '<b><font size="3">13/09/2569 เวลา 09:03 น. (ครั้งที่ 4)</font></b>',
      )
    }</div>
    <table>
      <tr><td>ทองคำแท่ง 96.5%</td><td>ขายออก</td><td>${price("lblBLSell", "68,250.00")}</td></tr>
      <tr><td>&nbsp;</td><td>รับซื้อ</td><td>${price("lblBLBuy", "68,050.00")}</td></tr>
      <tr><td>ทองรูปพรรณ 96.5%</td><td>ขายออก</td><td>${price("lblOMSell", "69,050.00")}</td></tr>
      <tr><td>&nbsp;</td><td>ฐานภาษี</td><td>${price("lblOMBuy", "66,688.84")}</td></tr>
    </table>
  </body></html>`;
}

let GoldTradersProvider: Ctor;

beforeEach(async () => {
  GoldTradersProvider = await loadProvider();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getRetailGoldPrice", () => {
  it("reads the four labelled figures and converts them to USD", async () => {
    stubFetch(announcementPage());
    const price = await new GoldTradersProvider().getRetailGoldPrice();

    expect(price.local).toEqual({
      bar: { buy: 68_050, sell: 68_250 },
      ornament: { buy: 66_688.84, sell: 69_050 },
    });
    expect(price.bar.buy).toBeCloseTo(68_050 / FX, 10);
    expect(price.ornament.sell).toBeCloseTo(69_050 / FX, 10);
    expect(price.fxRate).toBeCloseTo(1 / FX, 12);
    expect(price.quoteCurrency).toBe("THB");
    expect(price.unitGrams).toBe(15.244);
    expect(price.purity).toBe(0.965);
    expect(price.source).toBe("Gold Traders Association");
  });

  it("reads the Buddhist-era stamp as Bangkok time, with its revision", async () => {
    stubFetch(announcementPage());
    const price = await new GoldTradersProvider().getRetailGoldPrice();

    expect(new Date(price.updatedAt).toISOString()).toBe(
      "2026-09-13T02:03:00.000Z",
    );
    expect(price.revision).toBe(4);
  });

  it("still publishes a quote when the stamp is unreadable", async () => {
    const before = Date.now();
    stubFetch(announcementPage({ lblAsTime: "<span>ประกาศ</span>" }));
    const price = await new GoldTradersProvider().getRetailGoldPrice();

    expect(price.revision).toBeUndefined();
    expect(price.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("throws when a price label is gone, naming the sides it lost", async () => {
    stubFetch(announcementPage({ lblOMSell: "<span>ราคา</span>" }));
    await expect(
      new GoldTradersProvider().getRetailGoldPrice(),
    ).rejects.toThrow(/ornament\.sell/);
  });

  it("throws when a price label is present but not a number", async () => {
    stubFetch(
      announcementPage({
        lblBLBuy:
          '<span id="DetailPlace_uc_goldprices1_lblBLBuy"><b><font>-</font></b></span>',
      }),
    );
    await expect(
      new GoldTradersProvider().getRetailGoldPrice(),
    ).rejects.toThrow(/bar\.buy/);
  });
});
