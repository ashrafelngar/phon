async function askGemini(prompt) {
  const modelName = "gemini-1.5-flash";
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({ 
      generationConfig: { temperature: 0.2 },
      contents: [{ parts: [{ text: prompt }] }] 
    })
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
