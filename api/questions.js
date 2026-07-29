// Public endpoint — returns active questions from Firebase
// Falls back to defaults if none have been saved yet

const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();

const DEFAULTS = [
  // Q1 — Production AI System (open-ended, deep dive)
  "Walk me through a production ML/AI system you've built or owned. What problem did it solve, what was your role, what did the architecture look like, and what metrics did you track in production?",

  // Q2 — Model Serving & API Design
  "How would you structure and deploy a FastAPI-based AI service? Walk through the request flow, model loading, logging, monitoring, and CI/CD deployment.",

  // Q3 — RAG / Knowledge Graph
  "Describe a RAG or Knowledge Graph system you've built. How did you chunk documents, generate embeddings, retrieve context, and evaluate retrieval quality?",

  // Q4 — Open Source LLM Experience
  "Which open-source LLMs have you used in production — Llama, Qwen, Mistral, Gemma, or others? Explain how you served, fine-tuned, or optimised them.",

  // Q5 — Performance & Scalability
  "Describe a situation where your AI system worked well at low traffic but struggled at scale. How did you identify and fix the bottleneck?",

  // Q6 — Architecture Decision Making (tradeoffs)
  "You're designing a multi-tenant AI document processing platform expected to handle millions of documents. For each of the following pairs, explain what problem it solves, why you'd choose it, and when you'd avoid it: SQL vs NoSQL, Redis vs PostgreSQL, Kafka vs RabbitMQ, Object Storage vs Database Storage, and Vector Database vs Traditional Database.",

  // Q7 — End-to-End System Design
  "Design an AI-powered document processing platform that can handle a 10x traffic spike without downtime. Explain the complete architecture and justify every major component — covering the API gateway, load balancer, queue, workers, OCR, LLM service, storage, cache, monitoring, autoscaling, and disaster recovery."
];

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const role = (req.query && req.query.role ? String(req.query.role) : "").trim();

  try {
    // Role-specific questionnaire, if a role was requested and has questions.
    if (role) {
      const roleSnap = await db.collection("roles").doc(role).get();
      if (roleSnap.exists) {
        const data = roleSnap.data() || {};
        const rq   = Array.isArray(data.questions) ? data.questions.filter(q => String(q).trim()) : [];
        if (rq.length) {
          return res.status(200).json({ questions: rq, roleName: data.name || role });
        }
      }
    }

    // Fallback: global question set, then hard-coded defaults.
    const snap = await db.collection("config").doc("questions").get();
    const list = snap.exists ? (snap.data().list || []) : [];
    return res.status(200).json({ questions: list.length ? list : DEFAULTS });
  } catch (err) {
    console.error("Questions fetch error:", err.message);
    return res.status(200).json({ questions: DEFAULTS });
  }
};
