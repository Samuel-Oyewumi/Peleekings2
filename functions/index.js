const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

/**
 * Generates a unique Registration Number for a newly created user document.
 * - Corper: surnameInitial + firstInitial + numeric part of LAST "/"-separated segment of nyscStateCode (e.g. AB/23A/1399 -> AS1399).
 *   On collision appends A, B, C... (AS1399, AS1399A, AS1399B).
 * - Non-Corper: random 4 digits + firstInitial + surnameInitial, retry up to 10 times.
 * - Race-safe: inside a Firestore transaction, creates `regNumbers/{code}` (fail if exists) and retries on conflict.
 */
async function generateUniqueRegNumber(data, uid) {
  let surname = (data.surname || "").trim();
  let firstName = (data.firstName || "").trim();

  // Fallback when surname/firstName are missing:
  // fullName is stored as "Surname FirstName", so surname = parts[0], firstName = parts[1] (or remaining parts)
  if (!surname && !firstName) {
    const parts = (data.fullName || data.displayName || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      surname = parts[0];
      firstName = parts.slice(1).join(" ");
    } else if (parts.length === 1) {
      surname = parts[0];
      firstName = parts[0];
    }
  }

  const sInit = (surname[0] || "U").toUpperCase();
  const fInit = (firstName[0] || "B").toUpperCase();
  const isCorper = data.studentType === "corper";

  let baseCode = "";
  if (isCorper) {
    const segments = (data.nyscStateCode || "").trim().split("/");
    const lastSegment = segments[segments.length - 1] || "";
    const numericPart = lastSegment.replace(/\D/g, "") || "0000";
    baseCode = `${sInit}${fInit}${numericPart}`;
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    let candidate;

    if (isCorper) {
      // Attempt 0: AS1399, Attempt 1: AS1399A, Attempt 2: AS1399B, ...
      candidate = attempt === 0 ? baseCode : `${baseCode}${String.fromCharCode(64 + attempt)}`;
    } else {
      // Non-corper: random 4 digits + firstInitial + surnameInitial
      const rand = Math.floor(1000 + Math.random() * 9000);
      candidate = `${rand}${fInit}${sInit}`;
    }

    try {
      const regRef = db.collection("regNumbers").doc(candidate);
      await db.runTransaction(async (transaction) => {
        const existing = await transaction.get(regRef);
        if (existing.exists) {
          throw new Error("COLLISION");
        }
        transaction.set(regRef, {
          uid: uid || data.uid || null,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
      return candidate;
    } catch (txErr) {
      if (txErr.message === "COLLISION") {
        continue;
      }
      console.warn(`Transaction error during regNumber reservation for ${candidate}:`, txErr.message);
      continue;
    }
  }

  // Fallback safety if attempts collide
  const fallback = isCorper
    ? `${baseCode}Z${Date.now().toString().slice(-2)}`
    : `${Date.now().toString().slice(-4)}${fInit}${sInit}`;

  try {
    await db.collection("regNumbers").doc(fallback).set({
      uid: uid || data.uid || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch {}

  return fallback;
}

/**
 * 1. onCreate Trigger for users/{uid} documents
 * - Authoritatively assigns "student" role by default (client never sets role).
 * - Only pre-existing verified Custom Claims (e.g. from trusted bootstrap) can assign elevated roles.
 * - Generates collision-safe regNumber and writes to Firestore.
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

  // Authoritative role assignment: check if pre-existing verified Custom Claims exist
  let assignedRole = "student";
  try {
    const authUser = await admin.auth().getUser(uid);
    if (authUser.customClaims?.admin === true) {
      assignedRole = "admin";
    } else if (authUser.customClaims?.tutor === true) {
      assignedRole = "tutor";
    }
  } catch (authErr) {
    console.warn(`Notice: Unable to check pre-existing claims for ${uid}:`, authErr.message);
  }

  // Generate unique regNumber with collision check
  const regNumber = await generateUniqueRegNumber(data, uid);

  const updates = {
    role: assignedRole,
    regNumber,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Strip deprecated submittedRole field if sent by legacy clients
  if (data.submittedRole) {
    updates.submittedRole = admin.firestore.FieldValue.delete();
  }

  try {
    await snap.ref.update(updates);
    console.log(`Successfully initialized user ${uid}: role=${assignedRole}, regNumber=${regNumber}`);

    // Synchronize Custom Claims if missing
    try {
      const currentAuthUser = await admin.auth().getUser(uid);
      const claims = currentAuthUser.customClaims || {};
      if (assignedRole === "admin" && claims.admin !== true) {
        await admin.auth().setCustomUserClaims(uid, { ...claims, admin: true, tutor: false });
      } else if (assignedRole === "tutor" && claims.tutor !== true) {
        await admin.auth().setCustomUserClaims(uid, { ...claims, tutor: true, admin: false });
      } else if (assignedRole === "student" && (claims.admin || claims.tutor)) {
        await admin.auth().setCustomUserClaims(uid, { ...claims, admin: false, tutor: false });
      }
    } catch (claimErr) {
      console.warn(`Claims sync notice for ${uid}:`, claimErr.message);
    }

    // Record audit log entry in Firestore
    try {
      await db.collection("auditLogs").add({
        action: "User Created",
        detail: `User ${userEmail || uid} initialized with verified role '${assignedRole}', regNumber '${regNumber}'`,
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
 * - Enforces verified caller claims.admin === true.
 * - Verifies tutor application exists and is in "pending" status before approval.
 * - Updates Firestore and Custom Claims with atomic rollback protection.
 * - Revokes refresh tokens for immediate privilege activation.
 */
exports.promoteToTutor = onCall(async (request) => {
  // 1. Verify caller authentication and admin Custom Claim
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required to perform this action.");
  }

  if (request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Access denied: Only verified administrators may promote instructors.");
  }

  const callerUid = request.auth.uid;

  // 2. Extract and validate applicationId
  const applicationId = request.data?.applicationId || request.data;
  if (!applicationId || typeof applicationId !== "string") {
    throw new HttpsError("invalid-argument", "Valid applicationId is required.");
  }

  // 3. Retrieve tutor application and verify pending status
  const appRef = db.collection("tutorApplications").doc(applicationId);
  const appDoc = await appRef.get();

  if (!appDoc.exists) {
    throw new HttpsError("not-found", `Tutor application '${applicationId}' does not exist.`);
  }

  const appData = appDoc.data();
  if (appData.status === "approved") {
    throw new HttpsError("failed-precondition", "This tutor application has already been approved.");
  }
  if (appData.status !== "pending") {
    throw new HttpsError("failed-precondition", `Cannot approve application with status '${appData.status}'. Only pending applications can be approved.`);
  }

  const applicantUid = appData.applicantUid || appData.uid;

  if (!applicantUid) {
    throw new HttpsError("failed-precondition", "Tutor application does not contain a valid applicantUid.");
  }

  // 4. Retrieve applicant's current auth state for rollback safety
  let previousClaims = {};
  try {
    const applicantUser = await admin.auth().getUser(applicantUid);
    previousClaims = applicantUser.customClaims || {};
  } catch (userErr) {
    throw new HttpsError("not-found", `Applicant user account '${applicantUid}' not found in Firebase Auth.`);
  }

  // 5. Update Firebase Custom Claims first
  const newClaims = {
    ...previousClaims,
    tutor: true,
    admin: false,
  };

  try {
    await admin.auth().setCustomUserClaims(applicantUid, newClaims);
  } catch (claimErr) {
    console.error(`Failed to set custom claim for applicant ${applicantUid}:`, claimErr);
    throw new HttpsError("internal", "Failed to assign tutor Custom Claim in Firebase Authentication.");
  }

  // 6. Update Firestore documents atomically
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

  // Create initial course draft for the newly approved tutor if courseTitle exists
  if (appData.courseTitle) {
    const courseSlug = appData.courseTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    const courseId = `${courseSlug}-${Date.now().toString().slice(-4)}`;
    const courseRef = db.collection("courses").doc(courseId);

    batch.set(courseRef, {
      title: appData.courseTitle.trim(),
      description: appData.courseDescription || "",
      learningOutcomes: appData.learningOutcomes || "",
      syllabus: appData.syllabus || "",
      category: appData.category || "Tech & Digital Skills",
      tutorId: applicantUid,
      tutorName: appData.fullName || "Instructor",
      status: "draft",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // Send in-app notification to the approved applicant
  const notifRef = db.collection("users").doc(applicantUid).collection("notifications").doc();
  batch.set(notifRef, {
    type: "application_status",
    title: "Tutor Application Approved! 🎉",
    body: "Congratulations! Your instructor application has been approved. You now have full access to the Teaching Portal.",
    status: "approved",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    read: false,
  });

  batch.set(auditLogRef, {
    action: "Tutor Application Approved",
    detail: `Applicant ${applicantUid} promoted to tutor for application '${applicationId}' by verified admin ${callerUid}`,
    applicationId,
    applicantUid,
    approvedBy: callerUid,
    role: "tutor",
    badge: "pill-success",
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  try {
    await batch.commit();

    // Revoke refresh tokens to force session renewal
    try {
      await admin.auth().revokeRefreshTokens(applicantUid);
    } catch (revokeErr) {
      console.warn(`Notice: Could not revoke tokens for ${applicantUid}:`, revokeErr.message);
    }

    console.log(`Verified Admin ${callerUid} successfully promoted applicant ${applicantUid} to tutor.`);
    return {
      success: true,
      applicationId,
      applicantUid,
      role: "tutor",
      status: "approved",
    };
  } catch (batchErr) {
    console.error("Batch write failure in promoteToTutor, rolling back claims:", batchErr);
    try {
      await admin.auth().setCustomUserClaims(applicantUid, previousClaims);
    } catch (rbErr) {
      console.error("CRITICAL: Failed to rollback claims after batch error:", rbErr);
    }
    throw new HttpsError("internal", "Database update failed. Custom claims were safely restored.");
  }
});

/**
 * 3. Callable Function: assignAdminRole
 * - Enforces verified caller claims.admin === true.
 * - Grants or revokes administrator privileges for a target UID.
 * - Prevents an administrator from locking themselves out (revoking their own admin role).
 */
exports.assignAdminRole = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required to perform this action.");
  }

  if (request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Access denied: Only verified administrators may manage administrator privileges.");
  }

  const callerUid = request.auth.uid;
  const targetUid = request.data?.targetUid || request.data?.uid;
  const action = request.data?.action === "revoke" ? "revoke" : "grant";

  if (!targetUid || typeof targetUid !== "string") {
    throw new HttpsError("invalid-argument", "A valid targetUid string is required.");
  }

  if (action === "revoke" && targetUid === callerUid) {
    throw new HttpsError("failed-precondition", "Security Protection: You cannot revoke your own administrator privileges.");
  }

  let targetUser;
  try {
    targetUser = await admin.auth().getUser(targetUid);
  } catch (err) {
    throw new HttpsError("not-found", `Target user '${targetUid}' does not exist in Firebase Authentication.`);
  }

  if (targetUser.disabled) {
    throw new HttpsError("failed-precondition", "Cannot modify privileges for a disabled user account.");
  }

  const previousClaims = targetUser.customClaims || {};
  const isGrant = action === "grant";
  const newClaims = isGrant
    ? { ...previousClaims, admin: true, tutor: false }
    : { ...previousClaims, admin: false, tutor: false };

  if (!isGrant) {
    delete newClaims.admin;
  }

  try {
    await admin.auth().setCustomUserClaims(targetUid, newClaims);
  } catch (claimErr) {
    console.error(`Failed to update claims for ${targetUid}:`, claimErr);
    throw new HttpsError("internal", "Failed to update Custom Claims in Firebase Authentication.");
  }

  const nextRole = isGrant ? "admin" : "student";
  const userRef = db.collection("users").doc(targetUid);
  const auditLogRef = db.collection("auditLogs").doc();

  const batch = db.batch();
  batch.set(
    userRef,
    {
      role: nextRole,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  batch.set(auditLogRef, {
    action: isGrant ? "Admin Role Granted" : "Admin Role Revoked",
    detail: `Admin privilege ${isGrant ? "granted to" : "revoked from"} ${targetUser.email || targetUid} by admin ${callerUid}`,
    targetUid,
    targetEmail: targetUser.email || "",
    callerUid,
    role: nextRole,
    badge: isGrant ? "pill-tech" : "pill-warning",
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  try {
    await batch.commit();

    try {
      await admin.auth().revokeRefreshTokens(targetUid);
    } catch (tokErr) {
      console.warn("Token revocation notice:", tokErr.message);
    }

    console.log(`Admin ${callerUid} successfully set role '${nextRole}' for target ${targetUid}.`);
    return {
      success: true,
      targetUid,
      role: nextRole,
      action,
    };
  } catch (batchErr) {
    console.error(`Batch write error in assignAdminRole, rolling back claims for ${targetUid}:`, batchErr);
    try {
      await admin.auth().setCustomUserClaims(targetUid, previousClaims);
    } catch (rbErr) {
      console.error("CRITICAL: Failed to rollback claims:", rbErr);
    }
    throw new HttpsError("internal", "Failed to update Firestore profile. Claims have been safely restored.");
  }
});

/**
 * 4. Callable Function: manageEnrollmentStatus
 * - Moves enrollment approval, payment status, and privileged access changes to a trusted backend function.
 * - Students cannot grant themselves approved or paid access.
 * - Only verified Admins or the assigned course Tutor may approve or update enrollment access.
 */
exports.manageEnrollmentStatus = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required to perform this action.");
  }

  const callerUid = request.auth.uid;
  const isCallerAdmin = request.auth.token.admin === true;
  const isCallerTutor = request.auth.token.tutor === true;

  const { enrollmentId, status, paymentStatus, isPaid } = request.data || {};

  if (!enrollmentId || typeof enrollmentId !== "string") {
    throw new HttpsError("invalid-argument", "Valid enrollmentId is required.");
  }

  const enrollmentRef = db.collection("enrollments").doc(enrollmentId);
  const enrollmentSnap = await enrollmentRef.get();

  if (!enrollmentSnap.exists) {
    throw new HttpsError("not-found", `Enrollment '${enrollmentId}' not found.`);
  }

  const enrollmentData = enrollmentSnap.data();
  const courseId = enrollmentData.courseId;

  // Verify course tutor assignment if caller is not an admin
  if (!isCallerAdmin) {
    if (!isCallerTutor) {
      throw new HttpsError("permission-denied", "Only administrators or assigned course instructors may update enrollment status.");
    }

    const courseSnap = await db.collection("courses").doc(courseId).get();
    if (!courseSnap.exists) {
      throw new HttpsError("not-found", `Associated course '${courseId}' not found.`);
    }

    const courseData = courseSnap.data();
    const isAssigned = courseData.tutorId === callerUid || courseData.tutorUid === callerUid || courseData.instructorId === callerUid;

    if (!isAssigned) {
      throw new HttpsError("permission-denied", "Instructors may only manage enrollments for their assigned courses.");
    }
  }

  const updates = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    approvedBy: callerUid,
  };

  if (status && ["active", "approved", "suspended", "completed"].includes(status)) {
    updates.status = status;
    if (status === "approved" || status === "active") {
      updates.approvedAt = admin.firestore.FieldValue.serverTimestamp();
    }
  }

  if (paymentStatus && ["paid", "pending", "waived"].includes(paymentStatus)) {
    updates.paymentStatus = paymentStatus;
    updates.isPaid = paymentStatus === "paid" || paymentStatus === "waived";
  } else if (typeof isPaid === "boolean") {
    updates.isPaid = isPaid;
    updates.paymentStatus = isPaid ? "paid" : "pending";
  }

  await enrollmentRef.update(updates);

  // Notify student
  try {
    await db.collection("users").doc(enrollmentData.uid).collection("notifications").add({
      type: "enrollment",
      title: "Enrollment Status Updated",
      body: `Your enrollment for '${enrollmentData.courseTitle || courseId}' is now ${updates.status || "updated"}.`,
      courseId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      read: false,
    });
  } catch (notifErr) {
    console.warn("Enrollment notification notice:", notifErr.message);
  }

  return { success: true, enrollmentId, updates };
});

/**
 * 5. Callable Function: rejectTutorApplication
 * - Admin-only callable to reject a tutor application with documented reason.
 * - Updates application status, records reviewer & timestamp, notifies applicant, and logs audit record.
 */
exports.rejectTutorApplication = onCall(async (request) => {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Access denied: Verified administrator privileges required.");
  }

  const callerUid = request.auth.uid;
  const { applicationId, reason } = request.data || {};

  if (!applicationId || typeof applicationId !== "string") {
    throw new HttpsError("invalid-argument", "Valid applicationId is required.");
  }

  const appRef = db.collection("tutorApplications").doc(applicationId);
  const appSnap = await appRef.get();

  if (!appSnap.exists) {
    throw new HttpsError("not-found", `Tutor application '${applicationId}' not found.`);
  }

  const appData = appSnap.data();
  if (appData.status === "approved") {
    throw new HttpsError("failed-precondition", "Cannot reject an application that has already been approved.");
  }

  const rejectionReason = (reason || "").trim() || "Application does not meet current qualification requirements.";
  const applicantUid = appData.applicantUid || appData.uid;

  const batch = db.batch();
  batch.update(appRef, {
    status: "rejected",
    rejectionReason,
    reviewedBy: callerUid,
    reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  if (applicantUid) {
    const notifRef = db.collection("users").doc(applicantUid).collection("notifications").doc();
    batch.set(notifRef, {
      type: "application_status",
      title: "Instructor Application Status Update",
      body: `Your tutor application has been reviewed: ${rejectionReason}`,
      status: "rejected",
      rejectionReason,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      read: false,
    });
  }

  const auditRef = db.collection("auditLogs").doc();
  batch.set(auditRef, {
    action: "Tutor Application Rejected",
    detail: `Application '${applicationId}' for applicant ${applicantUid || "unknown"} rejected by admin ${callerUid}. Reason: ${rejectionReason}`,
    applicationId,
    applicantUid: applicantUid || null,
    reviewedBy: callerUid,
    rejectionReason,
    badge: "pill-warning",
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();
  return { success: true, applicationId, status: "rejected" };
});

/**
 * 6. Callable Function: adminSetAccountStatus
 * - Admin-only callable to suspend or reactivate a learner/tutor account.
 * - Suspended accounts are disabled in Firebase Auth, refresh tokens revoked, and Firestore user doc updated.
 * - Prevents an administrator from suspending their own account.
 */
exports.adminSetAccountStatus = onCall(async (request) => {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Access denied: Verified administrator privileges required.");
  }

  const callerUid = request.auth.uid;
  const { targetUid, status, reason } = request.data || {};

  if (!targetUid || typeof targetUid !== "string") {
    throw new HttpsError("invalid-argument", "Valid targetUid is required.");
  }

  if (targetUid === callerUid) {
    throw new HttpsError("failed-precondition", "Security Protection: You cannot suspend your own administrator account.");
  }

  if (!["active", "suspended"].includes(status)) {
    throw new HttpsError("invalid-argument", "Status must be either 'active' or 'suspended'.");
  }

  const isSuspended = status === "suspended";

  // 1. Verify target exists in Firebase Auth
  try {
    await admin.auth().getUser(targetUid);
  } catch (authErr) {
    throw new HttpsError("not-found", `User '${targetUid}' not found in Firebase Authentication.`);
  }

  // 2. Update Firebase Authentication disabled state
  try {
    await admin.auth().updateUser(targetUid, { disabled: isSuspended });
    if (isSuspended) {
      await admin.auth().revokeRefreshTokens(targetUid);
    }
  } catch (disableErr) {
    console.error("Failed to update Firebase Auth user disabled state:", disableErr);
    throw new HttpsError("internal", "Failed to update authentication account state.");
  }

  // 3. Update Firestore user profile
  const userRef = db.collection("users").doc(targetUid);
  const userSnap = await userRef.get();
  const userData = userSnap.exists ? userSnap.data() : {};

  const updates = {
    status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (isSuspended) {
    updates.suspendedAt = admin.firestore.FieldValue.serverTimestamp();
    updates.suspendedBy = callerUid;
    updates.suspensionReason = (reason || "").trim() || "Administrative review or policy violation.";
  } else {
    updates.suspendedAt = admin.firestore.FieldValue.delete();
    updates.suspendedBy = admin.firestore.FieldValue.delete();
    updates.suspensionReason = admin.firestore.FieldValue.delete();
    updates.reactivatedAt = admin.firestore.FieldValue.serverTimestamp();
    updates.reactivatedBy = callerUid;
  }

  const batch = db.batch();
  batch.set(userRef, updates, { merge: true });

  const auditRef = db.collection("auditLogs").doc();
  batch.set(auditRef, {
    action: isSuspended ? "Learner Suspended" : "Learner Reactivated",
    detail: `User ${userData.email || targetUid} account status set to '${status}' by admin ${callerUid}.${isSuspended ? ` Reason: ${updates.suspensionReason}` : ""}`,
    targetUid,
    targetEmail: userData.email || "",
    status,
    reason: isSuspended ? updates.suspensionReason : null,
    adminUid: callerUid,
    badge: isSuspended ? "pill-danger" : "pill-success",
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();
  return { success: true, targetUid, status };
});

/**
 * 7. Callable Function: adminUpdateLearner
 * - Admin-only callable to update permitted learner profile fields.
 * - Strictly validates against protected system fields (role, regNumber, email, etc.).
 */
exports.adminUpdateLearner = onCall(async (request) => {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Access denied: Verified administrator privileges required.");
  }

  const callerUid = request.auth.uid;
  const { targetUid, fullName, phoneNumber, bio, studentType, nyscStateCode } = request.data || {};

  if (!targetUid || typeof targetUid !== "string") {
    throw new HttpsError("invalid-argument", "Valid targetUid is required.");
  }

  const userRef = db.collection("users").doc(targetUid);
  const userSnap = await userRef.get();

  if (!userSnap.exists) {
    throw new HttpsError("not-found", `User document '${targetUid}' not found.`);
  }

  const updates = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (typeof fullName === "string" && fullName.trim()) updates.fullName = fullName.trim();
  if (typeof phoneNumber === "string") updates.phoneNumber = phoneNumber.trim();
  if (typeof bio === "string") updates.bio = bio.trim();
  if (["corper", "non_corper"].includes(studentType)) updates.studentType = studentType;
  if (typeof nyscStateCode === "string") updates.nyscStateCode = nyscStateCode.trim().toUpperCase();

  const batch = db.batch();
  batch.update(userRef, updates);

  const auditRef = db.collection("auditLogs").doc();
  batch.set(auditRef, {
    action: "Learner Profile Updated",
    detail: `Profile for user ${targetUid} updated by admin ${callerUid}`,
    targetUid,
    adminUid: callerUid,
    updatedFields: Object.keys(updates).filter((k) => k !== "updatedAt"),
    badge: "pill-tech",
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();
  return { success: true, targetUid, updates };
});

/**
 * 8. Callable Function: adminAssignCourseTutor
 * - Admin-only callable to assign or remove a tutor for a course.
 * - Synchronizes courses/{courseId} with tutor assignment metadata and records an audit log.
 */
exports.adminAssignCourseTutor = onCall(async (request) => {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Access denied: Verified administrator privileges required.");
  }

  const callerUid = request.auth.uid;
  const { courseId, tutorUid, action } = request.data || {};

  if (!courseId || typeof courseId !== "string") {
    throw new HttpsError("invalid-argument", "Valid courseId is required.");
  }

  const courseRef = db.collection("courses").doc(courseId);
  const courseSnap = await courseRef.get();

  if (!courseSnap.exists) {
    throw new HttpsError("not-found", `Course '${courseId}' not found.`);
  }

  const courseData = courseSnap.data();
  const isAssign = action !== "remove";

  let tutorName = "Assigned Instructor";
  if (isAssign) {
    if (!tutorUid || typeof tutorUid !== "string") {
      throw new HttpsError("invalid-argument", "Valid tutorUid is required to assign a course.");
    }
    const tutorSnap = await db.collection("users").doc(tutorUid).get();
    if (!tutorSnap.exists) {
      throw new HttpsError("not-found", `Tutor user profile '${tutorUid}' not found.`);
    }
    const tutorData = tutorSnap.data();
    tutorName = tutorData.fullName || tutorData.displayName || "Instructor";
  }

  const updates = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const batch = db.batch();

  if (isAssign) {
    updates.tutorId = tutorUid;
    updates.tutorUid = tutorUid;
    updates.tutorName = tutorName;
    updates.assignedTutors = admin.firestore.FieldValue.arrayUnion(tutorUid);

    // Notify tutor
    const notifRef = db.collection("users").doc(tutorUid).collection("notifications").doc();
    batch.set(notifRef, {
      type: "course_assignment",
      title: "Course Assigned! 📚",
      body: `You have been assigned as an instructor for '${courseData.title || courseId}'.`,
      courseId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      read: false,
    });
  } else {
    updates.tutorId = null;
    updates.tutorUid = null;
    if (tutorUid) {
      updates.assignedTutors = admin.firestore.FieldValue.arrayRemove(tutorUid);
    }
  }

  batch.update(courseRef, updates);

  const auditRef = db.collection("auditLogs").doc();
  batch.set(auditRef, {
    action: isAssign ? "Tutor Assigned to Course" : "Tutor Removed from Course",
    detail: isAssign
      ? `Tutor ${tutorName} (${tutorUid}) assigned to course '${courseData.title || courseId}' by admin ${callerUid}`
      : `Tutor assignment removed from course '${courseData.title || courseId}' by admin ${callerUid}`,
    courseId,
    courseTitle: courseData.title || courseId,
    tutorUid: tutorUid || null,
    adminUid: callerUid,
    badge: isAssign ? "pill-success" : "pill-warning",
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();
  return { success: true, courseId, tutorUid, action: isAssign ? "assign" : "remove" };
});

/**
 * 9. Callable Function: adminPublishAnnouncement
 * - Admin-only callable to create, publish, or edit an announcement.
 * - Supports audience targeting ('all', 'learners', 'tutors', 'course') and pinned status.
 */
exports.adminPublishAnnouncement = onCall(async (request) => {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Access denied: Verified administrator privileges required.");
  }

  const callerUid = request.auth.uid;
  const {
    id,
    title,
    body,
    category,
    priority,
    audience,
    courseId,
    pinned,
    status,
    expiresAt,
  } = request.data || {};

  if (!title || typeof title !== "string" || !title.trim()) {
    throw new HttpsError("invalid-argument", "Announcement title is required.");
  }

  if (!body || typeof body !== "string" || !body.trim()) {
    throw new HttpsError("invalid-argument", "Announcement body content is required.");
  }

  const validAudiences = ["all", "learners", "tutors", "course"];
  const selectedAudience = validAudiences.includes(audience) ? audience : "all";
  const pubStatus = status === "draft" ? "draft" : "published";

  const announcementId = id || `ann_${Date.now()}`;
  const announcementRef = db.collection("announcements").doc(announcementId);

  const payload = {
    title: title.trim(),
    body: body.trim(),
    category: (category || "General").trim(),
    priority: priority === "high" || priority === "urgent" ? priority : "normal",
    audience: selectedAudience,
    courseId: selectedAudience === "course" && courseId ? courseId : null,
    pinned: Boolean(pinned),
    status: pubStatus,
    authorUid: callerUid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (expiresAt) {
    payload.expiresAt = admin.firestore.Timestamp.fromDate(new Date(expiresAt));
  }

  const isNew = !id;
  if (isNew) {
    payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
  }

  const batch = db.batch();
  batch.set(announcementRef, payload, { merge: true });

  const auditRef = db.collection("auditLogs").doc();
  batch.set(auditRef, {
    action: isNew ? "Announcement Created" : "Announcement Updated",
    detail: `Announcement '${title.trim()}' (${pubStatus}, audience: ${selectedAudience}) by admin ${callerUid}`,
    announcementId,
    title: title.trim(),
    status: pubStatus,
    audience: selectedAudience,
    adminUid: callerUid,
    badge: pubStatus === "published" ? "pill-success" : "pill-tech",
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();
  return { success: true, announcementId, status: pubStatus };
});

/**
 * 10. Callable Function: adminSendNotification
 * - Admin-only callable to dispatch notifications to targeted audiences.
 * - Targets: 'all_learners', 'all_tutors', 'course', 'single_user'.
 */
exports.adminSendNotification = onCall(async (request) => {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Access denied: Verified administrator privileges required.");
  }

  const callerUid = request.auth.uid;
  const { target, targetId, title, body, type, courseId } = request.data || {};

  if (!title || typeof title !== "string" || !title.trim()) {
    throw new HttpsError("invalid-argument", "Notification title is required.");
  }

  if (!body || typeof body !== "string" || !body.trim()) {
    throw new HttpsError("invalid-argument", "Notification body is required.");
  }

  let recipientUids = [];

  if (target === "single_user") {
    if (!targetId) throw new HttpsError("invalid-argument", "targetId (user UID) is required.");
    recipientUids = [targetId];
  } else if (target === "course") {
    if (!targetId) throw new HttpsError("invalid-argument", "courseId is required for course targeting.");
    const enrSnap = await db.collection("enrollments").where("courseId", "==", targetId).limit(500).get();
    recipientUids = enrSnap.docs.map((d) => d.data().uid).filter(Boolean);
  } else if (target === "all_tutors") {
    const tutorSnap = await db.collection("users").where("role", "==", "tutor").limit(200).get();
    recipientUids = tutorSnap.docs.map((d) => d.id);
  } else {
    // all_learners (limit batch to 500 for safety)
    const learnerSnap = await db.collection("users").where("role", "==", "student").limit(500).get();
    recipientUids = learnerSnap.docs.map((d) => d.id);
  }

  let writtenCount = 0;
  const batches = [];
  let currentBatch = db.batch();
  let opCount = 0;

  for (const uid of recipientUids) {
    const notifRef = db.collection("users").doc(uid).collection("notifications").doc();
    currentBatch.set(notifRef, {
      title: title.trim(),
      body: body.trim(),
      type: type || "announcement",
      courseId: courseId || null,
      read: false,
      senderUid: callerUid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    opCount++;
    writtenCount++;

    if (opCount >= 450) {
      batches.push(currentBatch.commit());
      currentBatch = db.batch();
      opCount = 0;
    }
  }

  if (opCount > 0) {
    batches.push(currentBatch.commit());
  }

  await Promise.all(batches);

  // Record audit log
  await db.collection("auditLogs").add({
    action: "Notification Dispatched",
    detail: `Notification '${title.trim()}' sent to target '${target}' (${writtenCount} recipients) by admin ${callerUid}`,
    target,
    targetId: targetId || null,
    recipientCount: writtenCount,
    adminUid: callerUid,
    badge: "pill-tech",
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true, count: writtenCount };
});

/**
 * 11. Callable Function: adminManageEnrollment
 * - Admin-only callable to manually grant or revoke a student enrollment.
 */
exports.adminManageEnrollment = onCall(async (request) => {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Access denied: Verified administrator privileges required.");
  }

  const callerUid = request.auth.uid;
  const { action, uid, courseId, courseTitle } = request.data || {};

  if (!uid || !courseId) {
    throw new HttpsError("invalid-argument", "Both uid and courseId are required.");
  }

  const enrollmentId = `${uid}_${courseId}`;
  const enrollmentRef = db.collection("enrollments").doc(enrollmentId);

  const batch = db.batch();
  const isGrant = action !== "revoke";

  if (isGrant) {
    batch.set(
      enrollmentRef,
      {
        uid,
        courseId,
        courseTitle: courseTitle || courseId,
        status: "active",
        isPaid: true,
        paymentStatus: "waived",
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        approvedBy: callerUid,
        enrolledAt: admin.firestore.FieldValue.serverTimestamp(),
        completedItemIds: [],
        progressPercent: 0,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const notifRef = db.collection("users").doc(uid).collection("notifications").doc();
    batch.set(notifRef, {
      type: "enrollment",
      title: "Course Enrollment Granted! 🎓",
      body: `You have been officially enrolled in '${courseTitle || courseId}' by administration.`,
      courseId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      read: false,
    });
  } else {
    batch.delete(enrollmentRef);
  }

  const auditRef = db.collection("auditLogs").doc();
  batch.set(auditRef, {
    action: isGrant ? "Manual Enrollment Granted" : "Enrollment Revoked",
    detail: `${isGrant ? "Granted" : "Revoked"} enrollment for student ${uid} in course '${courseId}' by admin ${callerUid}`,
    uid,
    courseId,
    adminUid: callerUid,
    badge: isGrant ? "pill-success" : "pill-danger",
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();
  return { success: true, enrollmentId, action: isGrant ? "grant" : "revoke" };
});
