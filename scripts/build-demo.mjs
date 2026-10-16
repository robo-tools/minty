#!/usr/bin/env node
// Builds Minty's live demo: a static folder with the real dashboard (public/index.html, app.js,
// theme.js, abc.js, abc.css) and the real Worker (src/) bundled to run in the browser over sql.js, with a made-up
// household (demo/). No server, no Plaid, nothing leaves the browser. See docs/demo.md.
//
//   npm run build:demo -- [--out dist/demo] [--goatcounter https://<code>.goatcounter.com/count]
//                         [--og-image https://…/og.png --og-url https://…/demo/]   (link previews)
//
// Every change to the dashboard's files is checked: if index.html, app.js or theme.js changes so
// that one no longer applies, the build stops instead of shipping a demo that half works.
import { build } from "esbuild";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const out = arg("out", join(root, "dist/demo"));
const goatcounter = arg("goatcounter", "");
if (goatcounter && !/^https:\/\/[a-z0-9-]+\.goatcounter\.com\/count$/.test(goatcounter)) throw new Error(`--goatcounter: not a GoatCounter count URL: ${goatcounter}`);
// Link previews (Slack, iMessage…) for wherever the demo is published: an absolute PNG/JPEG URL
// (previews can't show SVG) and the demo's own address. Off unless both are given.
const ogImage = arg("og-image", ""), ogUrl = arg("og-url", "");
for (const [flag, v] of [["og-image", ogImage], ["og-url", ogUrl]]) if (v && !/^https:\/\/[^\s"<>]+$/.test(v)) throw new Error(`--${flag}: not an https URL: ${v}`);
if (!!ogImage !== !!ogUrl) throw new Error("--og-image and --og-url go together");
if (ogImage && !/\.(png|jpe?g)$/i.test(ogImage)) throw new Error(`--og-image: link previews need a PNG or JPEG: ${ogImage}`);

// sql.js from cdnjs, pinned: the script by its SRI hash, the WebAssembly by a hash checked by fetch().
const SQLJS = {
  js: "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/sql-wasm.min.js",
  jsSri: "sha512-laAM/mJRoxfgUSDOnpAVE3GGgawvUZ8wQU79lX5sT55mdIKhmc5mOEIy5HcJSAy4K78sQs29wJAr+3GMQUAuMg==",
  wasm: "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/sql-wasm.wasm",
  wasmSri: "sha512-Z/UYoXMYCkSl2TtNi599HFtI4qtPlrjriTZQf0zPJPn0baSi2F2KnK9LblvSw5ta0cuYl+Jr4N1dQdKgu+eEFA==",
};

const migrationsDir = join(root, "d1/migrations");
const migrations = await Promise.all((await readdir(migrationsDir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()
  .map((f) => readFile(join(migrationsDir, f), "utf8")));
const wrangler = await readFile(join(root, "wrangler.jsonc"), "utf8");
const apiPaths = JSON.parse(wrangler.match(/"run_worker_first":\s*(\[[^\]]*\])/)[1]);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const result = await build({
  entryPoints: [join(root, "demo/main.js")],
  bundle: true, minify: true, format: "iife", target: "es2022", platform: "browser", legalComments: "none",
  outfile: join(out, "demo.js"), metafile: true,
  // Access checks run with MINTY_DEV_NO_AUTH on a localhost request, so the JWT library is never used.
  alias: { jose: join(root, "demo/jose-stub.js") },
  define: { __MIGRATIONS__: JSON.stringify(migrations), __API_PATHS__: JSON.stringify(apiPaths), __SQLJS__: JSON.stringify(SQLJS) },
  logLevel: "warning",
});

// The dashboard page and its own scripts, changed only where listed.
const files = {};
for (const f of ["index.html", "app.js", "theme.js"]) files[f] = (await readFile(join(root, "public", f), "utf8")).replaceAll("\r\n", "\n");
const editIn = (file, what, from, to, count = 1) => {
  const text = files[file];
  const n = typeof from === "string" ? text.split(from).length - 1 : (text.match(from) ?? []).length;
  if (count === "some" ? n < 1 : n !== count) throw new Error(`build-demo: "${what}" matched ${n} times in public/${file} (expected ${count})`);
  files[file] = typeof from === "string" ? text.replaceAll(from, to) : text.replace(from, to);
};
const edit = (what, from, to, count) => editIn("index.html", what, from, to, count);
edit("title", /<title>[^<]*<\/title>/, "<title>Minty demo</title>");
// Bills uses the household's authenticated Worker; this standalone transaction demo has no Bills page.
edit("no Bills link in standalone demo", '<a class="addlink" href="/bills">Bills</a>', "");
const DESCRIPTION = "Minty with made-up data, in your browser: transactions, card credits (ABC) and more.";
const og = ogImage ? `
<meta name="description" content="${DESCRIPTION}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Minty" />
<meta property="og:title" content="Minty live demo" />
<meta property="og:description" content="${DESCRIPTION}" />
<meta property="og:url" content="${ogUrl}" />
<meta property="og:image" content="${ogImage}" />
<meta property="og:image:alt" content="Minty: your own private home for all your bank and card transactions" />
<meta name="twitter:card" content="summary_large_image" />` : "";
edit("demo script first", /^<head>$/m, `<head>\n<meta name="robots" content="noindex" />${og}\n<script src="demo.js"></script>`);
edit("no manifest", /<link rel="manifest"[^>]*>\n?/, "");
edit("no device lock", '<link rel="stylesheet" href="/lock.css" />\n<script src="/lock.js"></script>\n', "");   // demo visitors are never asked for Face ID
editIn("app.js", "no service worker", `if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});`, "// the demo registers no service worker");
editIn("theme.js", "light by default", `|| (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")`, `|| "light"`);
edit("relative asset paths", /(href|src)="\/(favicon\.svg|favicon-32\.png|apple-touch-icon\.png|abc\.css|abc\.js|bills\.css|bills\.js|bam\.css|bam\.js|cfa\.css|cfa\.js|charts\.js|egg\.css|egg\.js|app\.js|theme\.js)"/g, (_, a, f) => `${a}="${f}"`, "some");
const html0 = files["index.html"];
if (/(href|src)="\/(?!connect|add-user)[a-z]/.test(html0)) throw new Error(`build-demo: an absolute asset path is left: ${html0.match(/(href|src)="\/(?!connect|add-user)[^"]*"/)[0]}`);
edit("demo styles", /^<\/head>$/m, `<link rel="stylesheet" href="demo.css" />\n</head>`);
edit("ABC click event", `id="abcOpen"`, `id="abcOpen" data-goatcounter-click="minty-demo-abc"`);
edit("BAM click event", `id="bamOpen"`, `id="bamOpen" data-goatcounter-click="minty-demo-bam"`);
edit("EGG click event", `id="eggOpen"`, `id="eggOpen" data-goatcounter-click="minty-demo-egg"`);
edit("needs JavaScript", /^<body>$/m, `<body>\n<noscript><p style="padding:16px;text-align:center">The demo runs in your browser, so it needs JavaScript.</p></noscript>`);
if (goatcounter) {
  edit("GoatCounter", /^<\/body>$/m, `<!-- GoatCounter: no cookies, no personal data; the host goes in the path. allow_frame: the landing
     page shows the demo in a frame, which GoatCounter otherwise doesn't count. -->
<script>window.goatcounter = { path: (p) => location.host + p, allow_frame: true };</script>
<script data-goatcounter="${goatcounter}" async src="https://gc.zgo.at/count.js"></script>
</body>`);
}
for (const [f, text] of Object.entries(files)) await writeFile(join(out, f), text);
for (const f of ["abc.js", "abc.css", "bills.js", "bills.css", "bam.js", "bam.css", "bill-parse.js", "pdf-read.js", "points-parse.js", "cfa.js", "cfa.css", "charts.js", "egg.js", "egg.css", "favicon.svg", "favicon-32.png", "apple-touch-icon.png"]) await copyFile(join(root, "public", f), join(out, f));
await copyFile(join(root, "demo/demo.css"), join(out, "demo.css"));
// pdf.js for reading bill PDFs in the demo too (still only in the visitor's browser).
await mkdir(join(out, "vendor/pdfjs"), { recursive: true });
for (const f of ["pdf.min.mjs", "pdf.worker.min.mjs", "LICENSE"]) await copyFile(join(root, "public/vendor/pdfjs", f), join(out, "vendor/pdfjs", f));

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`demo built in ${out}: demo.js ${kb(Object.values(result.metafile.outputs)[0].bytes)}, ${migrations.length} migrations, ${apiPaths.length} API paths${goatcounter ? ", GoatCounter on" : ""}${ogImage ? ", link preview on" : ""}`);
