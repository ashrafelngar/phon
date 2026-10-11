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

const retry = async f => { try { return await f(); } catch (e) { await new Promise(r => setTimeout(r, 700)); return f(); } };
async function tsearch(q) {
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

function buildPrompt(d, c, results, mode = "exact") {
  const src = results.map((x, i) => `[${i + 1}] ${x.title}\n${x.url}\n${x.content}`).join("\n\n");
  const dev = `الجهاز: ${d.brand} ${d.model} رام ${d.ram}${d.storage ? " وذاكرة " + d.storage + "GB" : ""}`;
  const det = mode === "exact" ? [
    dev,
    `الحالة المطلوبة: ${COND[c].ar}`,
    d.grade ? `درجة فحص الشكل: ${GRADE[d.grade]}` : "",
    `العيوب الظاهرة: ${(d.defects || []).length ? d.defects.join("، ") : "لا توجد"}`,
    `القطع المستبدلة: ${(d.parts || []).length ? d.parts.join("، ") : "لا توجد"}`,
    `ملاحظات أخرى: ${[d.customs, ...(d.notes || [])].filter(Boolean).join("، ")}`
  ].filter(Boolean).join("\n") : dev;
  const rule = mode === "exact"
    ? `- اعتمد فقط على الإعلانات المطابقة للجهاز (الشركة والموديل والرام والذاكرة، ولو الذاكرة غير مذكورة فتجاهلها) والمطابقة لحالته وعيوبه وقطعه المستبدلة أعلاه. مثلاً لو الجهاز فيه شاشة مكسورة أو متغيرة فاعتمد على إعلانات الأجهزة المكسورة أو المتغير شاشتها فقط. ولو الجهاز بلا عيوب ولا قطع مستبدلة فتجاهل إعلانات الأجهزة المكسورة أو المتغير فيها قطع.\n- للحالة الجيدة يمكن قبول الإعلان الذي لا يذكر حالة الجهاز، أما للممتاز أو الصيانة فيجب أن يذكر الإعلان ذلك صراحةً.`
    : `- اعتمد على أي إعلان لنفس الجهاز (الشركة والموديل) بغض النظر عن حالته. تجاهل الإعلانات التي تذكر رام أو ذاكرة مختلفة عن المطلوب، وتجاهل إعلانات الأجهزة المختلفة.`;
  return `أنت تستخرج سعر الجهاز المستعمل في مصر من نتائج البحث فقط.
${det}

نتائج البحث:
${src}

المطلوب: من الأسعار المذكورة صراحةً في النتائج أعلاه فقط، استخرج قائمة بسعر كل إعلان مطابق، بالجنيه المصري، رقم واحد لكل إعلان.
القواعد:
${rule}
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
function tight(prices, minN = 2) {
  const p = [...prices].sort((a, b) => a - b);
  let best = null;
  for (let i = 0; i < p.length; i++) {
    let j = i;
    while (j + 1 < p.length && p[j + 1] - p[i] <= MAXSPREAD) j++;
    const n = j - i + 1;
    if (!best || n > best.n) best = { n, i, j };
  }
  if (!best || best.n < minN) return null;
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
  const base = `${d.brand} ${d.model}`, ramq = `${d.ram}GB${d.storage ? " " + d.storage + "GB" : ""}`;
  // نبدأ ببحث مطابق للحالة، ولو ما لقيناش أسعار نوسّع البحث تدريجياً (والنتيجة تتعلّم "تقريبية")
  const stages = [
    { q: `${base} ${ramq} مستعمل ${condQuery(d, c)} للبيع في مصر دوبيزل السعر بالجنيه`, mode: "exact", min: 2 },
    { q: `${base} ${ramq} مستعمل للبيع في مصر دوبيزل السعر بالجنيه`, mode: "any", min: 1 },
    { q: `${base} مستعمل للبيع في مصر السعر بالجنيه`, mode: "any", min: 1 }
  ];
  let range = null, prices = [], n = 0;
  for (const [i, st] of stages.entries()) {
    const results = await retry(() => tsearch(st.q));
    n = results.length;
    if (!results.length) continue;
    prices = await retry(() => askGemini(buildPrompt(d, c, results, st.mode)));
    range = tight(prices, st.min);
    if (range) { if (i > 0) range.approx = true; break; }
  }
  const out = { ranges: { excellent: null, good: null, repaired: null, [COND[c].key]: range }, sources: n, prices, cond: COND[c].key };
  if (range) cache.set(key, { t: now, v: out });
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
4) box_valid: اجعلها true فقط لو الصورة المسماة box هي فعلاً كرتونة (علبة) موبايل أو ملصق بيانات جهاز عليه مواصفات أو أرقام الجهاز. لو الصورة لأي شيء آخر (شخص، مكان، شيء عادي، جهاز بدون علبة، مستند، شاشة...) فاجعلها false واترك items فارغة ولا تخترع أي بيانات.
لا تخمّن أبداً. أجب JSON فقط: {"box_valid":false,"items":[{"label":"","value":""}],"box":{"brand":"","model":"","ram":"","storage":"","serial":"","imei1":"","imei2":""},"ussd":{"imei1":"","imei2":"","serial":""}}`;

const FALLBACK_MODEL = "gemini-3.1-flash-lite";
async function gem(parts) {
  const errs = [];
  for (const m of [...new Set([MODEL, FALLBACK_MODEL])]) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": GKEY, "content-type": "application/json" },
        body: JSON.stringify({ generationConfig: { responseMimeType: "application/json" }, contents: [{ parts }] })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(`${m} ${r.status}: ${(j.error && j.error.message) || JSON.stringify(j)}`);
      const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
      const mm = text.match(/\{[\s\S]*\}/);
      if (!mm) throw new Error(`${m}: no json (${text.slice(0, 100)})`);
      return JSON.parse(mm[0]);
    } catch (e) { errs.push(e.message); }
  }
  throw new Error(errs.join(" | ").slice(0, 400));
}
const dataUrl = u => {
  u = String(u || ""); const k = u.indexOf(";base64,"), mime = u.slice(5, k);
  return k > 0 && u.startsWith("data:image/") && ["image/jpeg", "image/png", "image/webp"].includes(mime) ? { mime, data: u.slice(k + 8) } : null;
};

