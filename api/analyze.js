
const SYSTEM_PROMPT = `You are CareerFit AI, a career intelligence advisor for fresh graduates, final-year students, and entry-level technology candidates.

Compare the supplied resume with the job description. Be specific, fair, practical, evidence-based, and encouraging without exaggerating.

Never invent skills, achievements, metrics, qualifications, or experience. A missing keyword is not proof that the candidate lacks the skill. ATS-style score is only an estimate, not a real employer ATS score or hiring guarantee.

Return ONLY valid JSON with these exact fields:
{
  "ats_score": integer 0-100,
  "summary": string,
  "strengths": string[],
  "missing_keywords": string[],
  "improvements": string[],
  "skill_gaps": string[],
  "learning_roadmap": string[],
  "interview_questions": string[]
}

Give 3-5 strengths, 3-5 missing keywords, exactly 3 resume improvements, 3-5 skill gaps if supported, 3 prioritized learning actions with practical exercises, and 5 realistic interview questions. Tailor everything to the role and resume. If information is insufficient, state the limitation instead of guessing.`;

async function timeoutFetch(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "Use POST for resume analysis."
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "GEMINI_API_KEY is missing in Vercel environment variables."
    });
  }

  const { resume, job } = req.body || {};

  if (
    typeof resume !== "string" ||
    typeof job !== "string" ||
    resume.trim().length < 50 ||
    job.trim().length < 50
  ) {
    return res.status(400).json({
      error: "Please provide a resume and job description with at least 50 characters."
    });
  }

  if (resume.length > 40000 || job.length > 12000) {
    return res.status(413).json({
      error: "The resume or job description is too long."
    });
  }

  try {
    // Discover models supported by this API key
    const modelResponse = await timeoutFetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`,
      { method: "GET" },
      4000
    );

    if (!modelResponse.ok) {
      const errorData = await modelResponse.json().catch(() => ({}));

      return res.status(503).json({
        error: errorData.error?.message || "Gemini model lookup failed."
      });
    }

    const modelData = await modelResponse.json();

    const available = (modelData.models || [])
      .filter(model =>
        (model.supportedGenerationMethods || [])
          .includes("generateContent")
      )
      .map(model =>
        String(model.name || "").replace(/^models\//, "")
      )
      .filter(model =>
        /flash/i.test(model) &&
        !/audio|image|embedding|tts|live/i.test(model) &&
        !/2\.5-flash-lite/i.test(model)
      )
      .sort((a, b) => {
        const rank = model => {
          if (/^gemini-3\.5-flash-lite$/i.test(model)) return 1;
          if (/3\.5-flash/i.test(model)) return 2;
          if (/3\..*-flash/i.test(model)) return 3;
          if (/latest/i.test(model)) return 5;
          return 4;
        };

        return rank(a) - rank(b);
      });

    if (!available.length) {
      return res.status(503).json({
        error: "No supported Gemini Flash model was found for this API key."
      });
    }

    // Use the highest-priority available model
    const model = available[0];

    const requestBody = {
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }]
      },
      contents: [{
        role: "user",
        parts: [{
          text:
            `Analyze this resume against the job description.\n\n` +
            `RESUME:\n${resume.trim()}\n\n` +
            `JOB DESCRIPTION:\n${job.trim()}\n\n` +
            `Return only the required JSON object.`
        }]
      }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        maxOutputTokens: 1800
      }
    };

    // Allow up to 22 seconds for generation
    const response = await timeoutFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      },
      22000
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        data.error?.message || `Gemini returned ${response.status}.`;

      const status =
        response.status === 429 || response.status === 503 ? 503 : 502;

      return res.status(status).json({
        error: `Gemini analysis failed: ${message}`
      });
    }

    const raw = (data.candidates?.[0]?.content?.parts || [])
      .map(part => part.text || "")
      .join("")
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    let analysis;

    try {
      analysis = JSON.parse(raw);
    } catch {
      return res.status(502).json({
        error: "Gemini returned an invalid report. Please try again."
      });
    }

    const requiredArrays = [
      "strengths",
      "missing_keywords",
      "improvements",
      "skill_gaps",
      "learning_roadmap",
      "interview_questions"
    ];

    const valid =
      Number.isInteger(Number(analysis.ats_score)) &&
      Number(analysis.ats_score) >= 0 &&
      Number(analysis.ats_score) <= 100 &&
      typeof analysis.summary === "string" &&
      requiredArrays.every(field =>
        Array.isArray(analysis[field])
      );

    if (!valid) {
      return res.status(502).json({
        error: "Gemini returned an incomplete report. Please try again."
      });
    }

    return res.status(200).json({ analysis });

  } catch (error) {
    return res.status(502).json({
      error:
        error.name === "AbortError"
          ? "Gemini took too long to respond. Please try again."
          : error.message || "Unexpected server error."
    });
  }
};
