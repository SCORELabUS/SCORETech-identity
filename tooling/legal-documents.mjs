import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const documents = JSON.parse(
  await readFile(new URL("../legal/documents.json", import.meta.url), "utf8"),
);
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const linkText = (value) =>
  escape(value).replace(
    /(https:\/\/www\.aepd\.es|infoscore@us\.es|\/identity\/legal\/(?:terms|privacy))/g,
    (value) =>
      `<a class="cursor-pointer" href="${value.includes("@") ? "mailto:" : ""}${value}">${value.includes("@") || value.startsWith("https") ? value : value.endsWith("terms") ? "Terms of service" : "Privacy policy"}</a>`,
  );
export function legalReferences(origin) {
  return Object.fromEntries(
    Object.entries(documents).map(([kind, document]) => [
      kind,
      {
        url: origin + "/identity/legal/" + kind,
        version: document.updated,
        digest:
          "sha256:" +
          createHash("sha256").update(JSON.stringify(document)).digest("hex"),
      },
    ]),
  );
}
export function renderLegal(kind) {
  const document = documents[kind];
  if (!document) throw new Error("Unknown legal document");
  const navigation = document.sections
    .map(
      ([title], index) =>
        `<li><a class="cursor-pointer" href="#section-${index + 1}"><span>${String(index + 1).padStart(2, "0")}</span>${escape(title)}</a></li>`,
    )
    .join("");
  const sections = document.sections
    .map(
      ([title, paragraphs], index) =>
        `<section id="section-${index + 1}"><h2><span>${String(index + 1).padStart(2, "0")}</span>${escape(title)}</h2>${paragraphs.map((text) => `<p>${linkText(text)}</p>`).join("")}</section>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="${escape(document.summary)}"><title>${escape(document.title)} · SCORETech Identity</title><style>
@font-face{font-family:Source;src:url('/identity/legal/assets/source-400.woff2') format('woff2');font-weight:400;font-display:swap}@font-face{font-family:Source;src:url('/identity/legal/assets/source-700.woff2') format('woff2');font-weight:700;font-display:swap}
:root{color-scheme:light;--page:#f6f7f8;--surface:#fff;--text:#212529;--muted:#68727a;--line:#e4e7e9;--red:#be1d37;--soft:#f1f3f5;font-family:Source,'Source Sans Pro',sans-serif}*{box-sizing:border-box}html{scroll-padding-top:2rem;scroll-behavior:smooth}body{margin:0;background:var(--page);color:var(--text)}a{cursor:pointer;color:var(--red);text-underline-offset:4px}a:focus-visible{outline:3px solid var(--red);outline-offset:5px;border-radius:3px}.skip{position:absolute;left:1rem;top:-5rem}.skip:focus{top:1rem;background:var(--surface);padding:1rem}header,main,footer{max-width:1200px;margin:auto}header{display:flex;justify-content:space-between;align-items:center;padding:30px 32px;border-bottom:1px solid var(--line);gap:24px}.wordmark{text-decoration:none;line-height:1;color:var(--red);font-weight:700;font-size:30px;letter-spacing:1px}.wordmark small{display:block;font-size:11px;text-transform:uppercase;letter-spacing:4px;color:var(--muted);margin-top:8px}header nav{display:flex;gap:24px;flex-wrap:wrap}header nav a{color:var(--muted);font-size:16px}header nav a[aria-current=page]{color:var(--red);font-weight:700}main{padding:64px 32px}.intro{max-width:800px;margin-bottom:48px}.eyebrow{text-transform:uppercase;font-weight:700;font-size:12px;letter-spacing:3px;color:var(--red);margin:0 0 16px}h1{font-size:clamp(40px,6vw,64px);line-height:1.06;letter-spacing:-1.5px;margin:0 0 22px}.summary{font-size:22px;line-height:1.5;color:var(--muted);margin:0 0 20px}.updated{font-size:15px;color:var(--muted)}.layout{display:grid;grid-template-columns:250px minmax(0,1fr);gap:48px;align-items:start}.contents{position:sticky;top:24px;padding:22px 0;border-top:3px solid var(--red)}.contents h2{font-size:14px;text-transform:uppercase;letter-spacing:2px;margin:0 0 16px}.contents ol{list-style:none;margin:0;padding:0}.contents a{display:flex;gap:12px;padding:7px 0;color:var(--muted);font-size:15px;line-height:1.35;text-decoration:none}.contents a:hover{color:var(--red)}.contents span{color:var(--red);font-size:12px;padding-top:2px}article{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:8px 40px;min-width:0}article section{padding:30px 0;border-bottom:1px solid var(--line)}article section:last-child{border:0}article h2{display:flex;align-items:baseline;gap:14px;font-size:25px;line-height:1.25;letter-spacing:-.4px;margin:0 0 18px}article h2 span{font-size:13px;color:var(--red);letter-spacing:1px}article p{font-size:18px;line-height:1.7;margin:14px 0;overflow-wrap:anywhere}footer{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;color:var(--muted);padding:28px 32px 40px;border-top:1px solid var(--line);font-size:14px}footer a{color:var(--muted)}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--page:#171a1e;--surface:#202328;--text:#eef0f3;--muted:#adb5bf;--line:#353a42;--red:#f08b9c;--soft:#292e35}}@media(max-width:800px){header{align-items:start;flex-direction:column;padding:24px}main{padding:40px 24px}.layout{grid-template-columns:1fr;gap:24px}.contents{position:static}.contents ol{columns:2}.contents li{break-inside:avoid}article{padding:4px 24px}footer{padding:24px}}@media(max-width:450px){.contents ol{columns:1}header nav{gap:18px}article{padding:0 20px}article h2{font-size:23px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}@media print{header nav,.contents{display:none}body{background:#fff;color:#000}main{padding:20px 0}.layout{display:block}article{border:0;padding:0}h1{font-size:36px}article p{font-size:12pt}footer{padding:16px 0}}
</style></head><body><a class="skip cursor-pointer" href="#document">Skip to document</a><header><a class="wordmark cursor-pointer" href="/identity/account/">SCORETech<small>Identity</small></a><nav aria-label="Legal documents"><a class="cursor-pointer" href="/identity/legal/terms" ${kind === "terms" ? 'aria-current="page"' : ""}>Terms of service</a><a class="cursor-pointer" href="/identity/legal/privacy" ${kind === "privacy" ? 'aria-current="page"' : ""}>Privacy policy</a><a class="cursor-pointer" href="/identity/account/">My account ↗</a></nav></header><main><div class="intro"><p class="eyebrow">SCORETech Identity · Public information</p><h1>${escape(document.title)}</h1><p class="summary">${escape(document.summary)}</p><p class="updated">Last updated <time datetime="${document.updated}">${new Date(document.updated + "T00:00:00Z").toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}</time> · <a class="cursor-pointer" href="mailto:infoscore@us.es">infoscore@us.es</a></p></div><div class="layout"><aside class="contents" aria-label="On this page"><h2>On this page</h2><ol>${navigation}</ol></aside><article id="document">${sections}</article></div></main><footer><span>© <span id="copyright-year">${new Date().getFullYear()}</span> SCORETech Identity · SCORE Excellence Unit, University of Seville</span><a class="cursor-pointer" href="mailto:infoscore@us.es">Contact SCORE</a></footer><script>document.getElementById("copyright-year").textContent=String(new Date().getFullYear());</script></body></html>`;
}
