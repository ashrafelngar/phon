let KEY, MODEL = "gemini-flash-latest";
const cache = new Map();

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
  if (!m) throw new Error("no json. الرد كان: " + text.slice(0, 300));
  const raw = JSON.parse(m[0]), out = {};
  for (const k of ["excellent", "good", "repaired"]) {
    const v = raw[k];
    out[k] = v && +v.min > 0 && +v.max >= +v.min ? { min: +v.min, max: +v.max } : null;
  }
  return out;
}

const J = (o, c = 200) => new Response(JSON.stringify(o), { status: c, headers: { "content-type": "application/json; charset=utf-8" } });
const T = (t, c = 200) => new Response(t, { status: c, headers: { "content-type": "text/plain; charset=utf-8" } });

async function price(request, env) {
  KEY = env.GEMINI_API_KEY; if (env.MODEL) MODEL = env.MODEL;
  if (!KEY) return J({ error: "المفتاح غير مضبوط" }, 500);
  try {
    const d = await request.json(), now = Date.now();
    for (const k of ["brand", "model", "ram"]) if (!d[k] || String(d[k]).length > 60) return J({ error: "بيانات ناقصة" }, 400);
    const key = [d.brand, d.model, d.ram, d.customs, (d.notes || []).join()].join("|").toLowerCase(), c = cache.get(key);
    if (c && now - c.t < 864e5) return J({ ranges: c.v, cached: true });
    const v = await askGemini(buildPrompt(d));
    cache.set(key, { t: now, v });
    return J({ ranges: v });
  } catch (e) { console.error(e.message); return J({ error: "فشل جلب الأسعار" }, 500); }
}

export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    if (u.pathname === "/api/price" && request.method === "POST") return price(request, env);
    if (u.pathname === "/test") {
      KEY = env.GEMINI_API_KEY;
      if (env.MODEL) MODEL = env.MODEL;
      if (!KEY) return T("المفتاح مش موجود في Cloudflare", 500);
      try {
        const v = await askGemini(buildPrompt({ brand: "Samsung", model: "Galaxy A15", ram: "8", customs: "", notes: [] }));
        return T(JSON.stringify(v));
      } catch (e) {
        return T("خطأ: " + e.message, 500);
      }
    }
    return new Response("Not found", { status: 404 });
  }
};