async function scan(d) {
  const parts = [{ text: SCANPROMPT }];
  const add = (label, url) => { const x = dataUrl(url); if (!x) return false; parts.push({ text: label }, { inline_data: { mime_type: x.mime, data: x.data } }); return true; };
  if (!add("box:", d.box) || !add("ussd:", d.ussd)) throw new Error("missing image");
  const v = await gem(parts), b = v.box || {}, u = v.ussd || {};
  const its = items(v.items), has = b.brand || b.model || b.serial || b.imei1 || b.imei2;
  if (v.box_valid !== true || !(has || its.length >= 3)) {
    return { notBox: true, box: { brand: "", model: "", ram: "", storage: "", serial: "", imei1: "", imei2: "", items: [] }, ussd: { imei1: imei(u.imei1), imei2: imei(u.imei2), serial: ser(u.serial) } };
  }
  return {
    box: { brand: t2(b.brand, 60), model: t2(b.model, 60), ram: digits(b.ram), storage: digits(b.storage), serial: ser(b.serial), imei1: imei(b.imei1), imei2: imei(b.imei2), items: items(v.items) },
    ussd: { imei1: imei(u.imei1), imei2: imei(u.imei2), serial: ser(u.serial) }
  };
}

async function info(d) {
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + TKEY },
    body: JSON.stringify({ query: `${d.brand} ${d.model} full specifications release date price gsmarena`, search_depth: "basic", max_results: 8 })
  });
  const j = await r.json();
  if (!r.ok) throw new Error("tavily: " + JSON.stringify(j));
  const res = j.results || [];
  if (!res.length) return { items: [], sources: [] };
  const src = res.map((x, i) => `[${i + 1}] ${x.title}\n${(x.content || "").slice(0, 1500)}`).join("\n\n");
  const v = await gem([{ text: `من نتائج البحث التالية فقط، استخرج كل المعلومات الصحيحة المتاحة عن الجهاز ${d.brand} ${d.model}، حتى لو بدت غير مهمة: الاسم الكامل، تاريخ الإصدار، سعر الإطلاق، الأبعاد والوزن، الشاشة (الحجم والنوع والدقة والتردد)، المعالج والـGPU، الرام والذاكرة الداخلية المتاحة، الكاميرات الخلفية والأمامية، البطارية والشحن، نظام التشغيل، الشبكات وعدد الشرائح، الاتصال (واي فاي، بلوتوث، NFC)، المنافذ، الحساسات، الألوان، مقاومة الماء والغبار، وأي معلومة أخرى. قواعد: اكتب فقط ما هو مذكور في النتائج، ولو تعارضت المصادر في معلومة فلا تذكرها، ولا تخمّن، وبلا تكرار. كل عنصر label عربي قصير وvalue بقيمته. حتى 40 عنصر.\n\n${src}\n\nأجب JSON فقط: {"items":[{"label":"تاريخ الإصدار","value":"..."}]}` }]);
  return { items: items(v.items).slice(0, 40), sources: res.slice(0, 3).map(x => ({ title: t2(x.title, 80), url: x.url })) };
}

