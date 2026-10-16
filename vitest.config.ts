import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// Tests run inside workerd against a real local D1 with d1/migrations applied.
// Plaid is never called; Access JWTs are signed with a test key (see test/helpers.ts).
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./d1/migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ACCESS_TEAM_DOMAIN: "minty-test.cloudflareaccess.com",
            ACCESS_AUD: "test-aud",
            TOKEN_ENC_KEY: "uJ2Cr7n5n8QXZd8r6l0eH8tq3aK4bmFvK4H2Q9F3Wn8=",   // TEST ONLY (test/fixtures/fernet-vectors.json)
            MINTY_USERS: "me:Me,spouse:Spouse",    // two people, so the multi-person paths are tested
            IRS_LIMITS: "off",                     // no test reaches irs.gov (test/irs.test.ts turns it on, with a fake fetch)
            // Dummy credentials only: me has both slots, spouse only primary.
            PLAID_CLIENT_ID_ME_PRIMARY: "cid_me_primary",
            PLAID_SECRET_ME_PRIMARY: "secret_me_primary",
            PLAID_CLIENT_ID_ME_BACKUP: "cid_me_backup",
            PLAID_SECRET_ME_BACKUP: "secret_me_backup",
            PLAID_CLIENT_ID_SPOUSE_PRIMARY: "cid_spouse_primary",
            PLAID_SECRET_SPOUSE_PRIMARY: "secret_spouse_primary",
          },
          // The real rate limiting bindings, with limits no test reaches (every test signs in as the
          // same login). test/limits.test.ts checks refusals with its own limiters.
          ratelimits: Object.fromEntries([["RL_GENERAL", "714101"], ["RL_SEARCH", "714102"], ["RL_LINK", "714103"]]
            .map(([name, namespace_id]) => [name, { namespace_id, simple: { limit: 1_000_000, period: 60 as const } }])),
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
