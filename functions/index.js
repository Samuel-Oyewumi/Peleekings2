const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
let admin = require("firebase-admin");

if (!admin.apps || admin.apps.length === 0) {
  admin.initializeApp();
}
let db = admin.firestore();

/**
 * Test binding hook allowing automated test suites to inject a stateful Firestore/Auth/Storage harness
 * and execute the actual production Cloud Functions logic directly.
 */
function __setTestBindings(bindings = {}) {
  if (bindings.admin) admin = bindings.admin;
  if (bindings.db) db = bindings.db;
}
exports.__setTestBindings = __setTestBindings;

/**
 * Helper: Commits an array of write operations ({ type: "set" | "update" | "delete", ref, data, options })
 * in bounded batches of at most `chunkSize` (strictly capped at <= 350 writes per batch).
 */
async function commitOperationsInBoundedBatches(operations, chunkSize = 350) {
  if (!Array.isArray(operations) || operations.length === 0) {
    return { committedCount: 0, batchCount: 0 };
  }
  const safeChunkSize = Math.min(350, Math.max(1, Number(chunkSize) || 350));
  let committedCount = 0;
  let batchCount = 0;

  for (let i = 0; i < operations.length; i += safeChunkSize) {
    const chunk = operations.slice(i, i + safeChunkSize);
    const batch = db.batch();
    for (const op of chunk) {
      if (!op || !op.ref) continue;
      if (op.type === "set") {
        if (op.options) {
          batch.set(op.ref, op.data, op.options);
        } else {
          batch.set(op.ref, op.data);
        }
      } else if (op.type === "update") {
        batch.update(op.ref, op.data);
      } else if (op.type === "delete") {
        batch.delete(op.ref);
      } else {
        throw new Error(`Unsupported batch operation type: ${op.type}`);
      }
    }
    await batch.commit();
    committedCount += chunk.length;
    batchCount += 1;
  }

  return { committedCount, batchCount };
}
exports.commitOperationsInBoundedBatches = commitOperationsInBoundedBatches;

/**
 * Helper: Recomputes courses/{courseId}/analytics/summary (Stage 8).
 * - enrollmentCount: active or approved enrollments only
 * - avgTestScore: average score across valid testSubmissions for active/approved enrollees (0 if none, never NaN)
 * - assignmentSubmissionRate: (submitted eligible assignment opportunities / (enrollmentCount * totalCourseAssignments)) * 100
 *   (0 if denominator is 0, capped at 100, never NaN)
 * - lastUpdated: serverTimestamp()
 */
async function recomputeCourseAnalytics(courseId) {
  if (!courseId || typeof courseId !== "string" || courseId === "general" || courseId === "platform") {
    return null;
  }

  const courseRef = db.collection("courses").doc(courseId);
  const courseSnap = await courseRef.get();
  if (!courseSnap.exists) {
    return null;
  }

  const [enrSnap, testsSubSnap, asnSubSnap, testSubSnap, asnSubmissionsSnap] = await Promise.all([
    db.collection("enrollments").where("courseId", "==", courseId).get(),
    courseRef.collection("tests").get(),
    courseRef.collection("assignments").get(),
    db.collection("testSubmissions").where("courseId", "==", courseId).get(),
    db.collection("assignmentSubmissions").where("courseId", "==", courseId).get(),
  ]);

  const activeEnrollments = enrSnap.docs.filter((d) =>
    ["active", "approved"].includes(d.data()?.status)
  );
  const enrollmentCount = activeEnrollments.length;
  const activeUids = new Set(activeEnrollments.map((d) => d.data()?.uid).filter(Boolean));

  const validTestIds = new Set(testsSubSnap.docs.map((d) => d.id));
  let totalScore = 0;
  let scoredCount = 0;

  testSubSnap.docs.forEach((d) => {
    const data = d.data() || {};
    if (!activeUids.has(data.uid)) return;
    if (validTestIds.size > 0 && data.testId && !validTestIds.has(data.testId)) return;
    const numericScore = Number(data.score);
    if (typeof data.score === "number" && Number.isFinite(numericScore)) {
      totalScore += numericScore;
      scoredCount += 1;
    }
  });

  const avgTestScore =
    scoredCount > 0 && Number.isFinite(totalScore / scoredCount)
      ? Math.round((totalScore / scoredCount) * 10) / 10
      : 0;

  const validAssignmentIds = new Set(asnSubSnap.docs.map((d) => d.id));
  const totalCourseAssignments = validAssignmentIds.size;
  const denominator = enrollmentCount * totalCourseAssignments;

  let assignmentSubmissionRate = 0;
  if (denominator > 0) {
    const uniqueSubmittedPairs = new Set();
    asnSubmissionsSnap.docs.forEach((d) => {
      const data = d.data() || {};
      if (!activeUids.has(data.uid)) return;
      if (!data.assignmentId || !validAssignmentIds.has(data.assignmentId)) return;
      uniqueSubmittedPairs.add(`${data.uid}_${data.assignmentId}`);
    });
    const rawRate = (uniqueSubmittedPairs.size / denominator) * 100;
    assignmentSubmissionRate = Number.isFinite(rawRate)
      ? Math.min(100, Math.max(0, Math.round(rawRate * 10) / 10))
      : 0;
  }

  const summaryPayload = {
    courseId,
    enrollmentCount,
    avgTestScore,
    assignmentSubmissionRate,
    lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
  };

  await courseRef.collection("analytics").doc("summary").set(summaryPayload, { merge: true });
  return summaryPayload;
}

/**
 * Helper: Counts unique canonical curriculum items across lessons, notes, assignments, and tests subcollections.
 */
async function countCourseCurriculumItems(courseId) {
  const courseRef = db.collection("courses").doc(courseId);
  const [lessonsSnap, notesSnap, asnSnap, testsSnap] = await Promise.all([
    courseRef.collection("lessons").get(),
    courseRef.collection("notes").get(),
    courseRef.collection("assignments").get(),
    courseRef.collection("tests").get(),
  ]);
  const ids = new Set();
  lessonsSnap.docs.forEach((d) => ids.add(d.id));
  notesSnap.docs.forEach((d) => ids.add(d.id));
  asnSnap.docs.forEach((d) => ids.add(d.id));
  testsSnap.docs.forEach((d) => ids.add(d.id));
  return ids.size;
}

/**
 * Validates password against Peleekings minimum security policy:
 * - At least 8 characters
 * - At least one numeric digit (0-9)
 * Never logs or echoes the raw password value.
 */
function validatePasswordPolicy(password) {
  const raw = typeof password === "string" ? password : "";
  const hasMinLength = raw.length >= 8;
  const hasNumber = /\d/.test(raw);
  if (!hasMinLength || !hasNumber) {
    throw new HttpsError(
      "invalid-argument",
      "Password must be at least 8 characters long and include at least one number (0-9)."
    );
  }
  return true;
}
exports.validatePasswordPolicy = validatePasswordPolicy;

/**
 * Helper: Builds deterministic (Corper) or distinct 4-digit (Non-Corper) registration code candidates
 * while preserving the exact Peleekings format.
 * Supports `roundOffset` so subsequent transaction retry rounds generate fresh non-overlapping candidates.
 */
function buildCorperSuffix(index) {
  if (index <= 0) return "";
  // 1..26 -> A..Z, 27..702 -> AA..ZZ
  let n = index;
  let suffix = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    suffix = String.fromCharCode(65 + rem) + suffix;
    n = Math.floor((n - 1) / 26);
  }
  return suffix;
}
exports.buildCorperSuffix = buildCorperSuffix;
exports.buildCorperCollisionSuffix = buildCorperSuffix;

function buildRegNumberCandidates(data = {}, count = 12, roundOffset = 0) {
  let surname = (data.surname || "").trim();
  let firstName = (data.firstName || "").trim();

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

  const candidates = [];
  const seen = new Set();

  for (let attempt = 0; candidates.length < count && attempt < count * 4; attempt++) {
    let candidate;
    if (isCorper) {
      const idx = roundOffset + attempt;
      candidate = `${baseCode}${buildCorperSuffix(idx)}`;
    } else {
      const rand = Math.floor(1000 + Math.random() * 9000);
      candidate = `${rand}${fInit}${sInit}`;
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }
  }

  return { candidates, isCorper, baseCode, sInit, fInit };
}
exports.buildRegNumberCandidates = buildRegNumberCandidates;

const VALID_REG_NUMBER_REGEX = /^(?:[A-Z]{2}\d{1,6}[A-Z]{0,4}|\d{4}[A-Z]{2}|PK-[A-Z0-9-]{4,24})$/;

function isValidRegNumberFormat(code) {
  if (typeof code !== "string") return false;
  const trimmed = code.trim();
  if (!trimmed || ["Assigned", "PENDING", "null", "undefined"].includes(trimmed)) return false;
  return VALID_REG_NUMBER_REGEX.test(trimmed);
}
exports.isValidRegNumberFormat = isValidRegNumberFormat;

/**
 * Atomically allocates or verifies a unique Registration Number (`regNumbers/{code}`) and optionally
 * updates `users/{uid}` in the same Firestore transaction.
 * - Strictly verifies ownership: never accepts an existing `regNumber` on `users/{uid}` or `data.regNumber`
 *   unless `regNumbers/{code}` exists and belongs to `effectiveUid` (or is atomically claimed/repaired
 *   for `effectiveUid` inside the transaction).
 * - If `regNumbers/{code}` belongs to a different user, ignores the conflicting code, allocates a fresh
 *   unclaimed code, reserves `regNumbers/{newCode}` for `effectiveUid`, and updates `users/{effectiveUid}`.
 */
