// Rebuilds src/core/google-fonts.json — the Google Fonts catalogue the capture uses to tell
// whether a family is in Figma (Figma has every Google font), under which exact name, with
// which weights and whether it covers Cyrillic. Run: npm run fonts:catalog
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";
import { fileURLToPath } from "node:url";

dns.setDefaultResultOrder("ipv4first");
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "src/core/google-fonts.json");

const res = await fetch("https://fonts.google.com/metadata/fonts");
if (!res.ok) throw new Error(`fonts.google.com: HTTP ${res.status}`);
const data = JSON.parse((await res.text()).replace(/^\)\]\}'\s*/, ""));

// Weights 100…900 as bits 0…8.
const mask = (keys) => keys.reduce((m, k) => m | (1 << (Number.parseInt(k, 10) / 100 - 1)), 0);
const families = data.familyMetadataList
  .map((f) => {
    const keys = Object.keys(f.fonts || {}).filter((k) => /^[1-9]00i?$/.test(k));
    const flags = (f.subsets?.includes("cyrillic") ? 1 : 0) | (f.axes?.some((a) => a.tag === "wght") ? 2 : 0);
    return [f.family, mask(keys.filter((k) => !k.endsWith("i"))), mask(keys.filter((k) => k.endsWith("i"))), flags];
  })
  .filter(([, weights, italics]) => weights || italics)
  .sort((a, b) => a[0].localeCompare(b[0]));

const json = JSON.stringify({ updated: new Date().toISOString().slice(0, 10), format: "[family, weights bits 100..900, italic weights bits, 1=cyrillic|2=variable]", families });
fs.writeFileSync(OUT, json.replace(/\],\[/g, "],\n[") + "\n");
console.log(`${families.length} families → ${path.relative(ROOT, OUT)} (${(json.length / 1024).toFixed(0)} KB)`);
