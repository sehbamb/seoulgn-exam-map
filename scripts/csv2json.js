const fs = require("fs");
const path = require("path");
const csv = require("csvtojson");

(async () => {
  const src = path.join(__dirname, "..", "data", "centers.csv");
  const dst = path.join(__dirname, "..", "public", "centers.json");

  if (!fs.existsSync(src)) {
    console.warn("[csv2json] data/centers.csv not found. skip.");
    process.exit(0);
  }

  const rows = await csv({ trim: true }).fromFile(src);
  const norm = rows.map(r => {
    const o = {};
    for (const k of Object.keys(r)) o[k.trim().toLowerCase()] = (r[k] ?? "").toString().trim();
    const lat = Number(o.lat),
      lng = Number(o.lng);
    const tags = (o.tags || "")
      .replace(/\|/g, ";")
      .split(/[;,]/)
      .map(s => s.trim())
      .filter(Boolean);
    return {
      id: o.id,
      name: o.name,
      address: o.address || undefined,
      lat: isNaN(lat) ? undefined : lat,
      lng: isNaN(lng) ? undefined : lng,
      phone: o.phone || undefined,
      hours: o.hours || undefined,
      note: o.note || undefined,
      tags
    };
  });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, JSON.stringify(norm, null, 2), "utf-8");
  console.log(`[csv2json] wrote ${norm.length} records -> public/centers.json`);
})();
