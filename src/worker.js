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

const GRADE = { excellent: "ممتاز", very_good: "جيد جداً", good: "جيد", poor: "ضعيف (كسر أو تلف واضح)" };
function condQuery(d, c) {
  if (c === 2) {
    if (d.grade === "poor") return "شاشة مكسورة";
    const m = { "شاشة": "متغير شاشة", "باغة": "متغير باغة", "بطارية": "متغير بطارية" };
    return (d.parts || []).map(p => m[p]).filter(Boolean).join(" ") || "صيانة متغير قطعة";
  }
  if (c === 0) return "كسر زيرو بالعلبة";
  return d.grade === "very_good" ? "حالة ممتازة استعمال خفيف" : "خدوش بسيطة";
}

async function tavily(d, c) {
  const q = `${d.brand} ${d.model} ${d.ram}GB ${d.storage ? d.storage + "GB " : ""}مستعمل ${condQuery(d, c)} للبيع في مصر دوبيزل السعر بالجنيه`;
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
  const src = results.map((x, i) => `[${i + 1}] ${x.title}\n${x.url}\n${x.content}`).join("\n\n");
  const det = [
    `الجهاز: ${d.brand} ${d.model} رام ${d.ram}${d.storage ? " وذاكرة " + d.storage + "GB" : ""}`,
    `الحالة المطلوبة: ${COND[c].ar}`,
    d.grade ? `درجة فحص الشكل: ${GRADE[d.grade]}` : "",
    `العيوب الظاهرة: ${(d.defects || []).length ? d.defects.join("، ") : "لا توجد"}`,
    `القطع المستبدلة: ${(d.parts || []).length ? d.parts.join("، ") : "لا توجد"}`,
    `ملاحظات أخرى: ${[d.customs, ...(d.notes || [])].filter(Boolean).join("، ")}`
  ].filter(Boolean).join("\n");
  return `أنت تستخرج سعر الجهاز المستعمل في مصر من نتائج البحث فقط.
${det}

نتائج البحث:
${src}

المطلوب: من الأسعار المذكورة صراحةً في النتائج أعلاه فقط، استخرج قائمة بسعر كل إعلان مطابق لهذا الجهاز بهذه الحالة، بالجنيه المصري، رقم واحد لكل إعلان.
القواعد:
- اعتمد فقط على الإعلانات المطابقة للجهاز (الشركة والموديل والرام والذاكرة، ولو الذاكرة غير مذكورة فتجاهلها) والمطابقة لحالته وعيوبه وقطعه المستبدلة أعلاه. مثلاً لو الجهاز فيه شاشة مكسورة أو متغيرة فاعتمد على إعلانات الأجهزة المكسورة أو المتغير شاشتها فقط. ولو الجهاز بلا عيوب ولا قطع مستبدلة فتجاهل إعلانات الأجهزة المكسورة أو المتغير فيها قطع.
- للحالة الجيدة يمكن قبول الإعلان الذي لا يذكر حالة الجهاز، أما للممتاز أو الصيانة فيجب أن يذكر الإعلان ذلك صراحةً.
- تجاهل سعر الجهاز الجديد وأسعار الدول الأخرى وأي عملة غير الجنيه المصري.
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
  const arr = x => (Array.isArray(x) ? x : []).slice(0, 12).map(v => String(v).slice(0, 140));
  d.defects = arr(d.defects); d.parts = arr(d.parts); d.notes = arr(d.notes);
  d.storage = String(d.storage || "").replace(/\D/g, "").slice(0, 4);
  d.grade = GRADE[d.grade] ? d.grade : "";
  const key = [d.brand, d.model, d.ram, d.storage, c, d.grade, d.defects.join(), d.parts.join(), d.customs, d.notes.join()].join("|").toLowerCase();
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

// ---------- تأكيد رقم الموبايل برسالة SMS (SMS Misr) ----------
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
const same = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
const normPhone = v => { const m = /^(?:0|20)?(1[0125]\d{8})$/.exec(String(v || "").replace(/\D/g, "")); return m ? "20" + m[1] : ""; };
const otpSecret = env => env.OTP_SECRET || (env.GEMINI_API_KEY || "") + (env.TAVILY_API_KEY || "");
const sentAt = new Map(), sentIp = new Map(), tries = new Map();
const recent = (m, k, ms) => { if (m.size > 5000) m.clear(); const now = Date.now(), a = (m.get(k) || []).filter(t => now - t < ms); m.set(k, a); return a; };

async function sendSms(env, phone, code) {
  const qs = new URLSearchParams({ environment: env.SMSMISR_ENV === "2" ? "2" : "1", username: env.SMSMISR_USER, password: env.SMSMISR_PASS, sender: env.SMSMISR_SENDER, mobile: phone, template: env.SMSMISR_TEMPLATE, otp: code });
  const r = await fetch("https://smsmisr.com/api/OTP/?" + qs, { method: "POST" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !["4901", "1901"].includes(String(j.code))) throw new Error("sms: " + JSON.stringify(j));
}

const emailNorm = v => { v = String(v || "").trim().toLowerCase(); return v.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? v : ""; };
async function sendMail(env, to, code) {
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ sender: { name: "فاحص الموبيل المستعمل", email: env.MAIL_FROM }, to: [{ email: to }], subject: "كود التحقق: " + code,
      htmlContent: `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;text-align:right"><h2>فاحص الموبيل المستعمل</h2><p>كود التحقق الخاص بك:</p><p style="font-size:32px;font-weight:bold;letter-spacing:6px">${code}</p><p>الكود صالح لمدة 5 دقائق. لا تشاركه مع أحد.</p></div>` })
  });
  if (!r.ok) throw new Error("mail: " + r.status + " " + (await r.text()).slice(0, 200));
}

