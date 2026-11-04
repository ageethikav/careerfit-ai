
const SYSTEM_PROMPT = `You are CareerFit AI, a career intelligence advisor for fresh graduates, final-year students, and entry-level technology candidates.

Compare the supplied resume with the job description. Be specific, fair, practical, evidence-based, and encouraging without exaggerating.

Never invent skills, achievements, metrics, qualifications, or experience. A missing keyword is not proof that the candidate lacks the skill. ATS-style score is only an estimate, not a real employer ATS score or hiring guarantee.

Return ONLY valid JSON with these exact fields and types:
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

Give:
- 3-5 strengths
- 3-5 missing keywords
- Exactly 3 resume improvements
- 3-5 skill gaps if supported by evidence
- 3 prioritized learning roadmap actions with practical exercises or mini-projects
- 5 realistic interview questions

Tailor all advice to the role and resume. Keep items concise and actionable. If information is insufficient, state the limitation instead of guessing.`;

const timeoutFetch = async (url, options, timeoutMs) => {
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
};

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
      error: "Please provide a resume and job description with at least 50 characters each."
    });
  }

  if (resume.length > 40000 || job.length > 12000) {
    return res.status(413).json({
      error: "The resume or job description is too long."
    });
  }

  try {
    // Step 1: Discover available Gemini Flash models
    const modelResponse = await timeoutFetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`,
      { method: "GET" },
      5000
    );

    if (!modelResponse.ok) {
      const errorData = await modelResponse.json().catch(() => ({}));

      return res.status(503).json({
        error: errorData.error?.message ||
          "Unable to retrieve Gemini models. Please try again."
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
        !/audio|image|embedding|tts|live/i.test(model)
      )
      .sort((a, b) => {
        const rank = model => {
          if (/2\.5-flash/i.test(model)) return 1;
          if (/2\.0-flash/i.test(model)) return 2;
          if (/latest/i.test(model)) return 4;
          return 3;
        };

        return rank(a) - rank(b);
      });

    if (!available.length) {
      return res.status(503).json({
        error: "No compatible Gemini Flash model is available for this API key."
      });
    }

    // Step 2: Prepare the analysis request
    const body = {
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
        maxOutputTokens: 2200
      }
    };

    let lastMessage = "Gemini did not return a response.";

    // Step 3: Try up to two available models
    for (const model of available.slice(0, 2)) {
      try {
        const response = await timeoutFetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
          },
          10000
        );

        const data = await response.json().catch(() => ({}));

        if (response.ok) {
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
            lastMessage = "Gemini returned invalid JSON. Please retry.";
            continue;
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
            lastMessage = "Gemini returned an incomplete report. Please retry.";
            continue;
          }

          return res.status(200).json({ analysis });
        }

        lastMessage =
          data.error?.message || `Gemini returned error ${response.status}.`;

        if ([400, 401, 403].includes(response.status)) {
          break;
        }

      } catch (error) {
        lastMessage =
          error.name === "AbortError"
            ? `Model ${model} took too long to respond.`
            : error.message || "Network error while contacting Gemini.";
      }
    }

    const overloaded =
      /quota|resource exhausted|high demand|overloaded|unavailable|503|429/i
        .test(lastMessage);

    return res.status(overloaded ? 503 : 502).json({
      error: overloaded
        ? "Gemini is temporarily busy or its request quota is exhausted. Please try again shortly."
        : `CareerFit AI could not complete the analysis: ${lastMessage}`
    });

  } catch (error) {
    return res.status(502).json({
      error:
        error.name === "AbortError"
          ? "Gemini model lookup timed out. Please try again."
          : error.message || "Unexpected server error."
    });
  }
};