const INSPECTPROMPT = `أنت خبير فحص موبايلات مستعملة. الصورة المسماة front هي وجه الجهاز (الشاشة قد تكون مضاءة أو مطفية)، والمسماة back هي ظهر الجهاز.
افحص ما هو ظاهر في الصور مهما كانت جودتها (حتى لو فيها انعكاس أو ظل أو إضاءة ضعيفة أو لم تكن حادة تماماً)، ولا ترفض الصور لهذه الأسباب. اجعل valid=false فقط لو الصورة ليست لموبايل أصلاً.
لو جودة الصورة أو الانعكاس تحد من الفحص فاذكر ذلك كملاحظة بدرجة low بدلاً من رفض الصورة، ولا تخمّن ما لا يظهر.
حدد grade: excellent (ممتاز: لا توجد أي خدوش أو علامات ظاهرة)، very_good (جيد جداً: خدوش أو علامات خفيفة جداً بالكاد تظهر)، good (جيد: خدوش أو علامات استعمال واضحة بدون كسر)، poor (ضعيف: كسر أو شرخ أو انبعاج أو تلف واضح).
notes: كل ملاحظة ظاهرة (كسر، شرخ، خدوش، انبعاج، تقشير دهان، بقع أو ظلال على الشاشة، تلف في عدسة الكاميرا، علامات في الإطار وغيرها) كعنصر {"area":"المكان مثل الشاشة أو الظهر أو الإطار أو الكاميرا","issue":"وصف قصير بالعربية","severity":"low أو medium أو high"}. لو لا توجد ملاحظات اترك القائمة فارغة.
summary: جملة عربية واحدة.
أجب JSON فقط: {"valid":true,"reason":"","grade":"","notes":[],"summary":""}`;

