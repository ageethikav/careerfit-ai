const SYSTEM_PROMPT = `You are CareerFit AI, a career intelligence advisor for fresh graduates, final-year students, and entry-level technology candidates. Compare the supplied resume with the job description. Be specific, fair, practical, evidence-based, and encouraging without exaggerating. Never invent skills, achievements, metrics, qualifications, or experience. A missing keyword is not proof that the candidate lacks the skill. ATS-style score is only an estimate, not a real employer ATS score or hiring guarantee. Return ONLY valid JSON with these exact fields and types: {"ats_score": integer 0-100, "summary": string, "strengths": string[], "missing_keywords": string[], "improvements": string[], "skill_gaps": string[], "learning_roadmap": string[], "interview_questions": string[]}. Give 3-5 strengths, 3-5 missing keywords, exactly 3 resume improvements, 3-5 skill gaps if supported, 3 prioritized learning roadmap actions with a practical exercise or mini-project, and 5 realistic interview questions. Tailor all advice to the role and evidence in the resume. Keep items concise and actionable. If information is insufficient, state the limitation instead of guessing.`;

const timeoutFetch = async (url, options, timeoutMs = 11000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
};

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST for resume analysis." });
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Server configuration is missing GEMINI_API_KEY. Add it in Vercel Environment Variables and redeploy." });

  const { resume, job } = req.body || {};
  if (typeof resume !== "string" || typeof job !== "string" || resume.trim().length < 50 || job.trim().length < 50) {
    return res.status(400).json({ error: "Please provide a resume and job description with at least 50 characters each." });
  }
  if (resume.length > 40000 || job.length > 12000) {
    return res.status(413).json({ error: "The resume or job description is too long. Shorten the text and try again." });
  }

  try {
    const modelResponse = await timeoutFetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`,
      { method: "GET" }, 5000
    );
    if (!modelResponse.ok) {
      const err = await modelResponse.json().catch(() => ({}));
      const msg = err.error?.message || `Model lookup failed (${modelResponse.status}).`;
      return res.status(modelResponse.status === 401 || modelResponse.status === 403 ? 502 : 503).json({ error: `Gemini model lookup failed: ${msg}` });
    }
    const modelData = await modelResponse.json();
    const available = (modelData.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => String(m.name || "").replace(/^models\//, ""))
      .filter(m => /flash/i.test(m) && !/audio|image|embedding|tts|live/i.test(m));
    if (!available.length) return res.status(503).json({ error: "No Gemini Flash model is available for this API key. Check the models enabled in Google AI Studio." });

    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: `Analyze the following resume against this job description.\n\nRESUME:\n${resume.trim()}\n\nJOB DESCRIPTION:\n${job.trim()}\n\nReturn only the required JSON object.` }] }],
      generationConfig: { temperature: 0.25, responseMimeType: "application/json", maxOutputTokens: 3000 }
    };
    let lastMessage = "Gemini did not return a response.";
    for (const model of available.slice(0, 2)) {
      try {
        const response = await timeoutFetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, 9000
        );
        const data = await response.json().catch(() => ({}));
        if (response.ok) {
          const raw = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
          let analysis;
          try { analysis = JSON.parse(raw); } catch (_) { lastMessage = "Gemini returned an invalid JSON response. Please retry."; continue; }
          if (!Number.isFinite(Number(analysis.ats_score)) || !Array.isArray(analysis.strengths) || !Array.isArray(analysis.improvements)) {
            lastMessage = "Gemini response is missing required report fields. Please retry."; continue;
          }
          return res.status(200).json({ analysis });
        }
        lastMessage = data.error?.message || `Gemini returned ${response.status}.`;
        if ([400, 401, 403].includes(response.status)) break;
      } catch (err) {
        lastMessage = err.name === "AbortError" ? `Gemini model ${model} timed out.` : (err.message || "Network error while contacting Gemini.");
      }
    }
    const status = /quota|resource exhausted|high demand|overloaded|unavailable|503/i.test(lastMessage) ? 503 : 502;
    return res.status(status).json({ error: `Gemini could not complete the analysis: ${lastMessage} Please wait briefly and try again.` });
  } catch (err) {
    const message = err.name === "AbortError" ? "Gemini model lookup timed out. Please try again." : (err.message || "Unexpected server error.");
    return res.status(502).json({ error: message });
  }
};
