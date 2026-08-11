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

// ── Invite email ─────────────────────────────────────────────────────
const escHtml = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Interview windows are stored as UTC ISO; show them in IST (Neoflo is Bangalore).
function fmtWindow(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata",
    }) + " IST";
  } catch (_) { return ""; }
}

// Build the candidate invite email (subject + html + text) from a candidate doc.
function buildInviteEmail(c, appUrl) {
  const base     = String(appUrl || process.env.APP_URL || "").replace(/\/+$/, "");
  const loginUrl = base || "";
  const name     = c.Name || "Candidate";
  const start    = fmtWindow(c.InterviewStart);
  const end      = fmtWindow(c.InterviewEnd);

  const winHtml = (start || end)
    ? `<p style="margin:0 0 14px"><strong>Interview window:</strong><br>${
        start ? `Opens: ${escHtml(start)}<br>` : ""}${end ? `Closes: ${escHtml(end)}` : ""}</p>`
    : "";
  const roleHtml = c.RoleName
    ? `<p style="margin:0 0 14px"><strong>Role:</strong> ${escHtml(c.RoleName)}</p>` : "";
  const linkHtml = loginUrl
    ? `<p style="margin:22px 0"><a href="${escHtml(loginUrl)}" style="background:#000;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">Start your interview →</a></p>
       <p style="margin:0 0 14px;font-size:13px;color:#666">Or paste this link into your browser:<br>${escHtml(loginUrl)}</p>`
    : "";

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.55">
    <p style="margin:0 0 14px">Hi ${escHtml(name)},</p>
    <p style="margin:0 0 14px">You've been invited to complete your interview with <strong>Neoflo</strong>. Use the credentials below to sign in.</p>
    ${roleHtml}
    ${winHtml}
    <div style="background:#f5f5f7;border-radius:10px;padding:14px 16px;margin:0 0 14px">
      <p style="margin:0 0 6px"><strong>Email:</strong> ${escHtml(c.Email)}</p>
      <p style="margin:0"><strong>Password:</strong> ${escHtml(c.Password)}</p>
    </div>
    ${linkHtml}
    <p style="margin:0 0 6px;font-weight:600">Before you start:</p>
    <ul style="margin:0 0 14px;padding-left:18px;color:#333">
      <li>Allow microphone and camera access when prompted.</li>
      <li>Set aside ~30 minutes in a quiet place.</li>
      <li>Answer each question, then click <strong>“Next Question”</strong> to continue.</li>
    </ul>
    <p style="margin:18px 0 0;font-size:13px;color:#666">— Team Neoflo</p>
  </div>`;

  const textLines = [
    `Hi ${name},`, "",
    "You've been invited to complete your interview with Neoflo. Sign in with the credentials below.", "",
    c.RoleName ? `Role: ${c.RoleName}` : "",
    start ? `Interview opens: ${start}` : "",
    end   ? `Interview closes: ${end}` : "",
    "", `Email: ${c.Email}`, `Password: ${c.Password}`, "",
    loginUrl ? `Start your interview: ${loginUrl}` : "",
    "", "Before you start:",
    "- Allow microphone and camera access when prompted.",
    "- Set aside ~30 minutes in a quiet place.",
    '- Answer each question, then click "Next Question" to continue.',
    "", "— Team Neoflo",
  ].filter(l => l !== "");

  return { subject: "Your Neoflo interview invitation", html, text: textLines.join("\n") };
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

    // ── Send invite email (AhaSend) ──────────────────────────────
    if (action === "sendInvite") {
      const { email, appUrl } = rest;
      if (!email) return res.status(400).json({ error: "email required" });

      const apiKey    = process.env.AHASEND_API_KEY;
      const accountId = process.env.AHASEND_ACCOUNT_ID;
      const fromEmail = process.env.EMAIL_FROM;
      if (!apiKey || !accountId || !fromEmail) {
        return res.status(200).json({ success: false, error: "email_not_configured" });
      }

      const docId = email.trim().toLowerCase();
      const snap  = await db.collection("candidates").doc(docId).get();
      if (!snap.exists) return res.status(200).json({ success: false, error: "not_found" });
      const c = snap.data();

      const { subject, html, text } = buildInviteEmail(c, appUrl);
      try {
        const resp = await fetch(`https://api.ahasend.com/v2/accounts/${accountId}/messages`, {
          method: "POST",
          headers: {
            Authorization:    `Bearer ${apiKey}`,
            "Content-Type":   "application/json",
            "Idempotency-Key": `invite-${docId}-${Date.now()}`,
          },
          body: JSON.stringify({
            from:         { email: fromEmail, name: process.env.EMAIL_FROM_NAME || "Neoflo" },
            recipients:   [{ email: c.Email, name: c.Name || "" }],
            subject,
            html_content: html,
            text_content: text,
          }),
        });

        if (resp.status !== 202 && !resp.ok) {
          const detail = await resp.text().catch(() => "");
          console.error("AhaSend send error:", resp.status, detail);
          return res.status(200).json({ success: false, error: `send_failed_${resp.status}`, detail: detail.slice(0, 300) });
        }

        await db.collection("candidates").doc(docId).set(
          { InviteSentAt: new Date().toISOString() }, { merge: true }
        );
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("sendInvite error:", err);
        return res.status(200).json({ success: false, error: err.message });
      }
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
