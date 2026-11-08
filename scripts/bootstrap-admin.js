import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import admin from "firebase-admin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

// 1. Strict Verification of Project ID from .firebaserc
function getTargetProjectId() {
  const firebasercPath = path.join(rootDir, ".firebaserc");
  if (!fs.existsSync(firebasercPath)) {
    throw new Error(".firebaserc file not found at repository root.");
  }
  const firebaserc = JSON.parse(fs.readFileSync(firebasercPath, "utf-8"));
  const projectId = firebaserc?.projects?.default;
  if (!projectId || projectId !== "pelee-kings") {
    throw new Error(`[SECURITY ALERT] Invalid or unauthorized project ID: '${projectId}'. Expected 'pelee-kings'.`);
  }
  return projectId;
}

// Interactive prompt utility
function promptUser(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const targetEmail = args[0]?.trim();
  const isDryRun = args.includes("--dry-run") || args.includes("--inspect-only");
  const isRevoke = args.includes("--revoke");

  if (!targetEmail || targetEmail.startsWith("-")) {
    console.error("\n[ERROR] Missing required target administrator email.");
    console.error("Usage: npm run bootstrap:admin -- <ADMIN_EMAIL> [--dry-run] [--revoke]\n");
    process.exit(1);
  }

  // Basic email pattern check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
    console.error(`\n[ERROR] Invalid email format: '${targetEmail}'\n`);
    process.exit(1);
  }

  const projectId = getTargetProjectId();
  console.log("================================================================================");
  console.log("             PELEEKINGS LMS — SECURE ADMINISTRATOR BOOTSTRAP TOOL               ");
  console.log("================================================================================");
  console.log(`[Config] Target Firebase Project: ${projectId}`);
  console.log(`[Config] Target Email:            ${targetEmail}`);
  console.log(`[Config] Operation Mode:          ${isRevoke ? "REVOKE (Demote to Student)" : "BOOTSTRAP (Grant Admin)"}`);
  console.log(`[Config] Dry Run / Inspection:    ${isDryRun ? "YES (Read-only)" : "NO (Live writes)"}`);

  // 2. Initialize Firebase Admin using Application Default Credentials
  try {
    admin.initializeApp({
      projectId,
      credential: admin.credential.applicationDefault(),
    });
  } catch (initErr) {
    console.error("\n[FATAL ERROR] Failed to initialize Firebase Admin SDK with Application Default Credentials.");
    console.error("Run 'gcloud auth application-default login' and 'gcloud auth application-default set-quota-project pelee-kings'.");
    console.error(`Details: ${initErr.message}\n`);
    process.exit(1);
  }

  const auth = admin.auth();
  const db = admin.firestore();

  // 3. Confirm target account exists in Firebase Auth (DO NOT create accounts)
  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(targetEmail);
  } catch (err) {
    if (err.code === "auth/user-not-found") {
      console.error(`\n[SECURITY REJECTED] Account '${targetEmail}' does not exist in Firebase Authentication for project '${projectId}'.`);
      console.error("Security Policy: This tool will NOT create accounts. The user must register first via approved channels.\n");
      process.exit(1);
    }
    console.error(`\n[ERROR] Failed to query user from Firebase Authentication: ${err.message}\n`);
    process.exit(1);
  }

  // 4. Check Disabled Status
  const isAccountDisabled = userRecord.disabled === true;

  // 5. Query Firestore profile document
  const userDocRef = db.collection("users").doc(userRecord.uid);
  let userDocSnap = null;
  let firestoreError = null;

  try {
    userDocSnap = await userDocRef.get();
  } catch (fsErr) {
    firestoreError = fsErr;
  }

  const currentClaims = userRecord.customClaims || {};
  const currentDocData = userDocSnap?.exists ? userDocSnap.data() : null;

  // 6. Display Pre-flight Details
  console.log("\n----------------------------- Pre-flight Information -----------------------------");
  console.log(`Target Project:       ${projectId} (VERIFIED)`);
  console.log(`User Email:           ${userRecord.email}`);
  console.log(`User UID:             ${userRecord.uid}`);
  console.log(`Account Status:       ${isAccountDisabled ? "DISABLED / LOCKED" : "ACTIVE"}`);
  console.log(`Email Verified:       ${userRecord.emailVerified}`);
  console.log(`Current Custom Claims:${JSON.stringify(currentClaims, null, 2)}`);
  if (firestoreError) {
    console.log(`Firestore Status:     ERROR: ${firestoreError.message}`);
  } else {
    console.log(`Firestore Document:   ${userDocSnap?.exists ? "EXISTS" : "DOES NOT EXIST"}`);
    if (userDocSnap?.exists) {
      console.log(`Firestore Role:       ${currentDocData.role || "(none)"}`);
    }
  }
  console.log("----------------------------------------------------------------------------------\n");

  // Security Check: Block disabled accounts
  if (isAccountDisabled) {
    console.error("[SECURITY REJECTED] The target account is disabled in Firebase Authentication.");
    console.error("Cannot bootstrap or grant privileges to a disabled or locked account.\n");
    process.exit(1);
  }

  // Security Check: Ensure Firestore database is reachable
  if (firestoreError) {
    console.error("[PREREQUISITE FAILED] Cloud Firestore database is not accessible.");
    console.error("Firebase Admin SDK cannot connect to Firestore. Ensure the database is created in Firebase Console.");
    console.error(`Details: ${firestoreError.message}\n`);
    process.exit(1);
  }

  // Repeat-execution & State Checks
  const alreadyAdminClaim = currentClaims.admin === true;
  const alreadyAdminRole = currentDocData?.role === "admin";

  if (!isRevoke && alreadyAdminClaim && alreadyAdminRole) {
    console.log("[NOTICE] User already holds 'admin: true' Custom Claim and Firestore 'role: admin'.");
  } else if (isRevoke && !alreadyAdminClaim && currentDocData?.role !== "admin") {
    console.log("[NOTICE] User does not currently hold administrator privileges.");
  }

  if (isDryRun) {
    console.log("[DRY-RUN] Pre-flight inspection complete. No changes were applied.\n");
    process.exit(0);
  }

  // 7. Interactive Confirmation Requirement
  const actionLabel = isRevoke ? "REVOKE ADMINISTRATOR PRIVILEGES from" : "GRANT ADMINISTRATOR PRIVILEGES to";
  console.log(`[ACTION REQUIRED] You are about to ${actionLabel}:`);
  console.log(`  Account:           ${userRecord.email}`);
  console.log(`  UID:               ${userRecord.uid}`);
  console.log(`  Target Project:    ${projectId}`);
  if (isRevoke) {
    console.log(`  Claims to apply:   { admin: false, tutor: false }`);
    console.log(`  Firestore Role:    "student" (No deprecated submittedRole)`);
  } else {
    console.log(`  Claims to apply:   { admin: true, tutor: false }`);
    console.log(`  Firestore Role:    "admin" (No deprecated submittedRole)`);
  }
  console.log(`  Session action:    Revoke all active refresh tokens immediately.\n`);

  const confirmation = await promptUser("Type 'CONFIRM' to proceed (or anything else to abort): ");

  if (confirmation !== "CONFIRM") {
    console.log("\n[ABORTED] Confirmation response did not match 'CONFIRM'. No changes made.\n");
    process.exit(0);
  }

  // 8. Safe Failure Handling & Atomic Role Assignment
  const previousClaims = { ...currentClaims };
  const targetRole = isRevoke ? "student" : "admin";
  
  // Preserve all unrelated custom claims while explicitly managing admin and tutor claims
  const targetClaims = isRevoke
    ? (() => {
        const remaining = { ...currentClaims };
        delete remaining.admin;
        return { ...remaining, tutor: false };
      })()
    : { ...currentClaims, admin: true, tutor: false };

  console.log(`\n[Step 1/4] Applying Custom Claims in Firebase Authentication...`);
  try {
    await auth.setCustomUserClaims(userRecord.uid, targetClaims);
    console.log(` -> Custom claims set: ${JSON.stringify(targetClaims)}`);
  } catch (claimErr) {
    console.error(`\n[FAILURE] Failed to set Firebase Custom Claims: ${claimErr.message}`);
    process.exit(1);
  }

  console.log(`[Step 2/4] Updating Firestore profile document (role: '${targetRole}')...`);
  try {
    const profilePayload = {
      uid: userRecord.uid,
      email: userRecord.email,
      role: targetRole,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(userDocSnap?.exists ? {} : { createdAt: admin.firestore.FieldValue.serverTimestamp(), status: "active" }),
    };

    // Explicitly do NOT write submittedRole (and remove if exists)
    if (userDocSnap?.exists && userDocSnap.data().submittedRole) {
      profilePayload.submittedRole = admin.firestore.FieldValue.delete();
    }

    await userDocRef.set(profilePayload, { merge: true });
    console.log(` -> Firestore user profile synchronized with role: '${targetRole}' (submittedRole omitted/cleaned).`);
  } catch (fsWriteErr) {
    console.error(`\n[CRITICAL FAILURE] Firestore update failed: ${fsWriteErr.message}`);
    console.error("Initiating safe rollback of Firebase Custom Claims...");
    try {
      await auth.setCustomUserClaims(userRecord.uid, previousClaims);
      console.error(" -> [ROLLBACK SUCCESS] Custom Claims restored to previous state.");
    } catch (rbErr) {
      console.error(` -> [CRITICAL ROLLBACK FAILURE] Could not rollback Custom Claims: ${rbErr.message}`);
    }
    console.error("\nBootstrap failed. Firestore profile could not be created/updated.");
    process.exit(1);
  }

  console.log(`[Step 3/4] Revoking active refresh tokens...`);
  try {
    await auth.revokeRefreshTokens(userRecord.uid);
    console.log(` -> Active refresh tokens revoked. Active sessions must fetch new ID tokens.`);
  } catch (tokenErr) {
    console.warn(` -> [Warning] Token revocation notice: ${tokenErr.message}`);
  }

  console.log(`[Step 4/4] Recording Audit Log entry...`);
  try {
    await db.collection("auditLogs").add({
      action: isRevoke ? "Admin Revoked" : "Admin Bootstrapped",
      detail: `Administrator privilege ${isRevoke ? "revoked from" : "bootstrapped for"} ${userRecord.email} (${userRecord.uid})`,
      uid: userRecord.uid,
      email: userRecord.email,
      role: targetRole,
      badge: isRevoke ? "pill-warning" : "pill-tech",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(` -> Audit log entry recorded.`);
  } catch (auditErr) {
    console.warn(` -> [Notice] Audit log write skipped: ${auditErr.message}`);
  }

  // 9. Strict Post-Execution Verification
  console.log("\n======================== Post-Execution Verification ========================");
  const reloadedUser = await auth.getUser(userRecord.uid);
  const reloadedDoc = await userDocRef.get();

  const verifiedAdminClaim = isRevoke
    ? reloadedUser.customClaims?.admin !== true
    : reloadedUser.customClaims?.admin === true;
  const verifiedTutorClaim = reloadedUser.customClaims?.tutor === false || !reloadedUser.customClaims?.tutor;
  const verifiedDocRole = reloadedDoc.data()?.role === targetRole;
  const verifiedNoSubmittedRole = !reloadedDoc.data()?.submittedRole;

  console.log(`Verification: Custom Claim (admin: ${!isRevoke}) -> ${verifiedAdminClaim ? "VERIFIED SUCCESS" : "FAILED"}`);
  console.log(`Verification: Custom Claim (tutor: false)   -> ${verifiedTutorClaim ? "VERIFIED SUCCESS" : "FAILED"}`);
  console.log(`Verification: Firestore Role (role: ${targetRole}) -> ${verifiedDocRole ? "VERIFIED SUCCESS" : "FAILED"}`);
  console.log(`Verification: No submittedRole written     -> ${verifiedNoSubmittedRole ? "VERIFIED CLEAN" : "FLAGGED"}`);

  const allVerified = verifiedAdminClaim && verifiedTutorClaim && verifiedDocRole && verifiedNoSubmittedRole;

  if (allVerified) {
    console.log(`\n[SUCCESS] Administrator ${isRevoke ? "revocation" : "bootstrap"} completed and verified successfully.`);
    console.log("Both Firebase Authentication Custom Claims and Firestore profile are in complete alignment.");
    console.log("The user must sign in again to receive their new verified ID token.\n");
  } else {
    console.error(`\n[FATAL ERROR] Verification failed: All conditions (admin claim, tutor claim, Firestore role, and absence of deprecated fields) must pass.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n[FATAL ERROR]", err);
  process.exit(1);
});
