# CareerFit AI

AI career-readiness dashboard for students and early-career candidates.

## Features
- Resume vs job-description analysis with Gemini
- PDF resume text extraction in the browser
- ATS-style estimate, strengths, missing keywords, improvements, skill gaps, learning roadmap, and interview questions
- Local browser history and text report export

## Secure deployment
1. Import this folder/repository into Vercel.
2. In Vercel Project Settings → Environment Variables, add `GEMINI_API_KEY` with your private Google AI Studio API key.
3. Redeploy after adding the variable.
4. Do not put a real API key in `index.html`, GitHub, screenshots, or chat.

The browser calls `/api/analyze`; `api/analyze.js` reads the key from `process.env.GEMINI_API_KEY` on the server.

## Local note
Opening `index.html` directly with `file://` will not run the serverless endpoint. Test the deployed Vercel URL, or run the project using the Vercel CLI locally after installing it.

## Prompt style
Role-based, task-specific, structured JSON output, evidence-based rules, and concise actionable feedback.
