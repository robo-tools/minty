import type { Env } from "./env";
import { checkAccess } from "./access";
import { ConfigError, loadConfig, type Config } from "./config";
import { HttpError, MAX_BODY_BYTES, bodyTooLarge, json, unprocessable } from "./http";
import { COUNT_ABOVE_ROWS, budgetRefusal, countingDb, isHeavyRead, pruneReadCounts, rateLimited, recordReads } from "./limits";
import * as data from "./routes/data";
import * as abc from "./routes/benefits";
import * as syncReq from "./routes/syncrequest";
import * as link from "./routes/link";
import * as setup from "./routes/status";
import * as liabilities from "./routes/liabilities";
import * as bills from "./routes/bills";
import { LIABILITIES_CRON, runLiabilitiesSync } from "./liabilities";
import { PlaidError } from "./plaid";
import { CATCH_UP_CRON, checkConnections, runSyncAll } from "./sync";
import { isPending, markSwept, syncState } from "./routes/syncrequest";

/** Minty Worker. API paths are listed in wrangler.jsonc assets.run_worker_first; everything
 * else is served straight from public/. /healthz is the only path outside the Access check.
 * Sync runs only from the cron triggers (scheduled below); there is deliberately no HTTP sync endpoint. */

type Handler = (c: {
  env: Env; config: Config; request: Request; url: URL; params: string[]; ctx: ExecutionContext; email: string;
}) => Promise<Response>;

