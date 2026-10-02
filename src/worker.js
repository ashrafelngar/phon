let GKEY, TKEY, MODEL = "gemini-3.5-flash-lite";
const cache = new Map();
const MAXSPREAD = 3000; // أقصى فرق بين الأسعار المتقاربة التي نعتمد عليها (جنيه)
// نسبة الخصم من أقل سعر في الإعلانات حسب سعر الجهاز
const discountFor = (price) => price < 10000 ? 0.15 : price <= 20000 ? 0.10 : 0.06;
// الفرق بين الحد الأدنى والحد الأقصى حسب سعر الجهاز (جنيه)
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

// نختار أكبر مجموعة أسعار متقاربة، ونأخذ أقل سعر فيها، ونخصم منه discountFor فيكون هو الحد الأدنى.
// المتوسط = الأدنى + نصف الفرق، والأقصى = الأدنى + الفرق (الفرق حسب فئة سعر الجهاز)
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
  const base = p[best.i], sp = spreadFor(base);
  const min = Math.round(base * (1 - discountFor(base)) / 50) * 50;
  return { base, min, avg: min + sp / 2, max: min + sp };
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

const luhn = s => { let t = 0; for (let i = 0; i < 15; i++) { let d = +s[14 - i]; if (i % 2) { d *= 2; if (d > 9) d -= 9; } t += d; } return t % 10 === 0; };
const imei = v => { const d = String(v || "").replace(/\D/g, ""); return d.length === 15 && luhn(d) ? d : ""; };
const ser = v => String(v || "").replace(/[\s-]/g, "").toUpperCase().slice(0, 30);
const t2 = (v, n) => String(v || "").trim().slice(0, n);
const digits = v => String(v || "").replace(/\D/g, "");
const items = a => (Array.isArray(a) ? a : []).map(x => ({ label: t2(x && x.label, 120), value: t2(x && x.value, 300) })).filter(x => x.label || x.value).slice(0, 80);
const SCANPROMPT = `اقرأ كل ما هو مكتوب على ملصق كرتونة جهاز موبايل (الصورة المسماة box)، والصورة المسماة ussd هي شاشة الكود *#06# من الجهاز نفسه.
المطلوب 1) items: كل سطر أو بيان مكتوب على الكرتونة بلا استثناء، بنفس ترتيبه. لو للبيان عنوان (مثل Color أو Model) فضع ترجمته للعربي فقط في label (مثل: اللون، الموديل)، وضع قيمته في value كما هي مكتوبة حرفياً بنفس لغتها وأحرفها بلا أي ترجمة أو تعديل أو تلخيص. ولو لا يوجد عنوان ضع label فارغاً والنص كله في value كما هو. لا تحدد حقولاً مسبقة: الكرتونة قد تحتوي مواصفات كثيرة أو قليلة، اكتب الموجود فقط.
2) box: brand وmodel وram (رقم GB فقط) وstorage (رقم GB فقط) وserial وimei1 وimei2 من الكرتونة، وضع "" لما لا يظهر.
3) ussd: imei1 وimei2 وserial من شاشة *#06#، وضع "" لما لا يظهر.
لا تخمّن أبداً. أجب JSON فقط: {"items":[{"label":"","value":""}],"box":{"brand":"","model":"","ram":"","storage":"","serial":"","imei1":"","imei2":""},"ussd":{"imei1":"","imei2":"","serial":""}}`;

async function gem(parts) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": GKEY, "content-type": "application/json" },
    body: JSON.stringify({ generationConfig: { temperature: 0, responseMimeType: "application/json" }, contents: [{ parts }] })
  });
  const j = await r.json();
  if (!r.ok) throw new Error("gemini: " + JSON.stringify(j));
  const m = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no json");
  return JSON.parse(m[0]);
}

async function scan(d) {
  const parts = [{ text: SCANPROMPT }];
  const add = (label, url) => {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(url || "");
    if (!m) return false;
    parts.push({ text: label }, { inline_data: { mime_type: m[1], data: m[2] } });
    return true;
  };
  if (!add("box:", d.box) || !add("ussd:", d.ussd)) throw new Error("missing image");
  const v = await gem(parts), b = v.box || {}, u = v.ussd || {};
  return {
    box: { brand: t2(b.brand, 60), model: t2(b.model, 60), ram: digits(b.ram), storage: digits(b.storage), serial: ser(b.serial), imei1: imei(b.imei1), imei2: imei(b.imei2), items: items(v.items) },
    ussd: { imei1: imei(u.imei1), imei2: imei(u.imei2), serial: ser(u.serial) }
  };
}

