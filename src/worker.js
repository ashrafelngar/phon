let GKEY, TKEY, MODEL = "gemini-3.5-flash-lite";
const cache = new Map();

async function tavily(d) {
  const q = `${d.brand} ${d.model} ${d.ram}GB مستعمل للبيع في مصر السعر بالجنيه`;
  const call = (extra) => fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + TKEY },
    body: JSON.stringify({ query: q, search_depth: "basic", max_results: 10, ...extra })
  });
  let r = await call({ country: "egypt" });
  if (!r.ok) r = await call({});
  const j = await r.json();
  if (!r.ok) throw new Error("tavily: " + JSON.stringify(j));
  return (j.results || []).map(x => ({ title: x.title, url: x.url, content: (x.content || "").slice(0, 600) }));
}

function buildPrompt(d, results) {
  const notes = [d.customs, ...(d.notes || [])].filter(Boolean).join("، ");
  const src = results.map((x, i) => `[${i + 1}] ${x.title}\n${x.url}\n${x.content}`).join("\n\n");
  return `أنت تستخرج أسعار الجهاز المستعمل في مصر من نتائج البحث فقط.
الجهاز: ${d.brand} ${d.model} رام ${d.ram}
ملاحظات: ${notes}

نتائج البحث:
${src}

المطلوب: من الأسعار المذكورة صراحةً في النتائج أعلاه فقط، استخرج مدى السعر بالجنيه المصري (min وmax) لكل حالة:
excellent = ممتاز / كسر زيرو بالعلبة
good = جيد أو خدوش بسيطة (وأي إعلان لا يذكر حالة الجهاز)
repaired = تمت صيانته (تغيير شاشة أو باغة)
القواعد: تجاهل سعر الجهاز الجديد وأسعار الدول الأخرى وأي عملة غير الجنيه المصري، وتجاهل الإعلانات لجهاز أو رام مختلف. لا تخمّن أبداً: لو لا توجد أسعار كافية لحالة ضع null.
أجب بـ JSON فقط بهذا الشكل:
{"excellent":{"min":0,"max":0},"good":{"min":0,"max":0},"repaired":{"min":0,"max":0}}`;
}

async function askGemini(prompt) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": GKEY, "content-type": "application/json" },
    body: JSON.stringify({
      generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
      contents: [{ parts: [{ text: prompt }] }]
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error("gemini: " + JSON.stringify(j));
  const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no json. الرد كان: " + text.slice(0, 300));
  const raw = JSON.parse(m[0]), out = {};
  for (const k of ["excellent", "good", "repaired"]) {
    const v = raw[k];
    out[k] = v && +v.min > 0 && +v.max >= +v.min ? { min: +v.min, max: +v.max } : null;
  }
  return out;
}

async function getRanges(d) {
  const key = [d.brand, d.model, d.ram, d.customs, (d.notes || []).join()].join("|").toLowerCase(), now = Date.now();
  const c = cache.get(key);
  if (c && now - c.t < 864e5) return { ranges: c.v, sources: c.n, cached: true };
  const results = await tavily(d);
  const empty = { excellent: null, good: null, repaired: null };
  const v = results.length ? await askGemini(buildPrompt(d, results)) : empty;
  cache.set(key, { t: now, v, n: results.length });
  return { ranges: v, sources: results.length };
}

const J = (o, c = 200) => new Response(JSON.stringify(o), { status: c, headers: { "content-type": "application/json; charset=utf-8" } });
const T = (t, c = 200) => new Response(t, { status: c, headers: { "content-type": "text/plain; charset=utf-8" } });

function setup(env) {
  GKEY = env.GEMINI_API_KEY; TKEY = env.TAVILY_API_KEY;
  if (env.MODEL) MODEL = env.MODEL;
  return GKEY && TKEY;
}

export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    if (u.pathname === "/api/price" && request.method === "POST") {
      if (!setup(env)) return J({ error: "المفاتيح غير مضبوطة" }, 500);
      try {
        const d = await request.json();
        for (const k of ["brand", "model", "ram"]) if (!d[k] || String(d[k]).length > 60) return J({ error: "بيانات ناقصة" }, 400);
        const r = await getRanges(d);
        return J({ ranges: r.ranges });
      } catch (e) { console.error(e.message); return J({ error: "فشل جلب الأسعار" }, 500); }
    }
    if (u.pathname === "/test") {
      if (!setup(env)) return T("ناقص مفتاح: تأكد من GEMINI_API_KEY و TAVILY_API_KEY في Cloudflare", 500);
      try {
        const r = await getRanges({ brand: "Samsung", model: "Galaxy A15", ram: "8", customs: "", notes: [] });
        return T("عدد نتائج البحث: " + r.sources + "\n" + JSON.stringify(r.ranges));
      } catch (e) { return T("خطأ: " + e.message, 500); }
    }
    return new Response("Not found", { status: 404 });
  }
};