async function inspect(d) {
  const parts = [{ text: INSPECTPROMPT }];
  for (const [label, url] of [["front:", d.front], ["back:", d.back]]) {
    const x = dataUrl(url);
    if (!x) throw new Error("missing image");
    parts.push({ text: label }, { inline_data: { mime_type: x.mime, data: x.data } });
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
const otpSecret = env => env.APP_SECRET || env.OTP_SECRET || (env.GEMINI_API_KEY || "") + (env.TAVILY_API_KEY || "");
const sentAt = new Map(), sentIp = new Map(), tries = new Map(), loginIp = new Map();
const recent = (m, k, ms) => { if (m.size > 5000) m.clear(); const now = Date.now(), a = (m.get(k) || []).filter(t => now - t < ms); m.set(k, a); return a; };
const emailNorm = v => { v = String(v || "").trim().toLowerCase(); return v.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? v : ""; };
const phoneOk = v => { const d = String(v || "").replace(/\D/g, ""); return /^01[0125]\d{8}$/.test(d) ? d : ""; };

async function sendMail(env, to, code) {
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ sender: { name: "فاحص الموبيل المستعمل", email: env.MAIL_FROM }, to: [{ email: to }], subject: "كود التحقق: " + code,
      htmlContent: `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;text-align:right"><h2>فاحص الموبيل المستعمل</h2><p>كود التحقق الخاص بك:</p><p style="font-size:32px;font-weight:bold;letter-spacing:6px">${code}</p><p>الكود صالح لمدة 5 دقائق. لا تشاركه مع أحد.</p></div>` })
  });
  if (!r.ok) throw new Error("mail: " + r.status + " " + (await r.text()).slice(0, 200));
}

// يرسل كود تحقق للإيميل ويرجّع [status, body]
async function issueOtp(env, request, id) {
  const ip = request.headers.get("cf-connecting-ip") || "x", a = recent(sentAt, id, 6e5), c = recent(sentIp, ip, 36e5);
  if (a.length >= 3 || c.length >= 10) return [429, { error: "محاولات كتير، جرّب بعد شوية" }];
  a.push(Date.now()); c.push(Date.now());
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000)), exp = Date.now() + 3e5;
  const token = exp + "." + await hmac(otpSecret(env), `${id}|${exp}|${code}`);
  if (env.BREVO_API_KEY && env.MAIL_FROM) {
    try { await sendMail(env, id, code); } catch (e) { console.error(e.message); return [502, { error: "فشل إرسال الإيميل، جرّب تاني" }]; }
    return [200, { token }];
  }
  if (env.OTP_DEMO === "1") return [200, { token, demo: code }];
  return [503, { error: "خدمة الإيميل مش متفعّلة لسه" }];
}

async function checkOtp(env, id, code, token) {
  const [exp, sig] = String(token || "").split("."); code = String(code || "");
  if (!id || !/^\d{6}$/.test(code) || !exp || !sig) return { error: "اكتب كود التحقق (6 أرقام)" };
  if (+exp < Date.now()) return { error: "الكود انتهت صلاحيته، اطلب كود جديد" };
  if (tries.size > 5000) tries.clear();
  const n = (tries.get(sig) || 0) + 1; tries.set(sig, n);
  if (n > 5) return { error: "محاولات كتير، اطلب كود جديد" };
  return same(await hmac(otpSecret(env), `${id}|${exp}|${code}`), sig) ? { ok: true } : { error: "الكود غلط" };
}

// ---------- الحسابات والتجار (قاعدة D1) ----------
const DAY = 864e5;
let schemaReady = false;
async function db(env) {
  if (!env.DB) throw new Error("DB not bound");
  if (!schemaReady) {
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, shop TEXT, addr TEXT, phone TEXT UNIQUE, email TEXT UNIQUE, salt TEXT, hash TEXT, trial_end INTEGER, banned INTEGER DEFAULT 0, created_at INTEGER)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, at INTEGER, dev TEXT, cond INTEGER, mn INTEGER, av INTEGER, mx INTEGER)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS h_user ON history(user_id, at)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS admin_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, msg TEXT)")
    ]);
    schemaReady = true;
  }
  return env.DB;
}
const appSecret = env => { if (!env.APP_SECRET) throw new Error("APP_SECRET missing"); return env.APP_SECRET; };
const rand = n => b64u(crypto.getRandomValues(new Uint8Array(n)));
async function hashPw(env, pass, salt) {
  const k = await crypto.subtle.importKey("raw", enc.encode(pass + appSecret(env)), "PBKDF2", false, ["deriveBits"]);
  return b64u(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 10000 }, k, 256));
}
const unb64 = s => atob(s.replace(/-/g, "+").replace(/_/g, "/"));
async function makeToken(env, p) { const body = b64u(enc.encode(JSON.stringify(p))); return body + "." + await hmac(appSecret(env), "t|" + body); }
async function readToken(env, tk) {
  const [body, sig] = String(tk || "").split("."); if (!body || !sig) return null;
  if (!same(await hmac(appSecret(env), "t|" + body), sig)) return null;
  try { const p = JSON.parse(unb64(body)); return p.exp > Date.now() ? p : null; } catch (e) { return null; }
}
const pub = u => ({ id: u.id, name: u.name, shop: u.shop, phone: u.phone, exp: u.trial_end, ban: !!u.banned, admin: false });
const ADMIN = { id: 0, name: "الأدمن", shop: "-", exp: 9e15, ban: false, admin: true };

