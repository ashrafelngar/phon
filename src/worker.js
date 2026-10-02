let GKEY, TKEY, MODEL = "gemini-3.5-flash-lite";
const cache = new Map();
const MAXSPREAD = 3000; // أقصى فرق بين الأسعار المتقاربة التي نعتمد عليها (جنيه)
// نسبة الخصم من متوسط الإعلانات حسب سعر الجهاز
const discountFor = (price) => price < 10000 ? 0.15 : price <= 20000 ? 0.10 : 0.06;
// الفرق بين الحد الأدنى والحد الأقصى حسب متوسط سعر الإعلانات (جنيه)
const spreadFor = (price) => price < 10000 ? 500 : price <= 20000 ? 1500 : 2500;
const COND = [
  { key: "excellent", ar: "ممتاز / كسر زيرو بالعلبة (لم يُستعمل تقريباً)", q: "حالة ممتازة كسر زيرو بالعلبة" },
  { key: "good", ar: "جيد أو به خدوش بسيطة", q: "حالة جيدة خدوش بسيطة" },
  { key: "repaired", ar: "تمت صيانته (تغيير شاشة أو باغة)", q: "متغير شاشة صيانة" }
];

async function tavily(d, c) {
  const q = `${d.brand} ${d.model} ${d.ram}GB مستعمل ${COND[c].q} للبيع في مصر دوبيزل السعر بالجنيه`;
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

function buildPrompt(d, c, results) {
  const notes = [d.customs, ...(d.notes || [])].filter(Boolean).join("، ");
  const src = results.map((x, i) => `[${i + 1}] ${x.title}\n${x.url}\n${x.content}`).join("\n\n");
  return `أنت تستخرج سعر الجهاز المستعمل في مصر من نتائج البحث فقط.
الجهاز: ${d.brand} ${d.model} رام ${d.ram}
الحالة المطلوبة: ${COND[c].ar}
ملاحظات على الجهاز: ${notes}

نتائج البحث:
${src}

المطلوب: من الأسعار المذكورة صراحةً في النتائج أعلاه فقط، استخرج قائمة بسعر كل إعلان مطابق للجهاز في الحالة المطلوبة، بالجنيه المصري، رقم واحد لكل إعلان.
القواعد:
- اعتمد فقط على الإعلانات التي تتطابق حالتها مع الحالة المطلوبة. للحالة الجيدة يمكن قبول الإعلان الذي لا يذكر حالة الجهاز، أما للممتاز أو الصيانة فيجب أن يذكر الإعلان ذلك صراحةً.
- تجاهل سعر الجهاز الجديد وأسعار الدول الأخرى وأي عملة غير الجنيه المصري، وتجاهل الإعلانات لجهاز أو رام مختلف.
- تجاهل الأسعار الشاذة (الأعلى أو الأقل بكثير من باقي الأسعار).
- لا تخمّن أبداً: لو لا توجد أسعار ضع قائمة فارغة.
أجب بـ JSON فقط بهذا الشكل: {"prices":[0,0,0]}`;
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
  const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no json. الرد كان: " + text.slice(0, 300));
  const v = JSON.parse(m[0]);
  return Array.isArray(v.prices) ? v.prices.map(Number).filter(x => x > 0) : [];
}

// نختار أكبر مجموعة أسعار متقاربة، ونخصم discountFor من متوسطها فيكون هو الحد الأدنى.
// المتوسط = الأدنى + نصف الفرق، والأقصى = الأدنى + الفرق (الفرق حسب فئة سعر الجهاز)
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
function tight(prices) {
  const p = [...prices].sort((a, b) => a - b);
  let best = null;
  for (let i = 0; i < p.length; i++) {
    let j = i;
    while (j + 1 < p.length && p[j + 1] - p[i] <= MAXSPREAD) j++;
    const n = j - i + 1;
    if (!best || n > best.n) best = { n, i, j };
  }
  if (!best || best.n < 2) return null;
  const m = mean(p.slice(best.i, best.j + 1)), sp = spreadFor(m);
  const min = Math.round(m * (1 - discountFor(m)) / 50) * 50;
  return { base: Math.round(m / 50) * 50, min, avg: min + sp / 2, max: min + sp };
}

async function getRanges(d) {
  const c = [0, 1, 2].includes(+d.cond) ? +d.cond : 1, now = Date.now();
  const key = [d.brand, d.model, d.ram, c, d.customs, (d.notes || []).join()].join("|").toLowerCase();
  const hit = cache.get(key);
  if (hit && now - hit.t < 864e5) return hit.v;
  const results = await tavily(d, c);
  const prices = results.length ? await askGemini(buildPrompt(d, c, results)) : [];
  const range = tight(prices);
  const out = { ranges: { excellent: null, good: null, repaired: null, [COND[c].key]: range }, sources: results.length, prices, cond: COND[c].key };
  cache.set(key, { t: now, v: out });
  return out;
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
      const q = u.searchParams;
      try {
        const r = await getRanges({ brand: q.get("brand") || "Realme", model: q.get("model") || "C55", ram: q.get("ram") || "8", cond: q.get("c") || "1", customs: "", notes: [] });
        return T("الحالة: " + r.cond + "\nعدد نتائج البحث: " + r.sources + "\nالأسعار المستخرجة: " + r.prices.join(", ") + "\nالمدى: " + JSON.stringify(r.ranges[r.cond]));
      } catch (e) { return T("خطأ: " + e.message, 500); }
    }
    return new Response("Not found", { status: 404 });
  }
};
