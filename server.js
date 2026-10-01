// سيرفر بدون أي مكتبات خارجية. يحتاج Node 18+ ومتغير GEMINI_API_KEY
const http = require("http"), fs = require("fs"), path = require("path");
const KEY = process.env.GEMINI_API_KEY, MODEL = process.env.MODEL || "gemini-flash-latest", PORT = process.env.PORT || 3000;
if (!KEY) { console.error("ضع GEMINI_API_KEY أولاً (متغير بيئة، مش داخل الكود)"); process.exit(1); }
const cache = new Map(), hits = new Map(); // كاش 24 ساعة + حد 30 طلب/ساعة لكل IP

function buildPrompt(d) {
  const notes = [d.customs, ...(d.notes || [])].filter(Boolean).join("، ");
  return `ما سعر جهاز ${d.brand} ${d.model} رام ${d.ram} مستعمل في مصر الآن؟
أعطني مدى السعر بالجنيه المصري (أقل سعر وأعلى سعر) لكل حالة من الحالات الثلاث:
1. حالة ممتازة / كسر زيرو (بالعلبة).
2. حالة جيدة أو بها خدوش بسيطة.
3. تمت صيانته (تغيير شاشة أو باغة).
ملاحظات على الجهاز: ${notes}.
اعتمد على إعلانات البيع المستعمل الحديثة داخل مصر فقط، ولا تعتمد على سعر الجهاز الجديد أو أسعار دول تانية. لو مفيش بيانات كافية قل ذلك بدل التخمين.

ابحث على الإنترنت ثم أجب بـ JSON فقط بدون أي كلام آخر بهذا الشكل بالجنيه المصري، وضع null لأي حالة ليس لها بيانات كافية:
{"excellent":{"min":0,"max":0},"good":{"min":0,"max":0},"repaired":{"min":0,"max":0}}`;
}

async function askGemini(prompt) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({ tools: [{ google_search: {} }], generationConfig: { temperature: 0.2 },
      contents: [{ parts: [{ text: prompt }] }] })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no json");
  const raw = JSON.parse(m[0]), out = {};
  for (const k of ["excellent", "good", "repaired"]) {
    const v = raw[k];
    out[k] = v && +v.min > 0 && +v.max >= +v.min ? { min: +v.min, max: +v.max } : null;
  }
  return out;
}

const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/price") {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress, now = Date.now();
    const h = (hits.get(ip) || []).filter(t => now - t < 36e5);
    if (h.length >= 30) return send(res, 429, { error: "كتير أوي، جرّب بعد شوية" });
    hits.set(ip, [...h, now]);
    let body = ""; for await (const c of req) { body += c; if (body.length > 5e4) return send(res, 413, {}); }
    try {
      const d = JSON.parse(body);
      for (const k of ["brand", "model", "ram"]) if (!d[k] || String(d[k]).length > 60) return send(res, 400, { error: "بيانات ناقصة" });
      const key = [d.brand, d.model, d.ram, d.customs, (d.notes || []).join()].join("|").toLowerCase(), c = cache.get(key);
      if (c && now - c.t < 864e5) return send(res, 200, { ranges: c.v, cached: true });
      const v = await askGemini(buildPrompt(d));
      cache.set(key, { t: now, v });
      send(res, 200, { ranges: v });
    } catch (e) { console.error(e.message); send(res, 500, { error: "فشل جلب الأسعار" }); }
    return;
  }
  fs.readFile(path.join(__dirname, "index.html"), (e, data) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(data);
  });
}).listen(PORT, () => console.log("http://localhost:" + PORT));