const ROUTES: Array<[method: string, path: RegExp, handler: Handler]> = [
  ["GET", /^\/manual-bills$/, ({ env, config, url }) => bills.list(env, config, url)],
  ["POST", /^\/manual-bills$/, ({ env, config, request }) => bills.create(env, config, request)],
  ["POST", /^\/manual-bills\/(\d+)\/paid$/, ({ env, request, params }) => bills.markPaid(env, request, Number(params[0]))],
  ["POST", /^\/manual-bills\/(\d+)\/archive$/, ({ env, params }) => bills.archive(env, Number(params[0]))],
  ["POST", /^\/manual-bills\/(\d+)\/restore$/, ({ env, params }) => bills.restore(env, Number(params[0]))],
  ["GET", /^\/liabilities$/, ({ env, config, url }) => liabilities.overview(env, config, url)],
  ["GET", /^\/liabilities\/history$/, ({ env, config, url }) => liabilities.history(env, config, url)],
  ["GET", /^\/liabilities\/payments$/, ({ env, config, url }) => liabilities.payments(env, config, url)],
  ["POST", /^\/link\/token\/liabilities$/, ({ env, config, request, email }) => link.updateMode(env, config, request, email, "liabilities")],
  ["POST", /^\/link\/liabilities\/complete$/, ({ env, config, request, email }) => liabilities.complete(env, config, request, email)],
  ["GET", /^\/status$/, ({ env, config, email }) => setup.status(env, config, email)],
  ["GET", /^\/users$/, ({ env, config }) => data.users(env, config)],
  ["GET", /^\/items$/, ({ env, config }) => data.items(env, config)],
  ["GET", /^\/health$/, ({ env, config }) => data.health(env, config)],
  ["GET", /^\/accounts$/, ({ env, url }) => data.accounts(env, url)],
  ["GET", /^\/capacity$/, ({ env, config }) => data.capacity(env, config)],
  ["GET", /^\/transactions$/, ({ env, url }) => data.transactions(env, url)],
  ["GET", /^\/tags$/, ({ env }) => data.listTags(env)],
  ["GET", /^\/sync-request$/, ({ env }) => syncReq.getSyncRequest(env)],
  ["POST", /^\/sync-request$/, ({ env, email }) => syncReq.requestSync(env, email)],
  ["GET", /^\/benefits$/, ({ env, url }) => abc.benefits(env, url)],
  ["PUT", /^\/benefits\/cards\/(\d+)$/, ({ env, request, params }) => abc.setCard(env, request, Number(params[0]))],
  ["PUT", /^\/benefits\/marks$/, ({ env, request, email }) => abc.setMark(env, request, email)],
  ["PUT", /^\/transactions\/([^/]+)\/tags$/, ({ env, request, params }) => {
    if (!/^\d+$/.test(params[0])) throw unprocessable("transaction id must be an integer");
    return data.setTags(env, request, Number(params[0]));
  }],
  ["POST", /^\/link\/token$/, ({ env, config, request, email }) => link.createLinkToken(env, config, request, email)],
  ["POST", /^\/link\/exchange$/, ({ env, config, request, ctx, email }) => link.exchange(env, config, request, ctx, email)],
  ["POST", /^\/link\/cancel$/, ({ env, request, email }) => link.cancel(env, request, email)],
  ["POST", /^\/link\/token\/update$/, ({ env, config, request, email }) => link.updateMode(env, config, request, email)],
  ["POST", /^\/link\/reconnected$/, ({ env, config, request }) => link.reconnected(env, config, request)],
];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json({ ok: true });

    // Not an API route: a static file (or its 404). Those are the pages in public/
    // and carry no data; Access still guards the hostname at the edge.
    const matches = ROUTES.map(([m, re, h]) => [m, url.pathname.match(re), h] as const).filter(([, m]) => m);
    if (!matches.length) return env.ASSETS.fetch(request);

    // Cloudflare Access adds the sign-in header to any request that carries the Access cookie,
    // including ones another site starts in the signed-in browser. Refuse state-changing requests
    // that didn't come from this origin (browsers always send Origin, and Sec-Fetch-Site, on
    // cross-site POST/PUT).
    if (request.method !== "GET" && request.method !== "HEAD") {
      const origin = request.headers.get("origin");
      if ((origin && origin !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site") {
        return json({ detail: "cross-site request refused" }, 403);
      }
    }

    const auth = await checkAccess(request, env);
    if (!auth.ok) return json({ detail: auth.detail }, 403);

    // Before any D1 or Plaid work (src/limits.ts).
    if (await rateLimited(env, auth.email, request.method, url)) {
      return json({ detail: "Too many requests. Wait a minute and try again." }, 429, { "retry-after": "60" });
    }
    if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
      const e = bodyTooLarge();
      return json({ detail: e.detail }, e.status);
    }

    const hit = matches.find(([m]) => m === request.method);
    if (!hit) return json({ detail: "method not allowed" }, 405);

    // Every statement the handler runs is counted; a request that read a lot adds to the day's total.
    const counted = countingDb(env.DB);
    try {
      const config = loadConfig(env);
      if (isHeavyRead(request.method, url)) {
        const refusal = await budgetRefusal(env);
        if (refusal) return json({ detail: refusal }, 429);
      }
      return await hit[2]({ env: { ...env, DB: counted.db }, config, request, url, params: hit[1]!.slice(1), ctx, email: auth.email });
    } catch (e) {
      if (e instanceof HttpError) return json({ detail: e.detail }, e.status);
      if (e instanceof ConfigError) return json({ detail: e.message }, 500);
      if (e instanceof PlaidError) {
        console.error(`plaid error ${e.errorCode} (request ${e.requestId ?? "?"})`);
        return json({ detail: `Plaid error: ${e.errorCode}` }, 502);
      }
      console.error("unhandled error", e instanceof Error ? e.message : e);   // never log request bodies
      return json({ detail: "internal error" }, 500);
    } finally {
      const rows = counted.rows();
      if (rows > COUNT_ABOVE_ROWS) {
        ctx.waitUntil(recordReads(env.DB, rows).catch((e) => console.error("counting reads failed:", e instanceof Error ? e.message : e)));
      }
    }
  },

  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (controller.cron === LIABILITIES_CRON) {
      await runLiabilitiesSync(env);
      return;
    }
    // The 10-minute catch-up continues unfinished downloads, unless someone asked for a sync from
    // the dashboard: then it sweeps every bank, like the hourly run. Sync only ever runs here.
    const catchUp = controller.cron === CATCH_UP_CRON;
    const requested = catchUp && isPending(await syncState(env).catch(() => ({ requested_at: null, last_sweep_at: null })));
    const updatesOnly = catchUp && !requested;
    const results = await runSyncAll(env, undefined, { updatesOnly });
    if (!updatesOnly) await markSwept(env).catch((e) => console.error("marking the sweep failed:", e instanceof Error ? e.message : e));
    if (!updatesOnly || Object.keys(results).length) {          // quiet when nothing is downloading
      console.log(requested ? "requested sync complete" : updatesOnly ? "catch-up sync complete" : "scheduled sync complete", JSON.stringify(results));   // item id -> result; no data
    }
    if (!catchUp) {
      // After sync, so a failed check never costs a sync; each bank about once a day.
      const checked = await checkConnections(env).catch((e) => {
        console.error("connection check failed:", e instanceof Error ? e.message : e);
        return {};
      });
      if (Object.keys(checked).length) console.log("connection check", JSON.stringify(checked));   // item id -> Plaid code or null
      // The cron reads what it needs whatever the day's read budget says; it only tidies the counters.
      await pruneReadCounts(env.DB).catch((e) => console.error("pruning read counts failed:", e instanceof Error ? e.message : e));
      await link.pruneLinkSessions(env.DB).catch((e) => console.error("pruning Link sessions failed:", e instanceof Error ? e.message : e));
    }
  },
} satisfies ExportedHandler<Env>;
