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

// Turn a role name into a stable, URL-safe document id.
// e.g. "SDE2 (Frontend)" → "sde2-frontend"
function slugify(s) {
  return String(s || "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "role";
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  const { action, password, ...rest } = req.body || {};

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // ── All candidates ───────────────────────────────────────────
    if (action === "getCandidates") {
      const snap = await db.collection("candidates").get();
      const candidates = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Sort: interviewed first (by date desc), pending last
      candidates.sort((a, b) => {
        if (a["Interviewed At"] && b["Interviewed At"]) {
          return new Date(b["Interviewed At"]) - new Date(a["Interviewed At"]);
        }
        if (a["Interviewed At"]) return -1;
        if (b["Interviewed At"]) return 1;
        return 0;
      });
      return res.status(200).json({ success: true, candidates });
    }

    // ── Questions ────────────────────────────────────────────────
    if (action === "getQuestions") {
      const snap = await db.collection("config").doc("questions").get();
      const list = snap.exists ? (snap.data().list || []) : [];
      return res.status(200).json({ success: true, questions: list });
    }

    if (action === "updateQuestions") {
      if (!Array.isArray(rest.questions)) {
        return res.status(400).json({ error: "questions must be an array" });
      }
      await db.collection("config").doc("questions").set({
        list: rest.questions.filter(q => String(q).trim()),
        updatedAt: new Date().toISOString(),
      });
      return res.status(200).json({ success: true });
    }

    // ── Roles ────────────────────────────────────────────────────
    if (action === "getRoles") {
      const snap  = await db.collection("roles").get();
      const roles = snap.docs.map(d => {
        const data = d.data() || {};
        return {
          id:        d.id,
          name:      data.name || d.id,
          questions: Array.isArray(data.questions) ? data.questions : [],
          updatedAt: data.updatedAt || null,
        };
      });
      roles.sort((a, b) => a.name.localeCompare(b.name));
      return res.status(200).json({ success: true, roles });
    }

    // Create a new role, or update an existing one (name + questions).
    if (action === "saveRole") {
      const { id, name, questions } = rest;
      if (!name || !String(name).trim()) {
        return res.status(400).json({ error: "role name is required" });
      }
      const cleaned = Array.isArray(questions)
        ? questions.map(q => String(q).trim()).filter(Boolean)
        : [];

      // Existing role → update in place (id stays stable even if renamed).
      if (id) {
        await db.collection("roles").doc(id).set({
          name:      String(name).trim(),
          questions: cleaned,
          updatedAt: new Date().toISOString(),
        }, { merge: true });
        return res.status(200).json({ success: true, id });
      }

      // New role → derive id from the name, reject duplicates.
      const newId = slugify(name);
      const ref   = db.collection("roles").doc(newId);
      const snap  = await ref.get();
      if (snap.exists) {
        return res.status(200).json({ success: false, error: "role_exists" });
      }
      await ref.set({
        name:      String(name).trim(),
        questions: cleaned,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return res.status(200).json({ success: true, id: newId });
    }

    if (action === "deleteRole") {
      const { id } = rest;
      if (!id) return res.status(400).json({ error: "role id required" });
      await db.collection("roles").doc(id).delete();
      return res.status(200).json({ success: true });
    }

    // ── Add candidate ────────────────────────────────────────────
    if (action === "addCandidate") {
      // Note: `password` is consumed above as the admin password, so
      // the candidate's password comes in as `candidatePassword`
      const { name, email, candidatePassword, winStart, winEnd, role, roleName } = rest;
      if (!name || !email || !candidatePassword) {
        return res.status(400).json({ error: "name, email and candidatePassword are required" });
      }
      const docId = email.trim().toLowerCase();
      const ref   = db.collection("candidates").doc(docId);
      const snap  = await ref.get();
      if (snap.exists) {
        return res.status(200).json({ success: false, error: "candidate_exists" });
      }
      await ref.set({
        Name:           name.trim(),
        Email:          email.trim().toLowerCase(),
        Password:       candidatePassword,
        Status:         "",
        Role:           role     || "",
        RoleName:       roleName || "",
        InterviewStart: winStart || null,
        InterviewEnd:   winEnd   || null,
      });
      return res.status(200).json({ success: true });
    }

    // ── Edit candidate (slot + status + role) ────────────────────
    if (action === "editCandidate") {
      const { email, status, winStart, winEnd, role, roleName } = rest;
      if (!email) return res.status(400).json({ error: "email required" });
      const docId = email.trim().toLowerCase();
      // Use set+merge so it works even if field names shift; never throws NOT_FOUND
      const update = {
        Status:         status || "",
        InterviewStart: winStart !== undefined ? (winStart || null) : null,
        InterviewEnd:   winEnd   !== undefined ? (winEnd   || null) : null,
      };
      if (role     !== undefined) update.Role     = role     || "";
      if (roleName !== undefined) update.RoleName = roleName || "";
      await db.collection("candidates").doc(docId).set(update, { merge: true });
      return res.status(200).json({ success: true });
    }

    // ── Delete candidate ─────────────────────────────────────────
    if (action === "deleteCandidate") {
      const { email } = rest;
      if (!email) return res.status(400).json({ error: "email required" });
      await db.collection("candidates").doc(email.trim().toLowerCase()).delete();
      return res.status(200).json({ success: true });
    }

    // ── Set interview window (bulk or per-candidate) ─────────────
    if (action === "setInterviewWindow") {
      const { emails, start, end } = rest;
      // emails = array of email strings, or empty/null = apply to ALL
      const snap  = await db.collection("candidates").get();
      const batch = db.batch();

      snap.docs.forEach(doc => {
        const docEmail = String(doc.data().Email || doc.id).toLowerCase();
        const apply    = !emails || emails.length === 0 ||
                         emails.map(e => e.toLowerCase()).includes(docEmail);
        if (apply) {
          batch.update(doc.ref, {
            InterviewStart: start || null,
            InterviewEnd:   end   || null,
          });
        }
      });

      await batch.commit();
      return res.status(200).json({ success: true });
    }

    // ── Clear interview window ───────────────────────────────────
    if (action === "clearInterviewWindow") {
      const { emails } = rest;
      const snap  = await db.collection("candidates").get();
      const batch = db.batch();

      snap.docs.forEach(doc => {
        const docEmail = String(doc.data().Email || doc.id).toLowerCase();
        const apply    = !emails || emails.length === 0 ||
                         emails.map(e => e.toLowerCase()).includes(docEmail);
        if (apply) {
          batch.update(doc.ref, { InterviewStart: null, InterviewEnd: null });
        }
      });

      await batch.commit();
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: "unknown_action" });

  } catch (err) {
    console.error("Admin error:", err);
    return res.status(500).json({ error: err.message });
  }
};