async function info(d) {
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + TKEY },
    body: JSON.stringify({ query: `${d.brand} ${d.model} full specifications release date price gsmarena`, search_depth: "advanced", max_results: 8 })
  });
  const j = await r.json();
  if (!r.ok) throw new Error("tavily: " + JSON.stringify(j));
  const res = j.results || [];
  if (!res.length) return { items: [], sources: [] };
  const src = res.map((x, i) => `[${i + 1}] ${x.title}\n${(x.content || "").slice(0, 1500)}`).join("\n\n");
  const v = await gem([{ text: `من نتائج البحث التالية فقط، استخرج كل المعلومات الصحيحة المتاحة عن الجهاز ${d.brand} ${d.model}، حتى لو بدت غير مهمة: الاسم الكامل، تاريخ الإصدار، سعر الإطلاق، الأبعاد والوزن، الشاشة (الحجم والنوع والدقة والتردد)، المعالج والـGPU، الرام والذاكرة الداخلية المتاحة، الكاميرات الخلفية والأمامية، البطارية والشحن، نظام التشغيل، الشبكات وعدد الشرائح، الاتصال (واي فاي، بلوتوث، NFC)، المنافذ، الحساسات، الألوان، مقاومة الماء والغبار، وأي معلومة أخرى. قواعد: اكتب فقط ما هو مذكور في النتائج، ولو تعارضت المصادر في معلومة فلا تذكرها، ولا تخمّن، وبلا تكرار. كل عنصر label عربي قصير وvalue بقيمته. حتى 40 عنصر.\n\n${src}\n\nأجب JSON فقط: {"items":[{"label":"تاريخ الإصدار","value":"..."}]}` }]);
  return { items: items(v.items).slice(0, 40), sources: res.slice(0, 3).map(x => ({ title: t2(x.title, 80), url: x.url })) };
}

const INSPECTPROMPT = `أنت خبير فحص موبايلات مستعملة. الصورة المسماة front هي وش الجهاز والشاشة مطفية، والمسماة back هي ظهر الجهاز.
افحص ما هو ظاهر في الصور فقط ولا تخمّن ما لا يظهر. لو الصور غير واضحة أو ليست لموبايل أو الشاشة مضاءة في صورة الوش فاجعل valid=false واكتب السبب بالعربية في reason.
حدد grade: excellent (ممتاز: لا توجد أي خدوش أو علامات ظاهرة)، very_good (جيد جداً: خدوش أو علامات خفيفة جداً بالكاد تظهر)، good (جيد: خدوش أو علامات استعمال واضحة بدون كسر)، poor (ضعيف: كسر أو شرخ أو انبعاج أو تلف واضح).
notes: كل ملاحظة ظاهرة (كسر، شرخ، خدوش، انبعاج، تقشير دهان، بقع أو ظلال على الشاشة، تلف في عدسة الكاميرا، علامات في الإطار وغيرها) كعنصر {"area":"المكان مثل الشاشة أو الظهر أو الإطار أو الكاميرا","issue":"وصف قصير بالعربية","severity":"low أو medium أو high"}. لو لا توجد ملاحظات اترك القائمة فارغة.
summary: جملة عربية واحدة.
أجب JSON فقط: {"valid":true,"reason":"","grade":"","notes":[],"summary":""}`;

async function inspect(d) {
  const parts = [{ text: INSPECTPROMPT }];
  for (const [label, url] of [["front:", d.front], ["back:", d.back]]) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(url || "");
    if (!m) throw new Error("missing image");
    parts.push({ text: label }, { inline_data: { mime_type: m[1], data: m[2] } });
  }
  const v = await gem(parts);
  if (v.valid === false) return { valid: false, reason: t2(v.reason, 200) || "الصور مش واضحة" };
  if (!["excellent", "very_good", "good", "poor"].includes(v.grade)) throw new Error("bad grade");
  const notes = (Array.isArray(v.notes) ? v.notes : []).map(n => ({ area: t2(n && n.area, 40), issue: t2(n && n.issue, 140), severity: ["low", "medium", "high"].includes(n && n.severity) ? n.severity : "low" })).filter(n => n.issue).slice(0, 12);
  return { valid: true, grade: v.grade, notes, summary: t2(v.summary, 200) };
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
    if (u.pathname === "/api/scan" && request.method === "POST") {
      GKEY = env.GEMINI_API_KEY; if (env.MODEL) MODEL = env.MODEL;
      if (!GKEY) return J({ error: "المفتاح غير مضبوط" }, 500);
      try { return J(await scan(await request.json())); }
      catch (e) { console.error(e.message); return J({ error: "فشل قراءة الصور" }, 500); }
    }
    if (u.pathname === "/api/inspect" && request.method === "POST") {
      GKEY = env.GEMINI_API_KEY; if (env.MODEL) MODEL = env.MODEL;
      if (!GKEY) return J({ error: "المفتاح غير مضبوط" }, 500);
      try { return J(await inspect(await request.json())); }
      catch (e) { console.error(e.message); return J({ error: "فشل فحص الصور" }, 500); }
    }
    if (u.pathname === "/api/info" && request.method === "POST") {
      if (!setup(env)) return J({ error: "المفاتيح غير مضبوطة" }, 500);
      try { const d = await request.json(); if (!d.brand || !d.model) return J({ error: "بيانات ناقصة" }, 400); return J(await info(d)); }
      catch (e) { console.error(e.message); return J({ error: "فشل" }, 500); }
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
