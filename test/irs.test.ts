import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import { COLA_URL, PUB969_URL, limitsFor, parseCola, parsePub969, refreshIrsLimits, sane } from "../src/retirement/irs";
import { COLA_2026, PUB969_2026 } from "./fixtures/irs-pages";
import { getJson } from "./helpers";

// EGG's IRS limits, fetched from irs.gov once a year (src/retirement/irs.ts). Parsed from the real
// pages' markup (test/fixtures/irs-pages.ts); the fetch itself is always a fake here.
const E = { ...(env as unknown as Env), IRS_LIMITS: "on" } as Env;
const db = env.DB;
const $ = (d: number) => d * 100;

function fakeIrs(pages: Partial<Record<string, string | number>>) {
  const calls: string[] = [];
  const fetcher = (async (url: RequestInfo | URL) => {
    const u = String(url);
    calls.push(u === COLA_URL ? "cola" : u === PUB969_URL ? "pub969" : u);
    const page = pages[u];
    if (typeof page === "number") return new Response("nope", { status: page });
    return new Response(page ?? "<html>nothing here</html>", { status: 200 });
  }) as typeof fetch;
  return { calls, fetcher };
}
const stored = async (year: number) => JSON.parse((await db.prepare("SELECT value FROM app_state WHERE key = ?").bind(`irs_limits:${year}`).first<{ value: string }>())?.value ?? "null");

beforeEach(async () => {
  await db.prepare("DELETE FROM app_state WHERE key LIKE 'irs_%'").run();
});

describe("parsing the IRS pages", () => {
  it("the COLA table: every year's 401(k), catch-ups (60–63 from the footnote), IRA and SIMPLE", () => {
    const p = parseCola(COLA_2026);
    expect(Object.keys(p).map(Number).sort()).toEqual([2023, 2024, 2025, 2026]);
    expect(p[2026]).toEqual({ ira: $(7500), iraCatchUp50: $(1100), simple: $(17000), simpleCatchUp50: $(4000),
                              workplace: $(24500), workplaceCatchUp50: $(8000), workplaceCatchUp60to63: $(11250) });
    expect(p[2025]).toMatchObject({ workplace: $(23500), ira: $(7000), workplaceCatchUp50: $(7500) });
    expect(p[2023].workplaceCatchUp60to63).toBeUndefined();               // no such catch-up before 2025
  });

  it("Publication 969: the HSA limits for each year it states, and the 55+ catch-up", () => {
    expect(parsePub969(PUB969_2026)).toEqual({ 2025: { hsaSelf: $(4300), hsaFamily: $(8550), hsaCatchUp55: $(1000) },
                                               2026: { hsaSelf: $(4400), hsaFamily: $(8750), hsaCatchUp55: $(1000) } });
  });

  it("a page that changed shape gives nothing, not wrong numbers", () => {
    expect(parseCola("<html><p>Retirement topics</p></html>")).toEqual({});
    expect(parsePub969("<html><p>HSAs</p></html>")).toEqual({});
  });

  it("keeps only figures that look right: steps of $50, near the last known value", () => {
    expect(sane({ workplace: $(25000), ira: $(7550), hsaSelf: $(4425), simple: $(90000), iraCatchUp50: $(500) }, 2027, {}))
      .toEqual({ workplace: $(25000), ira: $(7550) });                    // $4,425: not a $50 step; SIMPLE ×5; IRA catch-up halved
  });
});