async function otpSend(request, env) {
  const b = await request.json(), wantMail = b.email !== undefined, id = wantMail ? emailNorm(b.email) : normPhone(b.phone);
  if (!id) return J({ error: wantMail ? "اكتب إيميل صحيح" : "اكتب رقم موبايل مصري صحيح" }, 400);
  const ip = request.headers.get("cf-connecting-ip") || "x", a = recent(sentAt, id, 6e5), c = recent(sentIp, ip, 36e5);
  if (a.length >= 3 || c.length >= 10) return J({ error: "محاولات كتير، جرّب بعد شوية" }, 429);
  a.push(Date.now()); c.push(Date.now());
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000)), exp = Date.now() + 3e5;
  const token = exp + "." + await hmac(otpSecret(env), `${id}|${exp}|${code}`);
  if (wantMail && env.BREVO_API_KEY && env.MAIL_FROM) {
    try { await sendMail(env, id, code); } catch (e) { console.error(e.message); return J({ error: "فشل إرسال الإيميل، جرّب تاني" }, 502); }
    return J({ token });
  }
  if (!wantMail && env.SMSMISR_USER && env.SMSMISR_PASS && env.SMSMISR_SENDER && env.SMSMISR_TEMPLATE) {
    try { await sendSms(env, id, code); } catch (e) { console.error(e.message); return J({ error: "فشل إرسال الرسالة، جرّب تاني" }, 502); }
    return J({ token });
  }
  if (env.OTP_DEMO === "1") return J({ token, demo: code });
  return J({ error: wantMail ? "خدمة الإيميل مش متفعّلة لسه" : "خدمة الرسائل مش متفعّلة لسه" }, 503);
}

async function otpVerify(request, env) {
  const b = await request.json(), id = b.email !== undefined ? emailNorm(b.email) : normPhone(b.phone), code = String(b.code), [exp, sig] = String(b.token || "").split(".");
  if (!id || !/^\d{6}$/.test(code) || !exp || !sig) return J({ ok: false, error: "بيانات ناقصة" }, 400);
  if (+exp < Date.now()) return J({ ok: false, error: "الكود انتهت صلاحيته، اطلب كود جديد" }, 400);
  if (tries.size > 5000) tries.clear();
  const n = (tries.get(sig) || 0) + 1; tries.set(sig, n);
  if (n > 5) return J({ ok: false, error: "محاولات كتير، اطلب كود جديد" }, 429);
  return same(await hmac(otpSecret(env), `${id}|${exp}|${code}`), sig) ? J({ ok: true }) : J({ ok: false, error: "الكود غلط" }, 400);
}

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
    if (u.pathname === "/api/otp/send" && request.method === "POST") { try { return await otpSend(request, env); } catch (e) { console.error(e.message); return J({ error: "فشل" }, 500); } }
    if (u.pathname === "/api/otp/verify" && request.method === "POST") { try { return await otpVerify(request, env); } catch (e) { console.error(e.message); return J({ error: "فشل" }, 500); } }
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
        const r = await getRanges({ brand: q.get("brand") || "Realme", model: q.get("model") || "C55", ram: q.get("ram") || "8", cond: q.get("c") || "1", storage: q.get("st") || "", grade: q.get("g") || "", customs: "", notes: [] });
        return T("الحالة: " + r.cond + "\nعدد نتائج البحث: " + r.sources + "\nالأسعار المستخرجة: " + r.prices.join(", ") + "\nالمدى: " + JSON.stringify(r.ranges[r.cond]));
      } catch (e) { return T("خطأ: " + e.message, 500); }
    }
    return new Response("Not found", { status: 404 });
  }
};