async function ensureUserRegNumber(uid, data = {}, options = {}) {
  const effectiveUid =
    (typeof uid === "string" && uid.trim()) ||
    (typeof data?.uid === "string" && data.uid.trim()) ||
    null;

  if (!effectiveUid) {
    throw new HttpsError(
      "invalid-argument",
      "A valid user UID is required to verify or allocate a registration number."
    );
  }

  const maxRounds = Number.isInteger(options.maxRounds) && options.maxRounds > 0 ? options.maxRounds : 5;
  const batchSize = 12;
  const userRef = db.collection("users").doc(effectiveUid);
  let lastError = null;

  for (let round = 0; round < maxRounds; round++) {
    const { candidates } = buildRegNumberCandidates(data, batchSize, round * batchSize);

    try {
      const result = await db.runTransaction(async (transaction) => {
        const userSnap = await transaction.get(userRef);
        const userDocData = userSnap && userSnap.exists ? (userSnap.data() || {}) : {};
        const mergedData = { ...data, ...userDocData };

        const docReg =
          typeof userDocData.regNumber === "string" ? userDocData.regNumber.trim() : "";
        const callerReg =
          typeof data.regNumber === "string" ? data.regNumber.trim() : "";

        const existingCandidate = isValidRegNumberFormat(docReg)
          ? docReg
          : isValidRegNumberFormat(callerReg)
            ? callerReg
            : "";

        let conflictedCode = null;

        if (round === 0 && existingCandidate) {
          const existingRegRef = db.collection("regNumbers").doc(existingCandidate);
          const existingRegSnap = await transaction.get(existingRegRef);

          if (existingRegSnap.exists && existingRegSnap.data()?.uid === effectiveUid) {
            // Verified owner in regNumbers/{existingCandidate}
            if (options.updateUserDoc !== false) {
              const needsDocSync =
                !userSnap.exists ||
                userDocData.regNumber !== existingCandidate ||
                (options.assignedRole && userDocData.role !== options.assignedRole) ||
                Boolean(userDocData.submittedRole);
              if (needsDocSync) {
                const userUpdates = {
                  ...(options.initialUserFields || {}),
                  regNumber: existingCandidate,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                };
                if (options.assignedRole) {
                  userUpdates.role = options.assignedRole;
                }
                if (userSnap?.exists && userDocData.submittedRole) {
                  userUpdates.submittedRole = admin.firestore.FieldValue.delete();
                }
                transaction.set(userRef, userUpdates, { merge: true });
              }
            }
            return {
              regNumber: existingCandidate,
              alreadyAssigned: true,
              verifiedOwnership: true,
              repairedMapping: false,
            };
          }

          if (!existingRegSnap.exists) {
            // Missing regNumbers/{existingCandidate} reservation — atomically claim/repair for effectiveUid
            transaction.set(existingRegRef, {
              uid: effectiveUid,
              studentType: mergedData.studentType || "non_corper",
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              repairedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            if (options.updateUserDoc !== false || (userSnap && userSnap.exists)) {
              const userUpdates = {
                ...(options.initialUserFields || {}),
                regNumber: existingCandidate,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              };
              if (options.assignedRole) {
                userUpdates.role = options.assignedRole;
              }
              if (userSnap?.exists && userDocData.submittedRole) {
                userUpdates.submittedRole = admin.firestore.FieldValue.delete();
              }
              transaction.set(userRef, userUpdates, { merge: true });
            }

            return {
              regNumber: existingCandidate,
              alreadyAssigned: true,
              verifiedOwnership: true,
              repairedMapping: true,
            };
          }

          // Ownership conflict: regNumbers/{existingCandidate} is owned by a different uid!
          conflictedCode = existingCandidate;
        }

        const filteredCandidates = conflictedCode
          ? candidates.filter((c) => c !== conflictedCode)
          : candidates;
        const candidateRefs = filteredCandidates.map((code) =>
          db.collection("regNumbers").doc(code)
        );
        const regSnaps =
          candidateRefs.length > 0 ? await transaction.getAll(...candidateRefs) : [];

        let chosenCode = null;
        let chosenRef = null;
        for (let i = 0; i < regSnaps.length; i++) {
          if (!regSnaps[i].exists) {
            chosenCode = filteredCandidates[i];
            chosenRef = candidateRefs[i];
            break;
          }
        }

        if (!chosenCode || !chosenRef) {
          throw new Error("ALL_CANDIDATES_TAKEN");
        }

        transaction.set(chosenRef, {
          uid: effectiveUid,
          studentType: mergedData.studentType || "non_corper",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        if (options.updateUserDoc !== false || (conflictedCode && userSnap && userSnap.exists)) {
          const userUpdates = {
            ...(options.initialUserFields || {}),
            regNumber: chosenCode,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          };
          if (options.assignedRole) {
            userUpdates.role = options.assignedRole;
          }
          if (userSnap?.exists && userDocData.submittedRole) {
            userUpdates.submittedRole = admin.firestore.FieldValue.delete();
          }
          transaction.set(userRef, userUpdates, { merge: true });
        }

        return {
          regNumber: chosenCode,
          alreadyAssigned: false,
          verifiedOwnership: true,
          replacedConflictingRegNumber: Boolean(conflictedCode),
        };
      });

      if (result && result.regNumber) {
        return result;
      }
    } catch (txErr) {
      lastError = txErr;
      if (txErr && txErr.message === "ALL_CANDIDATES_TAKEN") {
        // Proceed to next round with a fresh candidate window
        continue;
      }
      // For transient transaction contention, retry up to maxRounds
      console.warn(`Registration code transaction attempt ${round + 1}/${maxRounds} failed:`, txErr.message);
    }
  }

  console.error("Critical: Failed to allocate unique registration number after all transaction rounds:", lastError);
  throw new HttpsError(
    "aborted",
    "Unable to allocate a verified unique registration code at this moment. Please try again."
  );
}
exports.ensureUserRegNumber = ensureUserRegNumber;

/**
 * Generates a unique Registration Number for a user document (compatible wrapper).
 */
async function generateUniqueRegNumber(data, uid) {
  const { regNumber } = await ensureUserRegNumber(uid, data, { updateUserDoc: false });
  return regNumber;
}
exports.generateUniqueRegNumber = generateUniqueRegNumber;

/**
 * Callable Function: allocateRegistrationCode
 * Invoked immediately by the client during registration so the learner receives their
 * unique Registration Number in a single fast round-trip without waiting for background
 * trigger cold starts. Idempotent with onUserCreated.
 */
exports.allocateRegistrationCode = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required to allocate registration code.");
  }

  const uid = request.auth.uid;
  const payload = request.data || {};
  const token = request.auth.token || {};

  const assignedRole =
    token.admin === true ? "admin" : token.tutor === true ? "tutor" : "student";

  const isNonCorper = payload.studentType === "non_corper";
  const cleanEmail = (payload.email || token.email || "").trim().toLowerCase();
  const surnameClean = (payload.surname || "").trim();
  const firstNameClean = (payload.firstName || "").trim();
  const fullNameClean =
    (payload.fullName || payload.displayName || `${surnameClean} ${firstNameClean}`).trim() ||
    cleanEmail.split("@")[0] ||
    "Learner";

  const profileData = {
    uid,
    email: cleanEmail,
    displayName: fullNameClean,
    fullName: fullNameClean,
    surname: surnameClean || null,
    firstName: firstNameClean || null,
    studentType: payload.studentType || "non_corper",
    nyscStateCode: isNonCorper ? null : (payload.nyscStateCode || null),
    phoneNumber: payload.phoneNumber || "",
  };

  const { regNumber, alreadyAssigned } = await ensureUserRegNumber(uid, profileData, {
    assignedRole,
    updateUserDoc: true,
    initialUserFields: {
      ...profileData,
      status: "active",
    },
  });

  return {
    regNumber,
    role: assignedRole,
    alreadyAssigned,
  };
});

/**
 * 1. onCreate Trigger for users/{uid} documents
 * - Authoritatively assigns "student" role by default (client never sets role).
 * - Only pre-existing verified Custom Claims (e.g. from trusted bootstrap) can assign elevated roles.
 * - Idempotently ensures collision-safe regNumber and writes to Firestore.
 */
exports.onUserCreated = onDocumentCreated("users/{uid}", async (event) => {
  const snap = event.data;
  if (!snap) {
    console.log("No data associated with event");
    return null;
  }

  const data = snap.data() || {};
  const uid = event.params.uid;
  const userEmail = (data.email || "").trim().toLowerCase();

  // Single getUser(uid) call for both pre-existing claim check and claim sync
  let assignedRole = "student";
  let authUser = null;
  try {
    authUser = await admin.auth().getUser(uid);
    if (authUser.customClaims?.admin === true) {
      assignedRole = "admin";
    } else if (authUser.customClaims?.tutor === true) {
      assignedRole = "tutor";
    }
  } catch (authErr) {
    console.warn(`Notice: Unable to check pre-existing claims for ${uid}:`, authErr.message);
  }

  // Idempotently allocate or reuse existing regNumber and update user doc atomically
  const { regNumber, alreadyAssigned } = await ensureUserRegNumber(uid, data, {
    assignedRole,
    updateUserDoc: true,
  });

  try {
    if (alreadyAssigned && (data.role !== assignedRole || data.submittedRole)) {
      const updates = {
        role: assignedRole,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (data.submittedRole) {
        updates.submittedRole = admin.firestore.FieldValue.delete();
      }
      await snap.ref.set(updates, { merge: true });
    }

    console.log(`Successfully initialized user ${uid}: role=${assignedRole}, regNumber=${regNumber}`);

    const claims = authUser?.customClaims || {};
    const claimSyncPromise = (async () => {
      if (!authUser) return;
      if (assignedRole === "admin" && claims.admin !== true) {
        await admin.auth().setCustomUserClaims(uid, { ...claims, admin: true, tutor: false });
      } else if (assignedRole === "tutor" && claims.tutor !== true) {
        await admin.auth().setCustomUserClaims(uid, { ...claims, tutor: true, admin: false });
      } else if (assignedRole === "student" && (claims.admin || claims.tutor)) {
        await admin.auth().setCustomUserClaims(uid, { ...claims, admin: false, tutor: false });
      }
    })().catch((claimErr) => {
      console.warn(`Claims sync notice for ${uid}:`, claimErr.message);
    });

    const auditPromise = db
      .collection("auditLogs")
      .add({
        action: "User Created",
        detail: `User ${userEmail || uid} initialized with verified role '${assignedRole}', regNumber '${regNumber}'`,
        uid,
        email: userEmail,
        role: assignedRole,
        regNumber,
        badge: assignedRole === "admin" ? "pill-tech" : "pill-success",
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      })
      .catch((logErr) => {
        console.warn("Audit log notice:", logErr);
      });

    await Promise.allSettled([claimSyncPromise, auditPromise]);
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
    const isAssigned =
      courseData.tutorId === callerUid ||
      courseData.tutorUid === callerUid ||
      courseData.instructorId === callerUid ||
      (Array.isArray(courseData.assignedTutors) && courseData.assignedTutors.includes(callerUid));

    if (!isAssigned) {
      throw new HttpsError("permission-denied", "Instructors may only manage enrollments for their assigned courses.");
    }
  }

  const updates = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const allowedStatuses = ["active", "approved", "pending", "rejected", "revoked", "suspended", "completed"];
  if (status && allowedStatuses.includes(status)) {
    updates.status = status;
    if (status === "approved" || status === "active") {
      updates.approvedBy = callerUid;
      updates.approvedAt = admin.firestore.FieldValue.serverTimestamp();
    } else if (status === "rejected") {
      updates.rejectedBy = callerUid;
      updates.rejectedAt = admin.firestore.FieldValue.serverTimestamp();
    } else if (status === "revoked") {
      updates.revokedBy = callerUid;
      updates.revokedAt = admin.firestore.FieldValue.serverTimestamp();
    }
  } else {
    updates.approvedBy = callerUid;
  }

  if (paymentStatus && ["paid", "pending", "waived"].includes(paymentStatus)) {
    updates.paymentStatus = paymentStatus;
    updates.isPaid = paymentStatus === "paid" || paymentStatus === "waived";
  } else if (typeof isPaid === "boolean") {
    updates.isPaid = isPaid;
    updates.paymentStatus = isPaid ? "paid" : "pending";
  }

  const batch = db.batch();
  batch.update(enrollmentRef, updates);

  const notifRef = db.collection("users").doc(enrollmentData.uid).collection("notifications").doc();
  batch.set(notifRef, {
    type: "enrollment",
    title: "Enrollment Status Updated",
    body: `Your enrollment for '${enrollmentData.courseTitle || courseId}' is now ${updates.status || "updated"}.`,
    courseId,
    senderUid: callerUid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    read: false,
  });

  const auditRef = db.collection("auditLogs").doc();
  batch.set(auditRef, {
    action: "Enrollment Status Updated",
    detail: `Updated enrollment '${enrollmentId}' for student ${enrollmentData.uid} in course '${courseId}' to status '${updates.status || enrollmentData.status}' by ${callerUid}`,
    enrollmentId,
    uid: enrollmentData.uid,
    courseId,
    status: updates.status || enrollmentData.status,
    adminUid: callerUid,
    badge: updates.status === "active" || updates.status === "approved" ? "pill-success" : "pill-warning",
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();
  await recomputeCourseAnalytics(courseId).catch(() => {});

  return { success: true, enrollmentId, status: updates.status || enrollmentData.status, updates };
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

  // 1. Verify target exists in Firebase Auth & inspect custom claims
  let authUser;
  try {
    authUser = await admin.auth().getUser(targetUid);
  } catch {
    throw new HttpsError("not-found", `User '${targetUid}' not found in Firebase Authentication.`);
  }

  const userRef = db.collection("users").doc(targetUid);
  const userSnap = await userRef.get();
  const userData = userSnap.exists ? userSnap.data() : {};
  const existingClaims = authUser?.customClaims || {};

  if (userData.role === "admin" || existingClaims.admin === true) {
    throw new HttpsError("failed-precondition", "Security Protection: Cannot suspend another administrator account.");
  }

  const wasTutor =
    userData.role === "tutor" ||
    userData.previousRole === "tutor" ||
    existingClaims.tutor === true;

  // 2. Update Firebase Authentication disabled state and synchronize custom claims
  try {
    await admin.auth().updateUser(targetUid, { disabled: isSuspended });
    if (isSuspended) {
      if (existingClaims.tutor === true || existingClaims.role === "tutor") {
        await admin.auth().setCustomUserClaims(targetUid, {
          ...existingClaims,
          admin: false,
          tutor: false,
          role: "student",
          suspended: true,
        });
      }
      await admin.auth().revokeRefreshTokens(targetUid);
    } else if (wasTutor && userData.tutorStatus !== "deactivated") {
      await admin.auth().setCustomUserClaims(targetUid, {
        ...existingClaims,
        admin: false,
        tutor: true,
        role: "tutor",
        suspended: false,
      });
    }
  } catch (disableErr) {
    console.error("Failed to update Firebase Auth user disabled state:", disableErr);
    throw new HttpsError("internal", "Failed to update authentication account state.");
  }

  // 3. Update Firestore user profile
  const updates = {
    status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (wasTutor && userData.tutorStatus !== "deactivated") {
    updates.previousRole = "tutor";
    updates.tutorStatus = isSuspended ? "suspended" : "active";
  }

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
  const roleLabel = wasTutor ? "Tutor" : "Learner";
  batch.set(auditRef, {
    action: isSuspended ? `${roleLabel} Suspended` : `${roleLabel} Reactivated`,
    detail: `${roleLabel} ${userData.email || targetUid} account status set to '${status}' by admin ${callerUid}.${isSuspended ? ` Reason: ${updates.suspensionReason}` : ""}`,
    targetUid,
    targetEmail: userData.email || "",
    targetRole: wasTutor ? "tutor" : "student",
    status,
    reason: isSuspended ? updates.suspensionReason : null,
    adminUid: callerUid,
    badge: isSuspended ? "pill-danger" : "pill-success",
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();
  return { success: true, targetUid, status, role: wasTutor ? "tutor" : (userData.role || "student") };
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
 * - Verifies target user exists in Firebase Auth and Firestore and holds a valid tutor or admin role/claim.
 * - Synchronizes courses/{courseId} with tutor assignment metadata and records an audit log.
 */
exports.adminAssignCourseTutor = onCall(async (request) => {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Access denied: Verified administrator privileges required.");
  }

  const callerUid = request.auth.uid;
  const { courseId, tutorUid, targetUid: rawTargetUid, action } = request.data || {};
  const effectiveTutorUid = tutorUid || rawTargetUid || null;

  if (!courseId || typeof courseId !== "string") {
    throw new HttpsError("invalid-argument", "Valid courseId is required.");
  }

  const courseRef = db.collection("courses").doc(courseId);
  const courseSnap = await courseRef.get();

  if (!courseSnap.exists) {
    throw new HttpsError("not-found", `Course '${courseId}' not found.`);
  }

  const courseData = courseSnap.data();
  const isAssign = action !== "remove" && action !== "unassign";

  let tutorName = "Assigned Instructor";
  let tutorData = {};
  if (isAssign) {
    if (!effectiveTutorUid || typeof effectiveTutorUid !== "string") {
      throw new HttpsError("invalid-argument", "Valid tutorUid is required to assign a course.");
    }

    let authUser;
    try {
      authUser = await admin.auth().getUser(effectiveTutorUid);
    } catch {
      throw new HttpsError("not-found", `Target user '${effectiveTutorUid}' does not exist in Firebase Authentication.`);
    }

    if (authUser.disabled) {
      throw new HttpsError(
        "failed-precondition",
        `Cannot assign a course to disabled user '${effectiveTutorUid}'.`
      );
    }

    const tutorSnap = await db.collection("users").doc(effectiveTutorUid).get();
    if (!tutorSnap.exists) {
      throw new HttpsError("not-found", `Tutor user profile '${effectiveTutorUid}' not found in Firestore.`);
    }
    tutorData = tutorSnap.data() || {};

    if (
      tutorData.status === "suspended" ||
      tutorData.status === "disabled" ||
      tutorData.status === "deactivated" ||
      tutorData.tutorStatus === "deactivated"
    ) {
      throw new HttpsError(
        "failed-precondition",
        `Cannot assign a course to a suspended, disabled, or deactivated account ('${effectiveTutorUid}').`
      );
    }

    const claims = authUser.customClaims || {};
    const hasValidClaim =
      claims.tutor === true ||
      claims.admin === true ||
      claims.role === "tutor" ||
      claims.role === "admin";
    const hasValidProfileRole = tutorData.role === "tutor" || tutorData.role === "admin";

    let hasApprovedApplication = false;
    if (!hasValidClaim && !hasValidProfileRole) {
      const appSnap = await db
        .collection("tutorApplications")
        .where("applicantUid", "==", effectiveTutorUid)
        .where("status", "==", "approved")
        .limit(1)
        .get();
      hasApprovedApplication = !appSnap.empty;
    }

    if (!hasValidClaim && !hasValidProfileRole && !hasApprovedApplication) {
      throw new HttpsError(
        "failed-precondition",
        `User '${effectiveTutorUid}' does not hold a valid tutor or administrator role and cannot be assigned to a course.`
      );
    }

    // Deliberately synchronize custom claims if Firestore profile/application is approved tutor while Auth custom claims are out of sync
    if (!hasValidClaim && (hasValidProfileRole || hasApprovedApplication)) {
      const isTargetAdmin = tutorData.role === "admin" || claims.admin === true;
      await admin.auth().setCustomUserClaims(effectiveTutorUid, {
        ...claims,
        admin: isTargetAdmin,
        tutor: !isTargetAdmin,
        role: isTargetAdmin ? "admin" : "tutor",
      });
    }

    tutorName = tutorData.fullName || tutorData.displayName || authUser.displayName || "Instructor";
  }

  const existingAssigned = Array.isArray(courseData.assignedTutors)
    ? [...courseData.assignedTutors]
    : courseData.tutorId
      ? [courseData.tutorId]
      : [];

  const updates = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const batch = db.batch();

  if (isAssign) {
    const nextAssigned = Array.from(new Set([...existingAssigned, effectiveTutorUid]));
    updates.tutorId = effectiveTutorUid;
    updates.tutorUid = effectiveTutorUid;
    updates.tutorName = tutorName;
    updates.assignedTutors = nextAssigned;
    updates.needsTutorReassignment = false;

    const userRef = db.collection("users").doc(effectiveTutorUid);
    const userUpdates = {
      assignedCourses: admin.firestore.FieldValue.arrayUnion(courseId),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (tutorData.role !== "tutor" && tutorData.role !== "admin") {
      userUpdates.role = "tutor";
      userUpdates.tutorStatus = "active";
    }
    batch.set(userRef, userUpdates, { merge: true });

    // Notify tutor
    const notifRef = userRef.collection("notifications").doc();
    batch.set(notifRef, {
      type: "course_assignment",
      title: "Course Assigned! 📚",
      body: `You have been assigned as an instructor for '${courseData.title || courseId}'.`,
      courseId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      read: false,
    });
  } else {
    const remainingAssigned = effectiveTutorUid
      ? existingAssigned.filter((id) => id !== effectiveTutorUid)
      : [];
    updates.assignedTutors = remainingAssigned;
    if (!effectiveTutorUid || courseData.tutorId === effectiveTutorUid || courseData.tutorUid === effectiveTutorUid || remainingAssigned.length === 0) {
      if (remainingAssigned.length > 0) {
        const nextTutorUid = remainingAssigned[0];
        const nextSnap = await db.collection("users").doc(nextTutorUid).get();
        const nextName = nextSnap.exists
          ? nextSnap.data()?.fullName || nextSnap.data()?.displayName || "Assigned Instructor"
          : "Assigned Instructor";
        updates.tutorId = nextTutorUid;
        updates.tutorUid = nextTutorUid;
        updates.tutorName = nextName;
        updates.needsTutorReassignment = false;
      } else {
        updates.tutorId = null;
        updates.tutorUid = null;
        updates.tutorName = null;
        updates.needsTutorReassignment = true;
      }
    }
    if (effectiveTutorUid) {
      const userRef = db.collection("users").doc(effectiveTutorUid);
      const userSnap = await userRef.get();
      if (userSnap.exists) {
        batch.update(userRef, {
          assignedCourses: admin.firestore.FieldValue.arrayRemove(courseId),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }
  }

  batch.update(courseRef, updates);

  const auditRef = db.collection("auditLogs").doc();
  batch.set(auditRef, {
    action: isAssign ? "Tutor Assigned to Course" : "Tutor Removed from Course",
    detail: isAssign
      ? `Tutor ${tutorName} (${effectiveTutorUid}) assigned to course '${courseData.title || courseId}' by admin ${callerUid}`
      : `Tutor assignment removed from course '${courseData.title || courseId}' by admin ${callerUid}`,
    courseId,
    courseTitle: courseData.title || courseId,
    tutorUid: effectiveTutorUid || null,
    adminUid: callerUid,
    badge: isAssign ? "pill-success" : "pill-warning",
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();
  return { success: true, courseId, tutorUid: effectiveTutorUid, action: isAssign ? "assign" : "remove" };
});

/**
 * 8B. Callable Function: adminDeleteTutor
 * - Strictly requires `request.auth.token.admin === true`
 * - Supports `mode: "deactivate"` (demotes tutor to student & revokes tutor custom claim while keeping learner account)
 *   and `mode: "delete"` (resumable permanent deletion state machine that archives user metadata, processes course
 *   assignments and tutor applications in bounded batches of <= 350 writes, verifies each stage, deletes the
 *   Firestore user profile & private subcollections, and deletes the Firebase Auth account ONLY after all
 *   required Firestore changes have been committed and verified).
 * - NEVER deletes courses owned by the tutor: cleans up `tutorId`, `tutorUid`, `tutorName`, and `assignedTutors`
 *   on all affected courses, promoting a co-tutor if one exists or marking `needsTutorReassignment: true`.
 * - Preserves all historical academic records (`enrollments`, `assignmentSubmissions`, `testSubmissions`, `auditLogs`, `regNumbers`).
 */
exports.adminDeleteTutor = onCall(async (request) => {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Access denied: Verified administrator privileges required.");
  }

  const callerUid = request.auth.uid;
  const { targetUid, mode = "deactivate", reason = "" } = request.data || {};

  if (!targetUid || typeof targetUid !== "string") {
    throw new HttpsError("invalid-argument", "Valid targetUid is required.");
  }
  if (!["deactivate", "delete"].includes(mode)) {
    throw new HttpsError("invalid-argument", "mode must be 'deactivate' or 'delete'.");
  }
  if (targetUid === callerUid) {
    throw new HttpsError("failed-precondition", "Security Protection: Administrators cannot delete or deactivate their own account.");
  }

  const userRef = db.collection("users").doc(targetUid);
  const deletedUserRef = db.collection("deletedUsers").doc(targetUid);
  const [userSnap, deletedUserSnap] = await Promise.all([
    userRef.get(),
    deletedUserRef.get(),
  ]);

  const priorDeletion = deletedUserSnap.exists ? (deletedUserSnap.data() || {}) : null;
  const isResumingDelete =
    mode === "delete" &&
    Boolean(priorDeletion && (priorDeletion.previousRole === "tutor" || priorDeletion.mode === "delete"));

  let authUser = null;
  try {
    authUser = await admin.auth().getUser(targetUid);
  } catch (err) {
    if (err.code !== "auth/user-not-found") {
      throw new HttpsError("internal", `Failed to inspect Firebase Auth user: ${err.message}`);
    }
  }

  if (!userSnap.exists && !authUser && !isResumingDelete) {
    throw new HttpsError("not-found", `Tutor account '${targetUid}' does not exist.`);
  }

  const userData = userSnap.exists ? (userSnap.data() || {}) : {};
  const existingClaims = authUser?.customClaims || {};

  if (userData.role === "admin" || existingClaims.admin === true) {
    throw new HttpsError("failed-precondition", "Security Protection: Cannot delete or demote an administrator account via tutor management.");
  }

  const isTutorAccount =
    isResumingDelete ||
    userData.role === "tutor" ||
    userData.previousRole === "tutor" ||
    userData.tutorStatus === "deactivated" ||
    existingClaims.tutor === true ||
    existingClaims.role === "tutor" ||
    (Array.isArray(userData.assignedCourses) && userData.assignedCourses.length > 0);

  if (!isTutorAccount) {
    throw new HttpsError("failed-precondition", `User '${targetUid}' is not a tutor account.`);
  }

  const tutorName =
    userData.fullName ||
    userData.displayName ||
    priorDeletion?.fullName ||
    authUser?.displayName ||
    userData.email ||
    priorDeletion?.email ||
    targetUid;
  const tutorEmail = userData.email || priorDeletion?.email || authUser?.email || null;
  const tutorRegNumber = userData.regNumber || priorDeletion?.regNumber || null;
  const cleanReason =
    typeof reason === "string" && reason.trim()
      ? reason.trim()
      : priorDeletion?.deletionReason || "Administrative tutor removal";

  // Helper to discover all courses currently referencing targetUid
  const findAssignedCourseDocs = async () => {
    const [byTutorIdSnap, byTutorUidSnap, byAssignedArraySnap] = await Promise.all([
      db.collection("courses").where("tutorId", "==", targetUid).get(),
      db.collection("courses").where("tutorUid", "==", targetUid).get(),
      db.collection("courses").where("assignedTutors", "array-contains", targetUid).get(),
    ]);
    const courseMap = new Map();
    [byTutorIdSnap, byTutorUidSnap, byAssignedArraySnap].forEach((snap) => {
      snap.docs.forEach((d) => courseMap.set(d.id, d));
    });
    return courseMap;
  };

  // 1. Discover all courses and tutorApplications associated with this tutor
  const affectedCourseDocs = await findAssignedCourseDocs();
  const unassignedCourseIdSet = new Set(
    Array.isArray(priorDeletion?.unassignedCourseIds) ? priorDeletion.unassignedCourseIds : []
  );
  const coursesNeedingReassignmentSet = new Set(
    Array.isArray(priorDeletion?.coursesNeedingReassignment) ? priorDeletion.coursesNeedingReassignment : []
  );

  const stageOperations = [];

  for (const [cId, cDoc] of affectedCourseDocs.entries()) {
    unassignedCourseIdSet.add(cId);
    const cData = cDoc.data() || {};
    const remainingTutors = Array.isArray(cData.assignedTutors)
      ? cData.assignedTutors.filter((id) => id && id !== targetUid)
      : [];

    const courseUpdates = {
      assignedTutors: remainingTutors,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (
      cData.tutorId === targetUid ||
      cData.tutorUid === targetUid ||
      cData.instructorId === targetUid ||
      remainingTutors.length === 0
    ) {
      if (remainingTutors.length > 0) {
        const nextTutorUid = remainingTutors[0];
        const nextTutorSnap = await db.collection("users").doc(nextTutorUid).get();
        const nextTutorName = nextTutorSnap.exists
          ? nextTutorSnap.data()?.fullName || nextTutorSnap.data()?.displayName || "Assigned Instructor"
          : "Assigned Instructor";
        courseUpdates.tutorId = nextTutorUid;
        courseUpdates.tutorUid = nextTutorUid;
        courseUpdates.tutorName = nextTutorName;
        courseUpdates.needsTutorReassignment = false;
      } else {
        courseUpdates.tutorId = null;
        courseUpdates.tutorUid = null;
        courseUpdates.tutorName = null;
        courseUpdates.needsTutorReassignment = true;
        courseUpdates.previousTutorUid = targetUid;
        courseUpdates.previousTutorName = tutorName;
        coursesNeedingReassignmentSet.add(cId);
      }
    }

    stageOperations.push({
      type: "update",
      ref: cDoc.ref,
      data: courseUpdates,
    });
  }

  const unassignedCourseIds = Array.from(unassignedCourseIdSet);
  const coursesNeedingReassignment = Array.from(coursesNeedingReassignmentSet);

  const tutorAppsSnap = await db
    .collection("tutorApplications")
    .where("applicantUid", "==", targetUid)
    .get();

  const targetAppStatus = mode === "delete" ? "account_deleted" : "revoked";
  tutorAppsSnap.docs.forEach((appDoc) => {
    const appData = appDoc.data() || {};
    if (appData.status !== targetAppStatus) {
      stageOperations.push({
        type: "update",
        ref: appDoc.ref,
        data: {
          status: targetAppStatus,
          revokedAt: admin.firestore.FieldValue.serverTimestamp(),
          revokedBy: callerUid,
          revocationReason: cleanReason,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      });
    }
  });

  if (mode === "deactivate") {
    // Stage 1: Record deactivation in_progress state on user doc
    if (userSnap.exists) {
      await userRef.set(
        {
          tutorDeactivationState: "in_progress",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    // Stage 2: Process course unassignments and tutorApplications in bounded batches (<= 350 writes)
    await commitOperationsInBoundedBatches(stageOperations, 350);

    // Verify Stage 2: Ensure no courses remain assigned to targetUid
    const remainingCoursesAfterDeactivate = await findAssignedCourseDocs();
    if (remainingCoursesAfterDeactivate.size > 0) {
      if (userSnap.exists) {
        await userRef.set(
          {
            tutorDeactivationState: "failed",
            tutorDeactivationError: "Course unassignment verification failed.",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
      throw new HttpsError(
        "internal",
        `Verification failed: ${remainingCoursesAfterDeactivate.size} course(s) still reference tutor '${targetUid}'.`
      );
    }

    // Stage 3: Revoke Firebase Auth custom claims and refresh tokens
    if (authUser) {
      try {
        await admin.auth().setCustomUserClaims(targetUid, {
          ...existingClaims,
          admin: false,
          tutor: false,
          role: "student",
        });
        await admin.auth().revokeRefreshTokens(targetUid);
      } catch (err) {
        if (userSnap.exists) {
          await userRef.set(
            {
              tutorDeactivationState: "failed",
              tutorDeactivationError: err.message || String(err),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
        throw new HttpsError("internal", `Failed to revoke tutor custom claims: ${err.message}`);
      }
    }

    // Stage 4: Finalize user profile demotion, notification, and audit log
    const finalBatch = db.batch();
    if (userSnap.exists) {
      finalBatch.update(userRef, {
        role: "student",
        previousRole: "tutor",
        tutorStatus: "deactivated",
        tutorDeactivationState: "completed",
        tutorDeactivationError: admin.firestore.FieldValue.delete(),
        assignedCourses: [],
        tutorDeactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
        tutorDeactivatedBy: callerUid,
        tutorDeactivationReason: cleanReason,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const notifRef = userRef.collection("notifications").doc();
      finalBatch.set(notifRef, {
        title: "Instructor Privileges Revoked",
        body: `Your instructor privileges have been deactivated by an administrator. Reason: ${cleanReason}`,
        type: "tutor_deactivated",
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    const auditRef = db.collection("auditLogs").doc();
    finalBatch.set(auditRef, {
      action: "Tutor Role Deactivated",
      detail: `Tutor '${tutorName}' (${targetUid}) was demoted to student and unassigned from ${unassignedCourseIds.length} course(s). Reason: ${cleanReason}`,
      targetUid,
      adminUid: callerUid,
      mode: "deactivate",
      reason: cleanReason,
      unassignedCourseIds,
      coursesNeedingReassignment,
      badge: "pill-warning",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    await finalBatch.commit();
    return {
      success: true,
      targetUid,
      mode: "deactivate",
      deletionState: "deactivated",
      unassignedCourseIds,
      coursesNeedingReassignment,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // mode === "delete": Safe, Resumable Permanent Tutor Deletion State Machine
  // ══════════════════════════════════════════════════════════════════════════

  // If this is a retry of an already completed deletion and nothing remains to clean up, return idempotently
  if (
    priorDeletion?.deletionState === "completed" &&
    !userSnap.exists &&
    !authUser &&
    stageOperations.length === 0
  ) {
    return {
      success: true,
      targetUid,
      mode: "delete",
      deletionState: "completed",
      idempotentRetry: true,
      unassignedCourseIds,
      coursesNeedingReassignment,
    };
  }

  // Stage 1: Archive user metadata & record deletion operation state (`in_progress`) BEFORE mutating courses or Auth
  await deletedUserRef.set(
    {
      uid: targetUid,
      email: tutorEmail,
      fullName: tutorName,
      regNumber: tutorRegNumber,
      previousRole: "tutor",
      mode: "delete",
      deletionState: "in_progress",
      unassignedCourseIds,
      coursesNeedingReassignment,
      deletedBy: callerUid,
      deletionReason: cleanReason,
      stages: {
        ...(priorDeletion?.stages || {}),
        archived: true,
      },
      startedAt: priorDeletion?.startedAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // Verify Stage 1: Confirm archive record exists before proceeding
  const verifiedArchiveSnap = await deletedUserRef.get();
  if (!verifiedArchiveSnap.exists || verifiedArchiveSnap.data()?.uid !== targetUid) {
    throw new HttpsError(
      "internal",
      `Verification failed: Could not confirm archive record in deletedUsers/${targetUid}.`
    );
  }

  // Immediately suspend the user document and revoke elevated Auth claims / disable Auth login while deletion runs
  if (userSnap.exists) {
    await userRef.set(
      {
        status: "suspended",
        deletionState: "in_progress",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  if (authUser) {
    try {
      await admin.auth().setCustomUserClaims(targetUid, {
        ...existingClaims,
        admin: false,
        tutor: false,
        role: "deleted",
      });
      if (typeof admin.auth().updateUser === "function") {
        await admin.auth().updateUser(targetUid, { disabled: true });
      }
      if (typeof admin.auth().revokeRefreshTokens === "function") {
        await admin.auth().revokeRefreshTokens(targetUid);
      }
    } catch (claimErr) {
      if (claimErr?.code !== "auth/user-not-found") {
        await deletedUserRef.set(
          {
            deletionState: "failed",
            failedStage: "suspend_auth_access",
            lastError: claimErr.message || String(claimErr),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        throw new HttpsError(
          "internal",
          `Failed to suspend tutor authentication state before deletion: ${claimErr.message}`
        );
      }
    }
  }

  // Stage 2: Process course unassignments & tutorApplications in bounded batches of <= 350 writes
  try {
    await commitOperationsInBoundedBatches(stageOperations, 350);
  } catch (batchErr) {
    await deletedUserRef.set(
      {
        deletionState: "failed",
        failedStage: "unassign_courses_and_applications",
        lastError: batchErr.message || String(batchErr),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    throw new HttpsError(
      "internal",
      `Failed to unassign tutor courses and applications in bounded batches: ${batchErr.message}`
    );
  }

  // Verify Stage 2: Re-query courses and tutorApplications to confirm all updates succeeded
  const remainingCourseDocs = await findAssignedCourseDocs();
  if (remainingCourseDocs.size > 0) {
    await deletedUserRef.set(
      {
        deletionState: "failed",
        failedStage: "verify_course_unassignment",
        lastError: `${remainingCourseDocs.size} course(s) still reference tutor '${targetUid}'.`,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    throw new HttpsError(
      "internal",
      `Verification failed: ${remainingCourseDocs.size} course(s) still reference tutor '${targetUid}'.`
    );
  }

  const remainingAppsSnap = await db
    .collection("tutorApplications")
    .where("applicantUid", "==", targetUid)
    .get();
  const unupdatedApps = remainingAppsSnap.docs.filter(
    (d) => d.data()?.status !== "account_deleted"
  );
  if (unupdatedApps.length > 0) {
    await deletedUserRef.set(
      {
        deletionState: "failed",
        failedStage: "verify_tutor_applications",
        lastError: `${unupdatedApps.length} tutor application(s) were not marked account_deleted.`,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    throw new HttpsError(
      "internal",
      `Verification failed: ${unupdatedApps.length} tutor application(s) were not updated.`
    );
  }

  await deletedUserRef.set(
    {
      stages: {
        ...(verifiedArchiveSnap.data()?.stages || {}),
        archived: true,
        coursesAndApplicationsCleaned: true,
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // Stage 3: Delete user-private subcollections in bounded batches (<= 350) and delete users/{targetUid}
  try {
    await deleteQueryInBoundedBatches(userRef.collection("notifications"), 350);
    await deleteQueryInBoundedBatches(userRef.collection("dailyActivity"), 350);
    await userRef.delete();
  } catch (fsDelErr) {
    await deletedUserRef.set(
      {
        deletionState: "failed",
        failedStage: "delete_firestore_user",
        lastError: fsDelErr.message || String(fsDelErr),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    throw new HttpsError(
      "internal",
      `Failed to delete tutor Firestore profile or private subcollections: ${fsDelErr.message}`
    );
  }

  // Verify Stage 3: Confirm users/{targetUid} and private subcollections are removed
  const [afterUserSnap, afterNotifSnap, afterActivitySnap] = await Promise.all([
    userRef.get(),
    userRef.collection("notifications").limit(1).get(),
    userRef.collection("dailyActivity").limit(1).get(),
  ]);
  if (afterUserSnap.exists || !afterNotifSnap.empty || !afterActivitySnap.empty) {
    await deletedUserRef.set(
      {
        deletionState: "failed",
        failedStage: "verify_firestore_user_deletion",
        lastError: "Tutor profile document or private subcollections still exist after deletion.",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    throw new HttpsError(
      "internal",
      "Verification failed: Tutor Firestore profile or private subcollections still exist."
    );
  }

  await deletedUserRef.set(
    {
      stages: {
        archived: true,
        coursesAndApplicationsCleaned: true,
        firestoreUserDeleted: true,
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // Stage 4: Delete Firebase Authentication account ONLY AFTER all required Firestore changes are confirmed
  try {
    await admin.auth().deleteUser(targetUid);
  } catch (authDelErr) {
    if (authDelErr?.code !== "auth/user-not-found") {
      await deletedUserRef.set(
        {
          deletionState: "failed",
          failedStage: "delete_auth_user",
          lastError: authDelErr.message || String(authDelErr),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      throw new HttpsError(
        "internal",
        `Firestore records were archived and cleaned, but Firebase Authentication deletion failed (retry to complete): ${authDelErr.message}`
      );
    }
  }

  // Stage 5: Finalize deletion state to `completed` and write authoritative audit log
  const completionBatch = db.batch();
  completionBatch.set(
    deletedUserRef,
    {
      deletionState: "completed",
      failedStage: admin.firestore.FieldValue.delete(),
      lastError: admin.firestore.FieldValue.delete(),
      stages: {
        archived: true,
        coursesAndApplicationsCleaned: true,
        firestoreUserDeleted: true,
        authUserDeleted: true,
      },
      deletedAt: admin.firestore.FieldValue.serverTimestamp(),
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  const auditRef = db.collection("auditLogs").doc();
  completionBatch.set(auditRef, {
    action: "Tutor Account Deleted",
    detail: `Tutor account '${tutorName}' (${targetUid}) was permanently deleted and unassigned from ${unassignedCourseIds.length} course(s). Reason: ${cleanReason}`,
    targetUid,
    adminUid: callerUid,
    mode: "delete",
    reason: cleanReason,
    unassignedCourseIds,
    coursesNeedingReassignment,
    badge: "pill-danger",
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  await completionBatch.commit();

  return {
    success: true,
    targetUid,
    mode: "delete",
    deletionState: "completed",
    unassignedCourseIds,
    coursesNeedingReassignment,
  };
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
 * - When target === 'course', strictly filters enrollments to active/approved only.
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
    const targetCourse = targetId || courseId;
    if (!targetCourse) throw new HttpsError("invalid-argument", "courseId is required for course targeting.");
    const enrSnap = await db.collection("enrollments").where("courseId", "==", targetCourse).limit(500).get();
    recipientUids = Array.from(
      new Set(
        enrSnap.docs
          .filter((d) => ["active", "approved"].includes(d.data()?.status))
          .map((d) => d.data()?.uid)
          .filter(Boolean)
      )
    );
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
      courseId: courseId || (target === "course" ? targetId : null) || null,
      read: false,
      senderUid: callerUid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    opCount++;
    writtenCount++;

    if (opCount >= 400) {
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
    const existingSnap = await enrollmentRef.get();
    const existingData = existingSnap.exists ? existingSnap.data() : {};
    batch.set(
      enrollmentRef,
      {
        uid,
        courseId,
        courseTitle: courseTitle || existingData.courseTitle || courseId,
        status: "active",
        isPaid: true,
        paymentStatus: "waived",
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        approvedBy: callerUid,
        enrolledAt: existingData.enrolledAt || admin.firestore.FieldValue.serverTimestamp(),
        completedItemIds: Array.isArray(existingData.completedItemIds) ? existingData.completedItemIds : [],
        progressPercent: typeof existingData.progressPercent === "number" ? existingData.progressPercent : 0,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const notifRef = db.collection("users").doc(uid).collection("notifications").doc();
    batch.set(notifRef, {
      type: "enrollment",
      title: "Course Enrollment Granted! 🎓",
      body: `You have been officially enrolled in '${courseTitle || existingData.courseTitle || courseId}' by administration.`,
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
  await recomputeCourseAnalytics(courseId).catch(() => {});

  return { success: true, enrollmentId, action: isGrant ? "grant" : "revoke" };
});

/**
 * Helper: Deletes all documents in a collection or query in bounded batches (<= 350 ops).
 */
async function deleteQueryInBoundedBatches(collectionOrQuery, chunkSize = 350) {
  const safeChunkSize = Math.min(350, Math.max(1, Number(chunkSize) || 350));
  let deletedTotal = 0;
  while (true) {
    const q = typeof collectionOrQuery.limit === "function"
      ? collectionOrQuery.limit(safeChunkSize)
      : collectionOrQuery;
    const snap = await q.get();
    if (snap.empty) break;
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += safeChunkSize) {
      const chunk = docs.slice(i, i + safeChunkSize);
      const batch = db.batch();
      chunk.forEach((docSnap) => batch.delete(docSnap.ref));
      await batch.commit();
      deletedTotal += chunk.length;
    }
    if (typeof collectionOrQuery.limit !== "function" || snap.size < safeChunkSize) break;
  }
  return deletedTotal;
}
exports.deleteQueryInBoundedBatches = deleteQueryInBoundedBatches;

/**
 * Validates that a Firebase Storage object path strictly belongs to the target course's
 * authorized Storage prefixes (`courses/${courseId}/` or `resources/${courseId}/`) and
 * contains no path traversal or cross-course references.
 */
function isAuthorizedCourseStoragePath(courseId, storagePath) {
  if (!courseId || typeof courseId !== "string" || !courseId.trim()) return false;
  const cleanCourseId = courseId.trim();
  if (
    cleanCourseId.includes("/") ||
    cleanCourseId.includes("..") ||
    cleanCourseId.includes("\\") ||
    cleanCourseId === "general" ||
    cleanCourseId === "platform"
  ) {
    return false;
  }
  if (!storagePath || typeof storagePath !== "string") return false;
  const normalized = storagePath.trim().replace(/^\/+/, "");
  if (
    !normalized ||
    normalized.includes("..") ||
    normalized.includes("\\") ||
    normalized.includes("\0")
  ) {
    return false;
  }
  return (
    normalized.startsWith(`courses/${cleanCourseId}/`) ||
    normalized.startsWith(`resources/${cleanCourseId}/`)
  );
}
exports.isAuthorizedCourseStoragePath = isAuthorizedCourseStoragePath;

/**
 * Helper: Recursively discovers and deletes all subcollections and nested documents under `docRef`
 * bottom-up in bounded batches of at most 350 writes.
 * - Strictly requires `docRef.listCollections()` and treats any discovery failure on `docRef` or
 *   any nested child document as a real error (never swallows errors or falls back silently).
 */
async function deleteSubcollectionsRecursively(docRef, chunkSize = 350) {
  const safeChunkSize = Math.min(350, Math.max(1, Number(chunkSize) || 350));
  if (!docRef || typeof docRef.listCollections !== "function") {
    throw new Error(
      `Subcollection discovery failed for '${docRef?.path || "unknown"}': listCollections() is required.`
    );
  }

  // Treat listCollections() failures as real errors — never catch and ignore discovery errors.
  const subcollections = await docRef.listCollections();
  if (!Array.isArray(subcollections)) {
    throw new Error(
      `Subcollection discovery failed for '${docRef.path || "unknown"}': listCollections() did not return a collection list.`
    );
  }

  let totalDeleted = 0;
  for (const subCol of subcollections) {
    while (true) {
      const q = typeof subCol.limit === "function" ? subCol.limit(safeChunkSize) : subCol;
      const snap = await q.get();
      if (snap.empty) break;

      for (const childDoc of snap.docs) {
        totalDeleted += await deleteSubcollectionsRecursively(childDoc.ref, safeChunkSize);
      }

      const docs = snap.docs;
      for (let i = 0; i < docs.length; i += safeChunkSize) {
        const chunk = docs.slice(i, i + safeChunkSize);
        const batch = db.batch();
        chunk.forEach((d) => batch.delete(d.ref));
        await batch.commit();
        totalDeleted += chunk.length;
      }

      if (typeof subCol.limit !== "function" || snap.size < safeChunkSize) break;
    }
  }

  return totalDeleted;
}
exports.deleteSubcollectionsRecursively = deleteSubcollectionsRecursively;

/**
 * 12. Callable Function: adminManageCourse
 * - Admin-only callable to create, update, toggle status, seedCatalog, or delete courses with server-controlled audit logging.
 * - Update preserves existing fields not explicitly supplied.
 * - Delete recursively cleans up all subcollections, top-level course resources, and Storage objects in bounded batches.
 */
exports.adminManageCourse = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const callerUid = request.auth.uid;
  const isCallerAdmin = request.auth.token.admin === true;
  const isCallerTutor = request.auth.token.tutor === true;
  const { action, courseId, courseData, courses } = request.data || {};

  if (!action || !["create", "update", "toggleStatus", "delete", "seedCatalog"].includes(action)) {
    throw new HttpsError("invalid-argument", "Action must be 'create', 'update', 'toggleStatus', 'delete', or 'seedCatalog'.");
  }

  if (!isCallerAdmin && !(isCallerTutor && action === "toggleStatus")) {
    throw new HttpsError("permission-denied", "Access denied: Verified administrator privileges required.");
  }

  if (action === "seedCatalog") {
    if (!Array.isArray(courses) || courses.length === 0) {
      throw new HttpsError("invalid-argument", "Non-empty courses array is required for seedCatalog.");
    }
    let seededCount = 0;
    let skippedCount = 0;
    const seededIds = [];

    for (const c of courses) {
      const cId = c?.id;
      if (!cId || typeof cId !== "string" || !c?.title) continue;
      const cRef = db.collection("courses").doc(cId);
      const cSnap = await cRef.get();
      if (cSnap.exists) {
        skippedCount++;
        continue;
      }

      const payload = {
        id: cId,
        title: String(c.title).trim(),
        category: c.category || "Tech & Digital Skills",
        level: c.level || "Beginner",
        duration: c.duration || "6h 00m",
        description: String(c.description || "").trim(),
        learningOutcomes: String(c.learningOutcomes || "").trim(),
        syllabus: String(c.syllabus || "").trim(),
        image: c.image || "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=600&auto=format&fit=crop&q=80",
        badge: c.badge || "Certificate",
        badgeClass: c.badgeClass || "pill-tech",
        rating: typeof c.rating === "number" ? c.rating : 4.8,
        reviewsCount: typeof c.reviewsCount === "number" ? c.reviewsCount : 0,
        modulesCount: typeof c.modulesCount === "number" ? c.modulesCount : 4,
        status: "published",
        requiresApproval: Boolean(c.requiresApproval),
        tutorId: c.tutorId || null,
        tutorUid: c.tutorUid || c.tutorId || null,
        tutorName: c.tutorName || null,
        assignedTutors: Array.isArray(c.assignedTutors) ? c.assignedTutors : (c.tutorId ? [c.tutorId] : []),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Top-level course doc
      let seedBatch = db.batch();
      seedBatch.set(cRef, payload);

      // Deep seed curriculum if course exists in static definitions
      const curr = (c.curriculum || (c.modules ? c : null));
      if (curr && Array.isArray(curr.modules) && curr.modules.length > 0) {
        let opCount = 1;
        const commitBatchIfNeeded = async () => {
          opCount++;
          if (opCount >= 380) {
            await seedBatch.commit();
            seedBatch = db.batch();
            opCount = 0;
          }
        };

        for (let modIdx = 0; modIdx < curr.modules.length; modIdx++) {
          const mod = curr.modules[modIdx];
          const modId = mod.id || `mod-${modIdx + 1}-${Date.now()}`;
          const modRef = cRef.collection("modules").doc(modId);
          seedBatch.set(modRef, {
            title: mod.title || "Module",
            order: mod.order || modIdx + 1,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          await commitBatchIfNeeded();

          if (Array.isArray(mod.lessons)) {
            for (let itemIdx = 0; itemIdx < mod.lessons.length; itemIdx++) {
              const item = mod.lessons[itemIdx];
              const itemColl = item.type === "assignment" ? "assignments"
                : item.type === "test" ? "tests"
                : item.type === "reading" ? "notes"
                : "lessons";
              const itemId = item.id || `item-${modIdx + 1}-${itemIdx + 1}-${Date.now()}`;
              const itemRef = cRef.collection(itemColl).doc(itemId);
              const itemPayload = {
                title: item.title,
                duration: item.duration || "15 min",
                type: item.type || "video",
                moduleId: modId,
                order: item.order || itemIdx + 1,
                body: item.body || (item.type === "reading" ? (curr.overview?.description || "") : ""),
                instructions: item.instructions || (item.type === "assignment" ? (curr.assignment?.description || "") : ""),
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
              };
              if (item.type === "test" && (Array.isArray(item.questions) || Array.isArray(curr.quizQuestions))) {
                itemPayload.questions = item.questions || curr.quizQuestions;
              }
              seedBatch.set(itemRef, itemPayload);
              await commitBatchIfNeeded();
            }
          }
        }
        if (opCount > 0) {
          await seedBatch.commit();
        }
      } else {
        seedBatch.set(cRef.collection("modules").doc("module-1"), {
          title: "Module 1: Orientation & Foundations",
          order: 1,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        await seedBatch.commit();
      }

      await recomputeCourseAnalytics(cId).catch(() => {});
      seededCount++;
      seededIds.push(cId);
    }

    await db.collection("auditLogs").add({
      action: "Default Catalog Courses Seeded",
      detail: `Seeded ${seededCount} catalog course(s) (${skippedCount} existing skipped) by admin ${callerUid}`,
      seededCount,
      skippedCount,
      seededIds,
      adminUid: callerUid,
      badge: "pill-success",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { success: true, action: "seedCatalog", seededCount, skippedCount, seededIds };
  }

  const batch = db.batch();
  const auditRef = db.collection("auditLogs").doc();

  if (action === "create") {
    if (!courseData || !courseData.title || !courseData.title.trim()) {
      throw new HttpsError("invalid-argument", "Course title is required.");
    }
    const slug = courseData.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const resolvedId = courseId || courseData.id || `${slug}-${Date.now().toString().slice(-4)}`;
    const courseRef = db.collection("courses").doc(resolvedId);

    const assignedTutors = Array.isArray(courseData.assignedTutors)
      ? courseData.assignedTutors
      : courseData.tutorId
        ? [courseData.tutorId]
        : [];

    const payload = {
      id: resolvedId,
      title: courseData.title.trim(),
      category: courseData.category || "Tech & Digital Skills",
      level: courseData.level || "Beginner",
      duration: courseData.duration || "6h 00m",
      description: (courseData.description || "").trim(),
      learningOutcomes: (courseData.learningOutcomes || "").trim(),
      syllabus: (courseData.syllabus || "").trim(),
      image: courseData.image || "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=600&auto=format&fit=crop&q=80",
      status: courseData.status || "published",
      requiresApproval: Boolean(courseData.requiresApproval),
      tutorId: courseData.tutorId || null,
      tutorUid: courseData.tutorUid || courseData.tutorId || null,
      tutorName: courseData.tutorName || null,
      assignedTutors,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    batch.set(courseRef, payload);
    batch.set(courseRef.collection("modules").doc("module-1"), {
      title: "Module 1: Orientation & Foundations",
      order: 1,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    batch.set(auditRef, {
      action: "Course Created",
      detail: `Created course '${payload.title}' (${resolvedId}) by admin ${callerUid}`,
      courseId: resolvedId,
      adminUid: callerUid,
      badge: "pill-success",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();
    return { success: true, courseId: resolvedId, action: "create" };
  }

  if (!courseId || typeof courseId !== "string") {
    throw new HttpsError("invalid-argument", "Valid courseId is required.");
  }

  const courseRef = db.collection("courses").doc(courseId);

  if (action === "update") {
    const existingSnap = await courseRef.get();
    if (!existingSnap.exists) {
      throw new HttpsError("not-found", `Course '${courseId}' not found.`);
    }
    const existing = existingSnap.data() || {};

    const hasTutorId = courseData && Object.prototype.hasOwnProperty.call(courseData, "tutorId");
    const hasTutorName = courseData && Object.prototype.hasOwnProperty.call(courseData, "tutorName");
    const hasAssignedTutors = courseData && Array.isArray(courseData.assignedTutors);

    const nextTutorId = hasTutorId ? (courseData.tutorId || null) : (existing.tutorId ?? null);
    const nextTutorUid = courseData && Object.prototype.hasOwnProperty.call(courseData, "tutorUid")
      ? (courseData.tutorUid || null)
      : (hasTutorId ? nextTutorId : (existing.tutorUid ?? existing.tutorId ?? null));
    const nextTutorName = hasTutorName ? (courseData.tutorName || null) : (existing.tutorName ?? null);

    let nextAssignedTutors;
    if (hasAssignedTutors) {
      nextAssignedTutors = courseData.assignedTutors;
    } else if (hasTutorId) {
      const prevList = Array.isArray(existing.assignedTutors) ? existing.assignedTutors : [];
      nextAssignedTutors = nextTutorId ? Array.from(new Set([...prevList, nextTutorId])) : [];
    } else {
      nextAssignedTutors = Array.isArray(existing.assignedTutors)
        ? existing.assignedTutors
        : (existing.tutorId ? [existing.tutorId] : []);
    }

    const updates = {
      id: courseId,
      title: courseData?.title !== undefined ? String(courseData.title).trim() : (existing.title || ""),
      category: courseData?.category !== undefined ? courseData.category : (existing.category || "Tech & Digital Skills"),
      level: courseData?.level !== undefined ? courseData.level : (existing.level || "Beginner"),
      duration: courseData?.duration !== undefined ? courseData.duration : (existing.duration || "Self-paced"),
      description: courseData?.description !== undefined ? String(courseData.description).trim() : (existing.description || ""),
      learningOutcomes: courseData?.learningOutcomes !== undefined ? String(courseData.learningOutcomes).trim() : (existing.learningOutcomes ?? ""),
      syllabus: courseData?.syllabus !== undefined ? String(courseData.syllabus).trim() : (existing.syllabus ?? ""),
      status: courseData?.status !== undefined ? courseData.status : (existing.status || "published"),
      image: courseData?.image !== undefined && courseData.image !== "" ? courseData.image : (existing.image || ""),
      requiresApproval: courseData?.requiresApproval !== undefined ? Boolean(courseData.requiresApproval) : Boolean(existing.requiresApproval),
      tutorId: nextTutorId,
      tutorUid: nextTutorUid,
      tutorName: nextTutorName,
      assignedTutors: nextAssignedTutors,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    batch.set(courseRef, updates, { merge: true });
    batch.set(auditRef, {
      action: "Course Updated",
      detail: `Updated course '${updates.title || courseId}' (${courseId}) by admin ${callerUid}`,
      courseId,
      adminUid: callerUid,
      badge: "pill-tech",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();
    return { success: true, courseId, action: "update", updates };
  }

  if (action === "toggleStatus") {
    const existingSnap = await courseRef.get();
    if (!existingSnap.exists && !isCallerAdmin) {
      throw new HttpsError("not-found", `Course '${courseId}' not found.`);
    }
    const existing = existingSnap.exists ? existingSnap.data() : {};

    if (!isCallerAdmin) {
      const isAssigned =
        existing.tutorId === callerUid ||
        existing.tutorUid === callerUid ||
        existing.instructorId === callerUid ||
        (Array.isArray(existing.assignedTutors) && existing.assignedTutors.includes(callerUid));
      if (!isAssigned) {
        throw new HttpsError("permission-denied", "Access denied: Only an administrator or assigned course tutor may toggle course status.");
      }
    }

    const nextStatus = courseData?.status === "draft" ? "draft" : "published";
    const title = courseData?.title || existing?.title || courseId;
    batch.set(
      courseRef,
      {
        id: courseId,
        title,
        status: nextStatus,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    batch.set(auditRef, {
      action: "Course Status Updated",
      detail: `Course '${title}' (${courseId}) status changed to '${nextStatus}' by ${isCallerAdmin ? "admin" : "tutor"} ${callerUid}`,
      courseId,
      status: nextStatus,
      adminUid: callerUid,
      badge: nextStatus === "published" ? "pill-success" : "pill-warning",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();
    return { success: true, courseId, status: nextStatus, action: "toggleStatus" };
  }

  if (action === "delete") {
    const cleanCourseId = courseId.trim();
    if (
      !cleanCourseId ||
      cleanCourseId === "general" ||
      cleanCourseId === "platform" ||
      cleanCourseId.includes("/") ||
      cleanCourseId.includes("..")
    ) {
      throw new HttpsError("invalid-argument", "A valid, specific courseId is required for deletion.");
    }

    const courseDeletionRef = db.collection("courseDeletions").doc(cleanCourseId);
    const [existingSnap, deletionSnap] = await Promise.all([
      courseRef.get(),
      courseDeletionRef.get(),
    ]);

    const priorDeletion = deletionSnap.exists ? (deletionSnap.data() || {}) : null;

    if (!existingSnap.exists && !priorDeletion) {
      throw new HttpsError("not-found", `Course '${cleanCourseId}' does not exist.`);
    }

    if (!existingSnap.exists && priorDeletion?.deletionState === "completed") {
      return {
        success: true,
        courseId: cleanCourseId,
        deletionState: "completed",
        idempotentRetry: true,
        deletedSubDocs: priorDeletion.deletedSubDocs || 0,
        deletedResources: priorDeletion.deletedResources || 0,
        archivedEnrollmentsCount: priorDeletion.archivedEnrollmentsCount || 0,
        deletedStorageFilesCount: priorDeletion.deletedStorageFilesCount || 0,
        action: "delete",
      };
    }

    const existing = existingSnap.exists ? (existingSnap.data() || {}) : {};
    const title = courseData?.title || existing?.title || priorDeletion?.title || cleanCourseId;

    const assignedTutorIds = new Set(
      Array.isArray(priorDeletion?.assignedTutorIds) ? priorDeletion.assignedTutorIds : []
    );
    if (existing.tutorId) assignedTutorIds.add(existing.tutorId);
    if (existing.tutorUid) assignedTutorIds.add(existing.tutorUid);
    if (existing.instructorId) assignedTutorIds.add(existing.instructorId);
    if (Array.isArray(existing.assignedTutors)) {
      existing.assignedTutors.forEach((uid) => {
        if (uid) assignedTutorIds.add(uid);
      });
    }

    // Stage 1: Prevent student access immediately when deletion begins & record resumable deletion state
    await courseDeletionRef.set(
      {
        courseId: cleanCourseId,
        title,
        deletionState: "deleting",
        assignedTutorIds: Array.from(assignedTutorIds),
        startedBy: priorDeletion?.startedBy || callerUid,
        startedAt: priorDeletion?.startedAt || admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    if (existingSnap.exists) {
      await courseRef.set(
        {
          status: "deleting",
          deletionState: "deleting",
          deletionStartedBy: callerUid,
          deletionStartedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    // Stage 2: Archive active/approved/pending enrollments in bounded batches (<= 350 writes) so students
    // immediately lose active enrollment access while preserving academic history and submissions.
    const enrSnap = await db.collection("enrollments").where("courseId", "==", cleanCourseId).get();
    const enrollmentOps = [];
    enrSnap.docs.forEach((enrDoc) => {
      const enrData = enrDoc.data() || {};
      if (enrData.status !== "archived") {
        enrollmentOps.push({
          type: "update",
          ref: enrDoc.ref,
          data: {
            status: "archived",
            previousStatus: enrData.status || "active",
            courseDeleted: true,
            courseTitle: enrData.courseTitle || title,
            archivedAt: admin.firestore.FieldValue.serverTimestamp(),
            archivedBy: callerUid,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        });
      }
    });
    await commitOperationsInBoundedBatches(enrollmentOps, 350);
    const archivedEnrollmentsCount =
      (priorDeletion?.archivedEnrollmentsCount || 0) + enrollmentOps.length;

    // Stage 3: Clean up `assignedCourses` array on any tutors assigned to this course in bounded batches (<= 350)
    const tutorOps = [];
    for (const tUid of assignedTutorIds) {
      const tRef = db.collection("users").doc(tUid);
      const tSnap = await tRef.get();
      if (tSnap.exists) {
        tutorOps.push({
          type: "update",
          ref: tRef,
          data: {
            assignedCourses: admin.firestore.FieldValue.arrayRemove(cleanCourseId),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        });
      }
    }
    await commitOperationsInBoundedBatches(tutorOps, 350);

    // Stage 4: Collect explicit Storage paths from course resources and restrict strictly to authorized course prefixes
    const [courseResSnap, topResSnap] = await Promise.all([
      courseRef.collection("resources").get(),
      db.collection("resources").where("courseId", "==", cleanCourseId).get(),
    ]);

    const explicitStoragePaths = new Set();
    const skippedUnauthorizedStoragePaths = [];

    [...courseResSnap.docs, ...topResSnap.docs].forEach((docSnap) => {
      const rData = docSnap.data() || {};
      if (typeof rData.storagePath === "string" && rData.storagePath.trim()) {
        const candidatePath = rData.storagePath.trim().replace(/^\/+/, "");
        if (isAuthorizedCourseStoragePath(cleanCourseId, candidatePath)) {
          explicitStoragePaths.add(candidatePath);
        } else {
          skippedUnauthorizedStoragePaths.push(rData.storagePath.trim());
        }
      }
    });

    const storageErrors = [];
    let deletedStorageFilesCount = 0;
    const authorizedPrefixes = [`courses/${cleanCourseId}/`, `resources/${cleanCourseId}/`];

    if (admin.storage && typeof admin.storage === "function") {
      let bucket = null;
      try {
        bucket = admin.storage().bucket();
      } catch (bucketErr) {
        storageErrors.push(`Storage bucket initialization failed: ${bucketErr.message}`);
      }

      if (bucket) {
        for (const prefix of authorizedPrefixes) {
          if (!isAuthorizedCourseStoragePath(cleanCourseId, `${prefix}placeholder`)) {
            storageErrors.push(`Refused unauthorized Storage prefix '${prefix}'.`);
            continue;
          }
          if (typeof bucket.deleteFiles === "function") {
            try {
              await bucket.deleteFiles({ prefix });
              deletedStorageFilesCount += 1;
            } catch (err) {
              const code = err?.code || err?.status;
              if (code !== 404 && code !== "ENOENT" && !String(err?.message || "").includes("No such object")) {
                storageErrors.push(`Failed deleting prefix '${prefix}': ${err.message || err}`);
              }
            }
          }
        }

        if (typeof bucket.file === "function") {
          for (const storagePath of explicitStoragePaths) {
            if (!isAuthorizedCourseStoragePath(cleanCourseId, storagePath)) {
              skippedUnauthorizedStoragePaths.push(storagePath);
              continue;
            }
            try {
              await bucket.file(storagePath).delete();
              deletedStorageFilesCount += 1;
            } catch (err) {
              const code = err?.code || err?.status;
              if (code !== 404 && code !== "ENOENT" && !String(err?.message || "").includes("No such object")) {
                storageErrors.push(`Failed deleting file '${storagePath}': ${err.message || err}`);
              }
            }
          }
        }
      }
    }

    if (storageErrors.length > 0) {
      await courseDeletionRef.set(
        {
          deletionState: "failed",
          failedStage: "storage_cleanup",
          deletionErrors: storageErrors,
          skippedUnauthorizedStoragePaths,
          archivedEnrollmentsCount,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      if (existingSnap.exists) {
        await courseRef.set(
          {
            status: "deleting",
            deletionState: "failed",
            deletionStatus: "storage_cleanup_failed",
            deletionErrors: storageErrors,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
      await db.collection("auditLogs").add({
        action: "Course Deletion Failed (Storage Cleanup)",
        detail: `Storage cleanup failed while deleting course '${title}' (${cleanCourseId}): ${storageErrors.join("; ")}`,
        courseId: cleanCourseId,
        adminUid: callerUid,
        errors: storageErrors,
        badge: "pill-danger",
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      throw new HttpsError(
        "internal",
        `Course deletion aborted because Storage cleanup failed: ${storageErrors.join("; ")}`
      );
    }

    // Stage 5: Recursively discover and delete all subcollections under courses/{courseId} in bounded batches (<= 350)
    let deletedSubDocs = 0;
    let deletedResources = 0;
    try {
      deletedSubDocs = await deleteSubcollectionsRecursively(courseRef, 350);
      deletedResources = await deleteQueryInBoundedBatches(
        db.collection("resources").where("courseId", "==", cleanCourseId),
        350
      );
      await deleteQueryInBoundedBatches(
        db.collection("announcements").where("courseId", "==", cleanCourseId),
        350
      );
    } catch (subErr) {
      const errMsg = subErr?.message || String(subErr);
      await courseDeletionRef.set(
        {
          deletionState: "failed",
          failedStage: "subcollection_cleanup",
          deletionErrors: [errMsg],
          archivedEnrollmentsCount,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      if (existingSnap.exists) {
        await courseRef.set(
          {
            status: "deleting",
            deletionState: "failed",
            deletionStatus: "subcollection_cleanup_failed",
            deletionErrors: [errMsg],
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
      await db.collection("auditLogs").add({
        action: "Course Deletion Failed (Subcollection Cleanup)",
        detail: `Subcollection discovery/deletion failed while deleting course '${title}' (${cleanCourseId}): ${errMsg}`,
        courseId: cleanCourseId,
        adminUid: callerUid,
        errors: [errMsg],
        badge: "pill-danger",
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      throw new HttpsError(
        "internal",
        `Course deletion aborted because subcollection cleanup failed: ${errMsg}`
      );
    }

    // Stage 6: Delete top-level course document, verify removal, and finalize courseDeletions state + audit log
    await courseRef.delete();
    const afterCourseSnap = await courseRef.get();
    if (afterCourseSnap.exists) {
      await courseDeletionRef.set(
        {
          deletionState: "failed",
          failedStage: "verify_course_document_deletion",
          deletionErrors: ["Course document still exists after deletion."],
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      throw new HttpsError(
        "internal",
        `Verification failed: Course document '${cleanCourseId}' still exists after deletion.`
      );
    }

    const totalDeletedSubDocs = (priorDeletion?.deletedSubDocs || 0) + deletedSubDocs;
    const totalDeletedResources = (priorDeletion?.deletedResources || 0) + deletedResources;
    const totalDeletedStorageFiles =
      (priorDeletion?.deletedStorageFilesCount || 0) + deletedStorageFilesCount;

    batch.set(
      courseDeletionRef,
      {
        courseId: cleanCourseId,
        title,
        deletionState: "completed",
        failedStage: admin.firestore.FieldValue.delete(),
        deletionErrors: admin.firestore.FieldValue.delete(),
        deletedSubDocs: totalDeletedSubDocs,
        deletedResources: totalDeletedResources,
        archivedEnrollmentsCount,
        deletedStorageFilesCount: totalDeletedStorageFiles,
        skippedUnauthorizedStoragePaths,
        completedBy: callerUid,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    batch.set(auditRef, {
      action: "Course Deleted",
      detail: `Deleted course '${title}' (${cleanCourseId}) and ${totalDeletedSubDocs} subcollection item(s); archived ${archivedEnrollmentsCount} enrollment(s) by admin ${callerUid}`,
      courseId: cleanCourseId,
      deletedSubDocs: totalDeletedSubDocs,
      deletedResources: totalDeletedResources,
      archivedEnrollmentsCount,
      deletedStorageFilesCount: totalDeletedStorageFiles,
      skippedUnauthorizedStoragePaths,
      adminUid: callerUid,
      badge: "pill-danger",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();
    return {
      success: true,
      courseId: cleanCourseId,
      deletionState: "completed",
      deletedSubDocs: totalDeletedSubDocs,
      deletedResources: totalDeletedResources,
      archivedEnrollmentsCount,
      deletedStorageFilesCount: totalDeletedStorageFiles,
      skippedUnauthorizedStoragePaths,
      action: "delete",
    };
  }
});

/**
 * 13. Callable Function: adminDeleteAnnouncement
 * - Admin-only callable to delete an announcement and record a server-side audit log.
 */
exports.adminDeleteAnnouncement = onCall(async (request) => {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Access denied: Verified administrator privileges required.");
  }

  const callerUid = request.auth.uid;
  const { announcementId, title } = request.data || {};

  if (!announcementId || typeof announcementId !== "string") {
    throw new HttpsError("invalid-argument", "Valid announcementId is required.");
  }

  const batch = db.batch();
  batch.delete(db.collection("announcements").doc(announcementId));
  batch.set(db.collection("auditLogs").doc(), {
    action: "Announcement Deleted",
    detail: `Deleted announcement '${title || announcementId}' (${announcementId}) by admin ${callerUid}`,
    announcementId,
    adminUid: callerUid,
    badge: "pill-danger",
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();
  return { success: true, announcementId };
});

/**
 * 14. Callable Function: adminUpdatePlatformSettings
 * - Admin-only callable to update platform settings and record a server-side audit log.
 */
exports.adminUpdatePlatformSettings = onCall(async (request) => {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Access denied: Verified administrator privileges required.");
  }

  const callerUid = request.auth.uid;
  const { settings } = request.data || {};

  if (!settings || typeof settings !== "object") {
    throw new HttpsError("invalid-argument", "Settings object is required.");
  }

  const allowedSettings = {
    platformName: typeof settings.platformName === "string" ? settings.platformName.trim() : "Peleekings LMS",
    supportEmail: typeof settings.supportEmail === "string" ? settings.supportEmail.trim() : "support@peleekings.com",
    maintenanceMode: Boolean(settings.maintenanceMode),
    openRegistrations: Boolean(settings.openRegistrations),
    announcementBannerActive: Boolean(settings.announcementBannerActive),
    bannerMessage: typeof settings.bannerMessage === "string" ? settings.bannerMessage.trim() : "",
    allowTutorApplications: Boolean(settings.allowTutorApplications),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: callerUid,
  };

  const batch = db.batch();
  batch.set(db.collection("platformSettings").doc("general"), allowedSettings, { merge: true });
  batch.set(db.collection("auditLogs").doc(), {
    action: "Platform Settings Updated",
    detail: `Administrator ${callerUid} updated platform system configurations.`,
    adminUid: callerUid,
    badge: "pill-tech",
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();
  return { success: true };
});

/**
 * 15. Callable Function: adminLogResourceAction
 * - Server-controlled audit log recorder for resource upload and deletion operations.
 * - Admins may log platform-level and course-level resource actions.
 * - Tutors must specify a valid non-platform courseId, be explicitly assigned to that course,
 *   and for "uploaded" actions the resource document must exist.
 */
exports.adminLogResourceAction = onCall(async (request) => {
  if (!request.auth || (request.auth.token.admin !== true && request.auth.token.tutor !== true)) {
    throw new HttpsError("permission-denied", "Access denied: Verified administrator or instructor privileges required.");
  }

  const callerUid = request.auth.uid;
  const isCallerAdmin = request.auth.token.admin === true;
  const { action, resourceId, title, courseId } = request.data || {};

  if (!action || !["uploaded", "deleted"].includes(action)) {
    throw new HttpsError("invalid-argument", "Action must be 'uploaded' or 'deleted'.");
  }

  if (!isCallerAdmin) {
    if (!courseId || typeof courseId !== "string" || courseId.trim() === "" || courseId === "platform") {
      throw new HttpsError(
        "permission-denied",
        "Instructors cannot log platform-level resource actions and must specify an assigned courseId."
      );
    }

    const courseSnap = await db.collection("courses").doc(courseId).get();
    if (!courseSnap.exists) {
      throw new HttpsError("not-found", `Course '${courseId}' not found.`);
    }
    const courseData = courseSnap.data() || {};
    const isAssigned =
      courseData.tutorId === callerUid ||
      courseData.tutorUid === callerUid ||
      courseData.instructorId === callerUid ||
      (Array.isArray(courseData.assignedTutors) && courseData.assignedTutors.includes(callerUid));

    if (!isAssigned) {
      throw new HttpsError("permission-denied", "Instructors may only log resource actions for courses assigned to them.");
    }

    if (action === "uploaded") {
      if (!resourceId || typeof resourceId !== "string") {
        throw new HttpsError("invalid-argument", "Valid resourceId is required when logging an uploaded resource.");
      }
      const [topResSnap, courseResSnap] = await Promise.all([
        db.collection("resources").doc(resourceId).get(),
        db.collection("courses").doc(courseId).collection("resources").doc(resourceId).get(),
      ]);
      const existsInTop = topResSnap.exists && topResSnap.data()?.courseId === courseId;
      const existsInSub = courseResSnap.exists;
      if (!existsInTop && !existsInSub) {
        throw new HttpsError("not-found", `Uploaded resource '${resourceId}' does not exist for course '${courseId}'.`);
      }
    }
  }

  await db.collection("auditLogs").add({
    action: action === "uploaded" ? "Resource Uploaded" : "Resource Deleted",
    detail: `${action === "uploaded" ? "Uploaded" : "Deleted"} resource '${title || resourceId}' (course: ${courseId || "platform"}) by ${callerUid}`,
    resourceId: resourceId || null,
    courseId: courseId || "platform",
    adminUid: callerUid,
    badge: action === "uploaded" ? "pill-success" : "pill-danger",
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true };
});

/**
 * 16. Callable Function: sendCourseNotification
 * - Allows verified Admins or the assigned Tutor of a course to send notifications ONLY to students
 *   enrolled in that course (preventing tutors from sending arbitrary notifications to unrelated users).
 */
exports.sendCourseNotification = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const callerUid = request.auth.uid;
  const isCallerAdmin = request.auth.token.admin === true;
  const isCallerTutor = request.auth.token.tutor === true;

  if (!isCallerAdmin && !isCallerTutor) {
    throw new HttpsError("permission-denied", "Only administrators or verified instructors may send notifications.");
  }

  const { targetUid, courseId, type = "announcement", title, body } = request.data || {};

  if (!targetUid || typeof targetUid !== "string") {
    throw new HttpsError("invalid-argument", "targetUid is required.");
  }
  if (!title || typeof title !== "string" || !title.trim()) {
    throw new HttpsError("invalid-argument", "Notification title is required.");
  }
  if (!body || typeof body !== "string" || !body.trim()) {
    throw new HttpsError("invalid-argument", "Notification body is required.");
  }

  // If caller is a tutor (and not admin), strictly verify course ownership AND student enrollment
  if (!isCallerAdmin) {
    if (!courseId || typeof courseId !== "string") {
      throw new HttpsError("invalid-argument", "Instructors must specify the courseId for course notifications.");
    }

    const courseSnap = await db.collection("courses").doc(courseId).get();
    if (!courseSnap.exists) {
      throw new HttpsError("not-found", `Course '${courseId}' not found.`);
    }
    const courseData = courseSnap.data();
    const isAssigned =
      courseData.tutorId === callerUid ||
      courseData.tutorUid === callerUid ||
      courseData.instructorId === callerUid ||
      (Array.isArray(courseData.assignedTutors) && courseData.assignedTutors.includes(callerUid));

    if (!isAssigned) {
      throw new HttpsError("permission-denied", "Instructors may only notify learners in their assigned courses.");
    }

    // Verify target user has an enrollment in this course
    const enrollmentSnap = await db.collection("enrollments").doc(`${targetUid}_${courseId}`).get();
    if (!enrollmentSnap.exists || !["active", "approved"].includes(enrollmentSnap.data()?.status)) {
      throw new HttpsError("permission-denied", "Target user is not actively enrolled in this course.");
    }
  }

  const notifRef = await db.collection("users").doc(targetUid).collection("notifications").add({
    type: type || "announcement",
    title: title.trim(),
    body: body.trim(),
    courseId: courseId || null,
    senderUid: callerUid,
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true, notificationId: notifRef.id };
});

/**
 * 17. Callable Function: requestCourseEnrollment
 * - Server-authoritative hybrid enrollment workflow:
 *   1. Authenticates requesting user and checks account is not suspended.
 *   2. Fetches actual course document from Firestore (rejects missing or unpublished courses).
 *   3. Uses a Firestore transaction on deterministic ID enrollments/${uid}_${courseId} to prevent duplicate enrollments.
 *   4. Sets status = 'pending' if experienceType === 'hands-on' or courseData.requiresApproval === true;
 *      sets status = 'active' for eligible published online courses that do not require approval.
 *   5. Initializes progressPercent: 0, completedItemIds: [], totalLessons from curriculum subcollections.
 *   6. Records server-side audit log and user notification, and triggers analytics recomputation.
 */
exports.requestCourseEnrollment = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "You must be signed in to enroll in a course.");
  }

  const uid = request.auth.uid;
  const { courseId, experienceType = "online", totalLessons } = request.data || {};

  if (!courseId || typeof courseId !== "string" || !courseId.trim() || courseId === "general" || courseId === "platform") {
    throw new HttpsError("invalid-argument", "A valid courseId is required.");
  }

  const normalizedCourseId = courseId.trim();
  const normalizedExp = experienceType === "hands-on" ? "hands-on" : "online";

  // Verify user account eligibility
  const userSnap = await db.collection("users").doc(uid).get();
  if (userSnap.exists) {
    const userData = userSnap.data() || {};
    if (userData.status === "suspended" || userData.disabled === true) {
      throw new HttpsError("permission-denied", "Suspended accounts cannot enroll in courses.");
    }
  }

  // Verify course exists and is published
  const courseRef = db.collection("courses").doc(normalizedCourseId);
  const courseSnap = await courseRef.get();
  if (!courseSnap.exists) {
    throw new HttpsError("not-found", `Course '${normalizedCourseId}' does not exist.`);
  }

  const courseData = courseSnap.data() || {};
  const isAdmin = request.auth.token.admin === true;
  const isAssignedTutor =
    request.auth.token.tutor === true &&
    (courseData.tutorId === uid ||
      courseData.tutorUid === uid ||
      courseData.instructorId === uid ||
      (Array.isArray(courseData.assignedTutors) && courseData.assignedTutors.includes(uid)));

  if (courseData.status !== "published" && !isAdmin && !isAssignedTutor) {
    throw new HttpsError("failed-precondition", "Cannot enroll in an unpublished or draft course.");
  }

  const requiresApproval = normalizedExp === "hands-on" || courseData.requiresApproval === true;
  const targetStatus = requiresApproval ? "pending" : "active";

  const curriculumCount = await countCourseCurriculumItems(normalizedCourseId);
  const resolvedTotalLessons =
    curriculumCount > 0
      ? curriculumCount
      : typeof totalLessons === "number" && totalLessons > 0
        ? totalLessons
        : typeof courseData.totalLessons === "number" && courseData.totalLessons > 0
          ? courseData.totalLessons
          : 0;

  const enrollmentId = `${uid}_${normalizedCourseId}`;
  const enrollmentRef = db.collection("enrollments").doc(enrollmentId);

  const txResult = await db.runTransaction(async (tx) => {
    const existingSnap = await tx.get(enrollmentRef);
    if (existingSnap.exists) {
      const existingData = existingSnap.data() || {};
      return {
        alreadyExists: true,
        enrollment: {
          id: enrollmentId,
          ...existingData,
        },
      };
    }

    const newEnrollment = {
      uid,
      courseId: normalizedCourseId,
      courseTitle: courseData.title || normalizedCourseId,
      experienceType: normalizedExp,
      status: targetStatus,
      completedItemIds: [],
      progressPercent: 0,
      totalLessons: resolvedTotalLessons,
      enrolledAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (targetStatus === "active") {
      newEnrollment.approvedAt = admin.firestore.FieldValue.serverTimestamp();
      newEnrollment.approvedBy = "system_auto_online";
    }

    tx.set(enrollmentRef, newEnrollment);

    const notifRef = db.collection("users").doc(uid).collection("notifications").doc();
    tx.set(notifRef, {
      type: "enrollment",
      title: targetStatus === "active" ? "Course Enrollment Active! 🎓" : "Enrollment Request Received ⏳",
      body:
        targetStatus === "active"
          ? `You are now enrolled in '${courseData.title || normalizedCourseId}'. Start learning anytime!`
          : `Your ${normalizedExp} enrollment request for '${courseData.title || normalizedCourseId}' is pending approval.`,
      courseId: normalizedCourseId,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const auditRef = db.collection("auditLogs").doc();
    tx.set(auditRef, {
      action: targetStatus === "active" ? "Course Enrollment Activated" : "Course Enrollment Requested",
      detail: `Learner ${uid} enrolled in '${courseData.title || normalizedCourseId}' (${normalizedExp}) with status '${targetStatus}'`,
      enrollmentId,
      uid,
      courseId: normalizedCourseId,
      experienceType: normalizedExp,
      status: targetStatus,
      badge: targetStatus === "active" ? "pill-success" : "pill-warning",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      alreadyExists: false,
      enrollment: {
        id: enrollmentId,
        uid,
        courseId: normalizedCourseId,
        courseTitle: courseData.title || normalizedCourseId,
        experienceType: normalizedExp,
        status: targetStatus,
        completedItemIds: [],
        progressPercent: 0,
        totalLessons: resolvedTotalLessons,
      },
    };
  });

  if (!txResult.alreadyExists && targetStatus === "active") {
    await recomputeCourseAnalytics(normalizedCourseId).catch(() => {});
  }

  return {
    success: true,
    alreadyExists: txResult.alreadyExists,
    enrollmentId,
    status: txResult.enrollment.status,
    enrollment: txResult.enrollment,
  };
});

/**
 * 18. Firestore Triggers: Stage 8 Course Analytics Recomputation
 * - Triggered when documents in enrollments, testSubmissions, or assignmentSubmissions are created, updated, or deleted.
 * - Recomputes courses/{courseId}/analytics/summary idempotently.
 */
exports.onEnrollmentOrSubmissionWrite = onDocumentWritten("{collectionId}/{docId}", async (event) => {
  const { collectionId } = event.params || {};
  if (!["enrollments", "testSubmissions", "assignmentSubmissions"].includes(collectionId)) {
    return null;
  }

  const beforeData = event.data?.before?.exists ? event.data.before.data() : null;
  const afterData = event.data?.after?.exists ? event.data.after.data() : null;
  const courseIds = new Set();

  if (beforeData?.courseId) courseIds.add(beforeData.courseId);
  if (afterData?.courseId) courseIds.add(afterData.courseId);

  for (const cid of courseIds) {
    await recomputeCourseAnalytics(cid);
  }
  return null;
});

exports.recomputeCourseAnalytics = recomputeCourseAnalytics;

