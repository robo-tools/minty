import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { PROGRAMS } from "../src/points/programs";
import { call, getJson } from "./helpers";

// BAM, part 1 (docs/bam.md): miles and points balances typed in, each update a new reading.

const day = (offset: number) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const send = (method: string, path: string, body?: unknown) => getJson<any>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const list = async () => (await getJson<any>("/points")).body;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM point_balances").run();
});

describe("GET /points", () => {
  it("is behind Access like every API route", async () => {
    expect((await call("/points", { token: null })).status).toBe(403);
  });

  it("lists the programs Minty knows, and no balances yet", async () => {
    const body = await list();
    expect(body.balances).toEqual([]);
    expect(body.programs.find((p: any) => p.id === "amex_mr")).toEqual({ id: "amex_mr", name: "Amex Membership Rewards", kind: "bank", unit: "points", expiry: { kind: "while_open" } });
    expect(body.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("adding and updating balances", () => {
  it("adds one by hand, defaulting the person and the date to today", async () => {
    const { status, body } = await send("POST", "/points", { program: "amex_mr", balance: 65536 });
    expect(status).toBe(201);
    const row = await env.DB.prepare("SELECT owner, program, account_hint, balance, as_of, source, file_sha256 FROM point_balances WHERE id = ?").bind(body.id).first();
    expect(row).toEqual({ owner: "me", program: "amex_mr", account_hint: null, balance: 65536, as_of: day(0), source: "manual", file_sha256: null });
  });

  it("an update is a new reading: the newest shows, with the earlier ones as history", async () => {
    await send("POST", "/points", { program: "amex_mr", balance: 50000, as_of: day(-60) });
    await send("POST", "/points", { program: "amex_mr", balance: 61000, as_of: day(-30) });
    await send("POST", "/points", { program: "amex_mr", balance: 65536, as_of: day(-2) });
    const [b] = (await list()).balances;
    expect(b).toMatchObject({ program: "amex_mr", name: "Amex Membership Rewards", kind: "bank", unit: "points", balance: 65536, as_of: day(-2) });
    expect(b.history.map((h: any) => [h.balance, h.as_of])).toEqual([[61000, day(-30)], [50000, day(-60)]]);
  });

  it("a reading dated earlier than the newest one goes into history, not on top", async () => {
    await send("POST", "/points", { program: "united", balance: 41800, as_of: day(-5) });
    await send("POST", "/points", { program: "united", balance: 39000, as_of: day(-40) });   // found an old statement
    const [b] = (await list()).balances;
    expect(b.balance).toBe(41800);
    expect(b.history.map((h: any) => h.balance)).toEqual([39000]);
  });

  it("keeps separate balances per person and per account in the same program", async () => {
    await send("POST", "/points", { program: "chase_ur", balance: 1000, owner: "me" });
    await send("POST", "/points", { program: "chase_ur", balance: 2000, owner: "spouse" });
    await send("POST", "/points", { program: "chase_ur", balance: 3000, owner: "me", account_hint: "1234" });
    const b = (await list()).balances.filter((x: any) => x.program === "chase_ur");
    expect(b.map((x: any) => [x.owner, x.account_hint, x.balance]).sort()).toEqual([["me", "1234", 3000], ["me", null, 1000], ["spouse", null, 2000]].sort());
    expect(b.every((x: any) => x.history.length === 0)).toBe(true);
  });

  it("takes a program by its name (any case), or one Minty doesn't know, as typed", async () => {
    await send("POST", "/points", { program: "world of HYATT", balance: 27300 });
    await send("POST", "/points", { program: "  Alaska   Mileage Plan ", balance: 12000 });
    const b = (await list()).balances;
    expect(b.find((x: any) => x.program === "hyatt")).toMatchObject({ name: "World of Hyatt", kind: "hotel" });
    expect(b.find((x: any) => x.program === "Alaska Mileage Plan")).toMatchObject({ name: "Alaska Mileage Plan", kind: "other", unit: "points" });
  });

  it("fixes a reading in place, and deletes one (the balance then shows the one before)", async () => {
    await send("POST", "/points", { program: "hilton", balance: 80000, as_of: day(-20) });
    const { body } = await send("POST", "/points", { program: "hilton", balance: 999999, as_of: day(-1) });
    expect((await send("PUT", `/points/${body.id}`, { balance: 99999 })).status).toBe(200);
    expect((await list()).balances[0].balance).toBe(99999);
    expect((await send("DELETE", `/points/${body.id}`)).body).toEqual({ id: body.id, deleted: true });
    expect((await list()).balances[0]).toMatchObject({ balance: 80000, history: [] });
    expect((await send("DELETE", `/points/${body.id}`)).status).toBe(404);
    expect((await send("PUT", "/points/999999", { balance: 1 })).status).toBe(404);
  });

  it("a balance read from a PDF needs its fingerprint, and the same PDF is refused twice", async () => {
    expect((await send("POST", "/points", { program: "amex_mr", balance: 1, source: "pdf" })).status).toBe(422);
    const sha = "b".repeat(64);
    expect((await send("POST", "/points", { program: "amex_mr", balance: 1, source: "pdf", file_sha256: sha })).status).toBe(201);
    expect((await send("POST", "/points", { program: "amex_mr", balance: 2, source: "pdf", file_sha256: sha })).status).toBe(409);
  });

  it.each([
    [{ program: "", balance: 1 }],
    [{ program: "x".repeat(41), balance: 1 }],
    [{ program: "amex_mr", balance: -1 }],
    [{ program: "amex_mr", balance: 1.5 }],
    [{ program: "amex_mr", balance: "65,536" }],
    [{ program: "amex_mr", balance: 10_000_000_001 }],
    [{ program: "amex_mr", balance: 1, as_of: day(5) }],
    [{ program: "amex_mr", balance: 1, as_of: "2026-02-30" }],
    [{ program: "amex_mr", balance: 1, account_hint: "12" }],
    [{ program: "amex_mr", balance: 1, owner: "nobody" }],
  ])("refuses %j", async (body) => {
    expect((await send("POST", "/points", body)).status).toBe(422);
  });

  it("refuses a body that isn't a JSON object, and an empty change", async () => {
    expect((await getJson("/points", { method: "POST", body: "[]" })).status).toBe(422);
    const { body } = await send("POST", "/points", { program: "delta", balance: 5 });
    expect((await send("PUT", `/points/${body.id}`, {})).status).toBe(422);
  });
});

describe("the program list", () => {
  it("has unique ids and names, each with a kind, a unit and a site", () => {
    expect(new Set(PROGRAMS.map((p) => p.id)).size).toBe(PROGRAMS.length);
    expect(new Set(PROGRAMS.map((p) => p.name.toLowerCase())).size).toBe(PROGRAMS.length);
    for (const p of PROGRAMS) {
      expect(["bank", "airline", "hotel"]).toContain(p.kind);
      expect(p.unit).toBeTruthy();
      expect(p.site).toMatch(/^[a-z0-9.-]+\.[a-z]+$/);
      expect(p.name.length).toBeLessThanOrEqual(40);
    }
  });
});

describe("statement PDFs (part 2)", () => {
  it("POST /points/known says which PDFs already gave a balance", async () => {
    const sha = "c".repeat(64);
    await send("POST", "/points", { program: "amex_mr", balance: 84210, as_of: day(-40), source: "pdf", file_sha256: sha });
    expect((await send("POST", "/points/known", { sha256: [sha, "d".repeat(64)] })).body).toEqual({ known: [sha] });
    expect((await send("POST", "/points/known", { sha256: [] })).body).toEqual({ known: [] });
    expect((await send("POST", "/points/known", { sha256: ["not-a-sha"] })).status).toBe(422);
    expect((await send("POST", "/points/known", { sha256: Array(201).fill(sha) })).status).toBe(422);
  });

});

describe("expiry rules and the cards that earn each currency (part 3)", () => {
  it("each program's expiry rule is sent, or null when Minty has none", async () => {
    const programs = Object.fromEntries((await list()).programs.map((p: any) => [p.id, p.expiry]));
    expect(programs.amex_mr).toEqual({ kind: "while_open" });
    expect(programs.united).toEqual({ kind: "never" });
    expect(programs.marriott).toEqual({ kind: "inactivity", months: 24 });
    expect(programs.ihg).toBeNull();
  });

  it.each([
    ["American Express", "Platinum Card®", "amex_mr"],
    ["American Express", "Gold Card", "amex_mr"],
    ["American Express", "Blue Business Plus Card", "amex_mr"],
    ["American Express", "Delta SkyMiles® Reserve Card", "delta"],
    ["American Express", "Hilton Honors Aspire Card", "hilton"],
    ["American Express", "Marriott Bonvoy Brilliant®", "marriott"],
    ["American Express", "Blue Cash Preferred®", null],
    ["Chase", "Sapphire Preferred", "chase_ur"],
    ["JPMorgan Chase", "Chase Freedom Unlimited", "chase_ur"],
    ["Chase", "Ink Business Cash", "chase_ur"],
    ["Chase", "United Explorer", "united"],
    ["Chase", "World of Hyatt Credit Card", "hyatt"],
    ["Chase", "Amazon Prime Rewards Visa", null],
    ["Citibank Online", "Citi Strata Premier℠", "citi_typ"],              // Plaid's name for Citi's bank
    ["Citi", "Citi Strata Premier℠", "citi_typ"],
    ["Citi", "Citi® / AAdvantage® Platinum Select®", "american"],
    ["Wells Fargo", "Bilt World Elite Mastercard®", "bilt"],
    ["Capital One", "Venture X", "capital_one"],
    ["Capital One", "Quicksilver", null],
  ])("%s %s likely earns %s", async (bank, name, program) => {
    const { programForCard } = await import("../src/routes/points");
    expect(programForCard({ bank, name })?.id ?? null).toBe(program);
  });

  it("GET /points lists the linked cards that likely earn each currency, with no balance needed", async () => {
    await env.DB.batch(["transaction_tags", "transactions", "card_products", "accounts", "items"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    const item = (await env.DB.prepare(`INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, institution_name, status)
      VALUES ('me', 'me_primary', 'item-amex', 'x', 'American Express', 'good') RETURNING id`).first<{ id: number }>())!.id;
    await env.DB.prepare(`INSERT INTO accounts (owner, item_id, plaid_account_id, name, mask, type, subtype) VALUES
      ('me', ?1, 'a1', 'Platinum Card®', '1004', 'credit', 'credit card'),
      ('spouse', ?1, 'a2', 'Delta SkyMiles® Gold Card', '2002', 'credit', 'credit card'),
      ('me', ?1, 'a3', 'Savings', '3003', 'depository', 'savings')`).bind(item).run();
    const body = await list();
    expect(body.balances).toEqual([]);
    expect(body.cards.map((c: any) => [c.name, c.mask, c.owner, c.program])).toEqual([
      ["Platinum Card®", "1004", "me", "amex_mr"], ["Delta SkyMiles® Gold Card", "2002", "spouse", "delta"]]);
    await env.DB.batch(["accounts", "items"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  });
});