async function auth(request, env, paid) {
  const p = await readToken(env, (request.headers.get("authorization") || "").replace(/^Bearer /, ""));
  if (!p) return { res: J({ error: "سجّل دخول الأول" }, 401) };
  if (p.adm) return { user: ADMIN, admin: true };
  const u = await (await db(env)).prepare("SELECT * FROM users WHERE id=?").bind(p.uid).first();
  if (!u) return { res: J({ error: "الحساب مش موجود، سجّل دخول تاني" }, 401) };
  if (u.banned) return { res: J({ error: "الحساب محظور. كلّم الأدمن." }, 403) };
  if (paid && u.trial_end <= Date.now()) return { res: J({ error: "انتهت التجربة. تواصل مع الأدمن للاشتراك." }, 403) };
  return { user: u };
}
async function findUser(env, id) { return (await db(env)).prepare("SELECT * FROM users WHERE email=? OR phone=?").bind(id, id.replace(/\D/g, "") || "x").first(); }

async function signupStart(request, env) {
  const b = await request.json(), phone = phoneOk(b.phone), email = emailNorm(b.email);
  if (!phone) return J({ error: "اكتب رقم موبايل مصري صحيح (11 رقم)" }, 400);
  if (!email) return J({ error: "اكتب إيميل صحيح" }, 400);
  if (await (await db(env)).prepare("SELECT 1 AS x FROM users WHERE phone=? OR email=?").bind(phone, email).first()) return J({ error: "الرقم أو الإيميل ده مسجّل قبل كده" }, 409);
  const [st, body] = await issueOtp(env, request, email); return J(body, st);
}
async function signupFinish(request, env) {
  const b = await request.json(), phone = phoneOk(b.phone), email = emailNorm(b.email), clean = v => String(v || "").trim().slice(0, 80), pass = String(b.pass || "");
  const name = clean(b.name), shop = clean(b.shop), addr = clean(b.addr);
  if (!name || !shop || !addr || !phone || !email || pass.length < 6 || pass.length > 100) return J({ error: "كمّل كل البيانات (كلمة السر 6 حروف على الأقل)" }, 400);
  const v = await checkOtp(env, email, b.code, b.token); if (!v.ok) return J({ error: v.error }, 400);
  const salt = rand(12), hash = await hashPw(env, pass, salt), now = Date.now(), d = await db(env);
  try {
    const r = await d.prepare("INSERT INTO users(name,shop,addr,phone,email,salt,hash,trial_end,banned,created_at) VALUES(?,?,?,?,?,?,?,?,0,?)").bind(name, shop, addr, phone, email, salt, hash, now + 7 * DAY, now).run();
    const u = { id: r.meta.last_row_id, name, shop, phone, trial_end: now + 7 * DAY, banned: 0 };
    return J({ token: await makeToken(env, { uid: u.id, exp: now + 30 * DAY }), user: pub(u) });
  } catch (e) { if (/UNIQUE/i.test(e.message)) return J({ error: "الرقم أو الإيميل ده مسجّل قبل كده" }, 409); throw e; }
}
async function login(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || "x", att = recent(loginIp, ip, 6e5);
  if (att.length >= 15) return J({ error: "محاولات كتير، جرّب بعد شوية" }, 429);
  const b = await request.json(), id = String(b.id || "").trim().toLowerCase(), pass = String(b.pass || ""), bad = () => { att.push(Date.now()); return J({ error: "الرقم أو كلمة السر غلط" }, 401); };
  if (!id || !pass) return bad();
  if (id === "admin") {
    const ap = String(env.ADMIN_PASSWORD || "").trim();
    if (!ap) return J({ error: "كلمة سر الأدمن مش مضبوطة (ADMIN_PASSWORD)" }, 500);
    const k = appSecret(env);
    if (!same(await hmac(k, "a|" + pass.trim()), await hmac(k, "a|" + ap))) return bad();
    return J({ token: await makeToken(env, { adm: 1, exp: Date.now() + 7 * DAY }), user: ADMIN });
  }
  const u = await findUser(env, id);
  if (!u || !same(await hashPw(env, pass, u.salt), u.hash)) return bad();
  if (u.banned) return J({ error: "الحساب محظور. كلّم الأدمن." }, 403);
  return J({ token: await makeToken(env, { uid: u.id, exp: Date.now() + 30 * DAY }), user: pub(u) });
}
async function forgotStart(request, env) {
  const b = await request.json(), id = String(b.id || "").trim().toLowerCase(), u = id && await findUser(env, id);
  if (!u) return J({ error: "مفيش حساب بالبيانات دي" }, 404);
  const [st, body] = await issueOtp(env, request, u.email); return J(body, st);
}
async function forgotFinish(request, env) {
  const b = await request.json(), id = String(b.id || "").trim().toLowerCase(), pass = String(b.pass || ""), u = id && await findUser(env, id);
  if (!u) return J({ error: "مفيش حساب بالبيانات دي" }, 404);
  if (pass.length < 6 || pass.length > 100) return J({ error: "كلمة السر الجديدة 6 حروف على الأقل" }, 400);
  const v = await checkOtp(env, u.email, b.code, b.token); if (!v.ok) return J({ error: v.error }, 400);
  const salt = rand(12);
  await (await db(env)).prepare("UPDATE users SET salt=?, hash=? WHERE id=?").bind(salt, await hashPw(env, pass, salt), u.id).run();
  return J({ ok: true });
}
async function historyAdd(request, env, a) {
  const b = await request.json(), n = v => Math.max(0, Math.min(1e7, Math.round(+v || 0)));
  await (await db(env)).prepare("INSERT INTO history(user_id,at,dev,cond,mn,av,mx) VALUES(?,?,?,?,?,?,?)").bind(a.user.id, Date.now(), String(b.dev || "").slice(0, 120), [0, 1, 2].includes(+b.c) ? +b.c : 1, n(b.mn), n(b.av), n(b.mx)).run();
  return J({ ok: true });
}
async function historyList(env, a) {
  const r = await (await db(env)).prepare("SELECT at, dev, cond, mn, av, mx FROM history WHERE user_id=? ORDER BY at DESC LIMIT 100").bind(a.user.id).all();
  return J({ items: (r.results || []).map(x => ({ t: x.at, dev: x.dev, c: x.cond, mn: x.mn, av: x.av, mx: x.mx })) });
}
async function adminRoute(request, env, P, url) {
  const d = await db(env);
  if (P === "/api/admin/users") {
    const r = await d.prepare("SELECT u.id,u.name,u.shop,u.phone,u.email,u.trial_end,u.banned,u.created_at,(SELECT COUNT(*) FROM history h WHERE h.user_id=u.id) AS evals,(SELECT MAX(at) FROM history h WHERE h.user_id=u.id) AS last_eval FROM users u ORDER BY u.id DESC LIMIT 1000").all();
    return J({ users: (r.results || []).map(u => ({ id: u.id, name: u.name, shop: u.shop, phone: u.phone, email: u.email, exp: u.trial_end, ban: !!u.banned, created: u.created_at, evals: u.evals || 0, last_eval: u.last_eval || 0 })) });
  }
  if (P === "/api/admin/history") {
    const r = await d.prepare("SELECT at, dev, cond, mn, av, mx FROM history WHERE user_id=? ORDER BY at DESC LIMIT 200").bind(+url.searchParams.get("uid") || 0).all();
    return J({ history: (r.results || []).map(x => ({ t: x.at, dev: x.dev, c: x.cond, mn: x.mn, av: x.av, mx: x.mx })) });
  }
  if (P === "/api/admin/log") {
    const r = await d.prepare("SELECT at, msg FROM admin_log ORDER BY id DESC LIMIT 50").all();
    return J({ log: (r.results || []).map(x => ({ t: x.at, m: x.msg })) });
  }
  if (P === "/api/admin/user" && request.method === "POST") {
    const b = await request.json(), id = +b.id, u = await d.prepare("SELECT * FROM users WHERE id=?").bind(id).first();
    if (!u) return J({ error: "الحساب مش موجود" }, 404);
    let msg;
    if (b.action === "days") {
      const days = Math.max(-365, Math.min(365, Math.trunc(+b.days || 0)));
      if (!days) return J({ error: "عدد الأيام غلط" }, 400);
      const te = (days > 0 ? Math.max(u.trial_end, Date.now()) : u.trial_end) + days * DAY;
      await d.prepare("UPDATE users SET trial_end=? WHERE id=?").bind(te, id).run();
      msg = `${days > 0 ? "زوّد" : "خصم"} ${Math.abs(days)} يوم لـ ${u.name}`;
    } else if (b.action === "ban" || b.action === "unban") {
      await d.prepare("UPDATE users SET banned=? WHERE id=?").bind(b.action === "ban" ? 1 : 0, id).run();
      msg = `${b.action === "ban" ? "حظر" : "فك حظر"} ${u.name}`;
    } else return J({ error: "إجراء غلط" }, 400);
    await d.prepare("INSERT INTO admin_log(at,msg) VALUES(?,?)").bind(Date.now(), msg).run();
    return J({ ok: true });
  }
  return J({ error: "Not found" }, 404);
}