describe("asking the IRS once a year", () => {
  it("settles this year with one request per page, then asks nothing more", async () => {
    const irs = fakeIrs({ [COLA_URL]: COLA_2026, [PUB969_URL]: PUB969_2026 });
    const july = new Date("2026-07-02T00:20:00Z");
    expect(await refreshIrsLimits(E, july, irs.fetcher)).toMatchObject({ cola: "asked", pub969: "asked" });
    expect(irs.calls).toEqual(["cola", "pub969"]);
    expect((await stored(2026)).values).toMatchObject({ workplace: $(24500), workplaceCatchUp60to63: $(11250), hsaFamily: $(8750) });
    expect((await stored(2026)).settled).toEqual({ cola: "2026-07-02", pub969: "2026-07-02" });
    for (const d of ["2026-07-20", "2026-09-30", "2026-10-31"]) await refreshIrsLimits(E, new Date(`${d}T00:20:00Z`), irs.fetcher);
    expect(irs.calls).toEqual(["cola", "pub969"]);                       // settled: never asked again this year
  });

  it("from November, asks for next year's table until it's there: at most once a week", async () => {
    const irs = fakeIrs({ [COLA_URL]: COLA_2026, [PUB969_URL]: PUB969_2026 });
    await refreshIrsLimits(E, new Date("2026-07-02T00:20:00Z"), irs.fetcher);
    irs.calls.length = 0;
    await refreshIrsLimits(E, new Date("2026-11-02T00:20:00Z"), irs.fetcher);   // the table has no 2027 column yet
    await refreshIrsLimits(E, new Date("2026-11-05T00:20:00Z"), irs.fetcher);   // under a week later: not asked
    expect(irs.calls).toEqual(["cola"]);
    expect(await stored(2027)).toBeNull();
    // The IRS adds next year's column (here: every year moved on by one, same figures).
    const next = COLA_2026.replace(/\b202([3-6])\b/g, (_, d) => `202${Number(d) + 1}`);
    const later = fakeIrs({ [COLA_URL]: next, [PUB969_URL]: PUB969_2026 });
    await refreshIrsLimits(E, new Date("2026-11-10T00:20:00Z"), later.fetcher);
    expect(later.calls).toEqual(["cola"]);                                  // HSA for 2027 waits for the new year's Publication 969
    expect((await stored(2027)).values).toMatchObject({ workplace: $(24500), ira: $(7500) });
    await refreshIrsLimits(E, new Date("2026-12-20T00:20:00Z"), later.fetcher);
    expect(later.calls).toEqual(["cola"]);                                  // settled
  });

  it("an IRS page that's down, or changed, settles nothing and is asked again a week later", async () => {
    const down = fakeIrs({ [COLA_URL]: 503, [PUB969_URL]: "<html>moved</html>" });
    expect(await refreshIrsLimits(E, new Date("2026-03-01T00:20:00Z"), down.fetcher)).toMatchObject({ cola: "HTTP 503", "pub969:2026": "not published yet, or didn't look right" });
    expect(await stored(2026)).toBeNull();
    const up = fakeIrs({ [COLA_URL]: COLA_2026, [PUB969_URL]: PUB969_2026 });
    await refreshIrsLimits(E, new Date("2026-03-04T00:20:00Z"), up.fetcher);
    expect(up.calls).toEqual([]);
    await refreshIrsLimits(E, new Date("2026-03-08T00:20:00Z"), up.fetcher);
    expect(up.calls).toEqual(["cola", "pub969"]);
    expect((await stored(2026)).settled).toEqual({ cola: "2026-03-08", pub969: "2026-03-08" });
  });

  it("IRS_LIMITS=off: never asks", async () => {
    const irs = fakeIrs({});
    expect(await refreshIrsLimits({ ...E, IRS_LIMITS: "off" } as Env, new Date("2026-03-01T00:20:00Z"), irs.fetcher)).toEqual({});
    expect(irs.calls).toEqual([]);
  });
});

describe("the limits EGG and the audit use", () => {
  it("fetched figures win over the code's; without either, last year's, marked provisional", async () => {
    expect(await limitsFor(E, 2026, "2026-10-16")).toMatchObject({ workplace: $(24500), fetched: false, provisional: [] });   // the code's
    await db.prepare("INSERT INTO app_state (key, value) VALUES ('irs_limits:2027', ?)")
      .bind(JSON.stringify({ values: { workplace: $(25000), workplaceCatchUp50: $(8000), ira: $(7500), iraCatchUp50: $(1100), simple: $(17500), simpleCatchUp50: $(4000) }, settled: { cola: "2026-11-09" } })).run();
    const l = (await limitsFor(E, 2027, "2026-10-16"))!;
    expect(l).toMatchObject({ workplace: $(25000), fetched: true, hsaSelf: $(4400), hsaFamily: $(8750) });     // HSA not published yet: 2026's
    expect(l.provisional.sort()).toEqual(["hsaCatchUp55", "hsaFamily", "hsaSelf", "workplaceCatchUp60to63"].sort());
  });

  it("GET /retirement sends them", async () => {
    expect((await getJson<any>("/retirement")).body.limits).toMatchObject({ workplace: $(24500), checked: expect.any(String), provisional: [] });
  });
});
