import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { accessToken, getJson } from "./helpers";

const KEY = "audit_checklist";
const today = () => new Date().toISOString().slice(0, 10);
const save = (value: string | null) => env.DB.prepare("INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
  .bind(KEY, value).run();
const stored = async () => JSON.parse((await env.DB.prepare("SELECT value FROM app_state WHERE key = ?").bind(KEY).first<{ value: string }>())!.value);
const set = (id: string, checked: boolean, token: string) => getJson<{ id: string; checked_on: string | null }>("/audit/checklist", {
  method: "PUT", token, body: JSON.stringify({ id, checked }),
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM app_state WHERE key = ?").bind(KEY).run();
});

describe("atomic planner checklist changes", () => {
  it("retains simultaneous checks and mixed checks/unchecks, including unrelated stored keys", async () => {
    const token = await accessToken();
    const retained = { future_item: "2025-01-02", future_metadata: { enabled: true } };
    await save(JSON.stringify(retained));
    const ids = ["will", "life_insurance", "disability", "umbrella", "credit_freeze", "ssa"];
    const checked = await Promise.all(ids.map((id) => set(id, true, token)));
    for (const [i, result] of checked.entries()) {
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ id: ids[i], checked_on: today() });
    }
    expect(await stored()).toEqual({ ...retained, ...Object.fromEntries(ids.map((id) => [id, today()])) });

    const changes: [string, boolean][] = [["will", false], ["umbrella", false], ["ssa", false], ["deductibles", true], ["roth_mix", true]];
    const mixed = await Promise.all(changes.map(([id, value]) => set(id, value, token)));
    for (const [i, result] of mixed.entries()) {
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ id: changes[i][0], checked_on: changes[i][1] ? today() : null });
    }
    expect(await stored()).toEqual({ ...retained, life_insurance: today(), disability: today(), credit_freeze: today(), deductibles: today(), roth_mix: today() });
  });

  it("creates an object when the first change unchecks an item", async () => {
    expect(await set("will", false, await accessToken())).toEqual({ status: 200, body: { id: "will", checked_on: null } });
    expect(await stored()).toEqual({});
  });

  it.each([null, "not JSON", "null", "[]", '["old value"]', '"old value"', "5", "true"])("recovers invalid stored state %s for reads, checks, and unchecks", async (value) => {
    const token = await accessToken();
    await save(value);
    const advice = await getJson<{ checklist: { id: string; checked_on: string | null; due: boolean }[] }>("/audit/advice", { token });
    expect(advice.status).toBe(200);
    expect(advice.body.checklist.find((item) => item.id === "will")).toMatchObject({ checked_on: null, due: true });
    expect(await set("will", true, token)).toEqual({ status: 200, body: { id: "will", checked_on: today() } });
    expect(await stored()).toEqual({ will: today() });

    await save(value);
    expect(await set("will", false, token)).toEqual({ status: 200, body: { id: "will", checked_on: null } });
    expect(await stored()).toEqual({});
  });
});