function setup(env) {
  GKEY = env.GEMINI_API_KEY; TKEY = env.TAVILY_API_KEY;
  if (env.MODEL) MODEL = env.MODEL;
  return GKEY && TKEY;
}

async function route(request, env) {
    const u = new URL(request.url), P = u.pathname, post = request.method === "POST";
    if (P === "/api/signup/start" && post) return signupStart(request, env);
    if (P === "/api/signup/finish" && post) return signupFinish(request, env);
    if (P === "/api/login" && post) return login(request, env);
    if (P === "/api/forgot/start" && post) return forgotStart(request, env);
    if (P === "/api/forgot/finish" && post) return forgotFinish(request, env);
    if (P === "/api/me") { const a = await auth(request, env); return a.res || J({ user: a.admin ? ADMIN : pub(a.user) }); }
    if (P === "/api/history") { const a = await auth(request, env); if (a.res) return a.res; if (a.admin) return J({ items: [] }); return post ? historyAdd(request, env, a) : historyList(env, a); }
    if (P.startsWith("/api/admin/")) { const a = await auth(request, env); if (a.res) return a.res; if (!a.admin) return J({ error: "مش مسموح" }, 403); return adminRoute(request, env, P, u); }
    if (u.pathname === "/api/price" && request.method === "POST") {
      { const au = await auth(request, env, true); if (au.res) return au.res; }
      if (!setup(env)) return J({ error: "المفاتيح غير مضبوطة" }, 500);
      try {
        const d = await request.json();
        for (const k of ["brand", "model", "ram"]) if (!d[k] || String(d[k]).length > 60) return J({ error: "بيانات ناقصة" }, 400);
        const r = await getRanges(d);
        return J({ ranges: r.ranges });
      } catch (e) { console.error(e.message); return J({ error: "فشل جلب الأسعار" }, 500); }
    }
    if (u.pathname === "/api/scan" && request.method === "POST") {
      { const au = await auth(request, env, true); if (au.res) return au.res; }
      GKEY = env.GEMINI_API_KEY; if (env.MODEL) MODEL = env.MODEL;
      if (!GKEY) return J({ error: "المفتاح غير مضبوط" }, 500);
      try { return J(await scan(await request.json())); }
      catch (e) { console.error(e.message); return J({ error: "فشل قراءة الصور", detail: String(e.message).slice(0, 300) }, 500); }
    }
    if (u.pathname === "/api/inspect" && request.method === "POST") {
      { const au = await auth(request, env, true); if (au.res) return au.res; }
      GKEY = env.GEMINI_API_KEY; if (env.MODEL) MODEL = env.MODEL;
      if (!GKEY) return J({ error: "المفتاح غير مضبوط" }, 500);
      try { return J(await inspect(await request.json())); }
      catch (e) { console.error(e.message); return J({ error: "فشل فحص الصور", detail: String(e.message).slice(0, 300) }, 500); }
    }
    if (u.pathname === "/api/info" && request.method === "POST") {
      { const au = await auth(request, env, true); if (au.res) return au.res; }
      if (!setup(env)) return J({ error: "المفاتيح غير مضبوطة" }, 500);
      try { const d = await request.json(); if (!d.brand || !d.model) return J({ error: "بيانات ناقصة" }, 400); return J(await info(d)); }
      catch (e) { console.error(e.message); return J({ error: "فشل جلب المعلومات", detail: String(e.message).slice(0, 300) }, 500); }
    }
    if (u.pathname === "/diag") {
      GKEY = env.GEMINI_API_KEY; TKEY = env.TAVILY_API_KEY; if (env.MODEL) MODEL = env.MODEL;
      const out = [`config: APP_SECRET=${!!env.APP_SECRET} ADMIN_PASSWORD=${!!String(env.ADMIN_PASSWORD || "").trim()} DB=${!!env.DB} GEMINI=${!!GKEY} TAVILY=${!!TKEY} BREVO=${!!env.BREVO_API_KEY} MAIL_FROM=${!!env.MAIL_FROM} OTP_DEMO=${env.OTP_DEMO === "1"} model=${MODEL}`];
      try { const c = await (await db(env)).prepare("SELECT COUNT(*) AS n FROM users").first(); out.push(`database: OK (users=${c.n})`); } catch (e) { out.push("database: FAIL " + String(e.message).slice(0, 200)); }
      if (!String(env.ADMIN_PASSWORD || "").trim() || u.searchParams.get("k") !== String(env.ADMIN_PASSWORD).trim()) { out.push("لتشغيل اختبار Gemini وTavily افتح /diag?k=كلمة_سر_الأدمن"); return T(out.join("\n")); }
      const t = async (name, f) => { const s = Date.now(); try { out.push(`${name}: OK (${await f()}) ${Date.now() - s}ms`); } catch (e) { out.push(`${name}: FAIL ${String(e.message).slice(0, 300)}`); } };
      await t("gemini text", async () => JSON.stringify(await gem([{ text: 'أجب JSON فقط: {"ok":true}' }])));
      await t("gemini image", async () => JSON.stringify(await gem([{ text: 'Describe the image as JSON {"seen":"..."}' }, { inline_data: { mime_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" } }])));
      await t("tavily", async () => (await tsearch("Samsung Galaxy A15 price Egypt")).length + " results");
      return T(out.join("\n"));
    }
    return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request, env) {
    try { return await route(request, env); }
    catch (e) {
      console.error(e.message);
      const m = String(e.message);
      return J({ error: /APP_SECRET/.test(m) ? "إعداد السيرفر ناقص: ضيف APP_SECRET في Cloudflare" : /DB not bound/.test(m) ? "قاعدة البيانات مش مربوطة بالمشروع" : "خطأ في السيرفر", detail: m.slice(0, 200) }, 500);
    }
  }
};
