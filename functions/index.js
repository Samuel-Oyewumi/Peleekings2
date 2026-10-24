const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

/**
 * Generates a unique Registration Number for a newly created user document.
 * - Corper: surname initial + first-name initial + last 4 digits of nyscStateCode
 * - Non-Corper: random 4-digit number + first-name initial + surname initial
 * Retries up to 10 times on collision against existing users docs.
 */
async function generateUniqueRegNumber(data) {
  let surname = (data.surname || "").trim();
  let firstName = (data.firstName || "").trim();

  // Fallback to displayName or fullName if surname/firstName are missing
  if (!surname && !firstName) {
    const parts = (data.displayName || data.fullName || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      firstName = parts[0];
      surname = parts[parts.length - 1];
    } else if (parts.length === 1) {
      firstName = parts[0];
      surname = parts[0];
    }
  }

  const sInit = (surname[0] || "U").toUpperCase();
  const fInit = (firstName[0] || "B").toUpperCase();
  const isCorper = data.studentType === "corper";

  for (let attempt = 0; attempt < 10; attempt++) {
    let candidate;

    if (isCorper) {
      const rawDigits = (data.nyscStateCode || "").replace(/\D/g, "");
      if (attempt === 0 && rawDigits.length >= 4) {
        candidate = `${sInit}${fInit}${rawDigits.slice(-4)}`;
      } else {
        // Fallback or collision retry: randomize 4-digit numeric segment
        const rand = Math.floor(1000 + Math.random() * 9000);
        candidate = `${sInit}${fInit}${rand}`;
      }
    } else {
      // Non-Corper format: random 4-digit number + first-name initial + surname initial
      const rand = Math.floor(1000 + Math.random() * 9000);
      candidate = `${rand}${fInit}${sInit}`;
    }

    // Check uniqueness against existing users collection
    const querySnap = await db
      .collection("users")
      .where("regNumber", "==", candidate)
      .limit(1)
      .get();

    if (querySnap.empty) {
      return candidate;
    }
  }

  // Fallback if all 10 attempts collided
  const timestampSuffix = Date.now().toString().slice(-4);
  return isCorper ? `${sInit}${fInit}${timestampSuffix}` : `${timestampSuffix}${fInit}${sInit}`;
}

/**
 * 1. onCreate Trigger for users/{uid} documents
 * - Reads ADMIN_EMAIL from environment config (process.env.ADMIN_EMAIL).
 * - Assigns role: "admin" if email matches ADMIN_EMAIL.
 * - Otherwise sets role to submitted role ("student" or "tutor"), defaulting to "student".
 * - Computes unique regNumber and writes both fields atomically via Admin SDK.
 */
exports.onUserCreated = onDocumentCreated("users/{uid}", async (event) => {
  const snap = event.data;
  if (!snap) {
    console.log("No data associated with event");
    return null;
  }

  const data = snap.data();
  const uid = event.params.uid;
  const userEmail = (data.email || "").trim().toLowerCase();

  // Read admin email from environment configuration (not hardcoded in client)
  const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();

  const candidateRole = data.role || data.submittedRole || data.signupRole;
  let assignedRole;
  if (adminEmail && userEmail === adminEmail) {
    assignedRole = "admin";
  } else if (candidateRole === "tutor" || candidateRole === "student") {
    assignedRole = candidateRole;
  } else {
    assignedRole = "student";
  }

  // Generate unique regNumber with collision check
  const regNumber = await generateUniqueRegNumber(data);

  const updates = {
    role: assignedRole,
    regNumber,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  try {
    await snap.ref.update(updates);
    console.log(`Successfully initialized user ${uid}: role=${assignedRole}, regNumber=${regNumber}`);

    // Set custom claims for admin or tutor
    if (assignedRole === "admin") {
      await admin.auth().setCustomUserClaims(uid, { admin: true });
    } else if (assignedRole === "tutor") {
      await admin.auth().setCustomUserClaims(uid, { tutor: true });
    }

    // Record audit log entry in Firestore
    try {
      await db.collection("auditLogs").add({
        action: "User Created",
        detail: `User ${userEmail || uid} registered: role '${assignedRole}', regNumber '${regNumber}'`,
        uid,
        email: userEmail,
        role: assignedRole,
        regNumber,
        badge: assignedRole === "admin" ? "pill-tech" : "pill-success",
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (logErr) {
      console.warn("Audit log notice:", logErr);
    }
  } catch (err) {
    console.error(`Error updating user document ${uid}:`, err);
    throw err;
  }

  return null;
});

/**
 * 2. Callable Function: promoteToTutor
 * - Only an authenticated caller whose own users/{uid}.role == "admin" may invoke this.
 * - Atomically sets target user's role to "tutor", marks application status to "approved",
 *   and records an audit log entry in one atomic write.
 */
exports.promoteToTutor = onCall(async (request) => {
  // 1. Verify caller authentication
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required to perform this action.");
  }

  const callerUid = request.auth.uid;

  // 2. Verify caller has admin role in users collection
  const callerDoc = await db.collection("users").doc(callerUid).get();
  if (!callerDoc.exists || callerDoc.data().role !== "admin") {
    throw new HttpsError("permission-denied", "Only administrators may promote tutors.");
  }

  // 3. Extract and validate applicationId
  const applicationId = request.data?.applicationId || request.data;
  if (!applicationId || typeof applicationId !== "string") {
    throw new HttpsError("invalid-argument", "Valid applicationId is required.");
  }

  // 4. Retrieve tutor application
  const appRef = db.collection("tutorApplications").doc(applicationId);
  const appDoc = await appRef.get();

  if (!appDoc.exists) {
    throw new HttpsError("not-found", `Tutor application '${applicationId}' does not exist.`);
  }

  const appData = appDoc.data();
  const applicantUid = appData.applicantUid || appData.uid;

  if (!applicantUid) {
    throw new HttpsError("failed-precondition", "Tutor application does not contain a valid applicantUid.");
  }

  // 5. Atomic Batch Write (users, tutorApplications, auditLogs)
  const batch = db.batch();
  const userRef = db.collection("users").doc(applicantUid);
  const auditLogRef = db.collection("auditLogs").doc();

  batch.update(userRef, {
    role: "tutor",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  batch.update(appRef, {
    status: "approved",
    approvedAt: admin.firestore.FieldValue.serverTimestamp(),
    approvedBy: callerUid,
  });

  batch.set(auditLogRef, {
    action: "Tutor Application Approved",
    detail: `Applicant ${applicantUid} promoted to tutor for application '${applicationId}' by admin ${callerUid}`,
    applicationId,
    applicantUid,
    approvedBy: callerUid,
    role: "tutor",
    badge: "pill-success",
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  try {
    await batch.commit();

    // Set custom user claim
    try {
      await admin.auth().setCustomUserClaims(applicantUid, { tutor: true });
    } catch (claimErr) {
      console.warn(`Notice: Could not set custom claims for ${applicantUid}:`, claimErr);
    }

    console.log(`Admin ${callerUid} successfully promoted applicant ${applicantUid} (application ${applicationId}) to tutor.`);
    return {
      success: true,
      applicationId,
      applicantUid,
      role: "tutor",
      status: "approved",
    };
  } catch (err) {
    console.error("Batch write failure in promoteToTutor:", err);
    throw new HttpsError("internal", "Failed to update user and application records.");
  }
});
