import { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  GoogleAuthProvider,
  signInWithPopup,
  sendPasswordResetEmail,
  confirmPasswordReset,
  verifyPasswordResetCode,
  updatePassword,
} from "firebase/auth";
import { doc, setDoc, getDoc, serverTimestamp } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { auth, db, functions } from "../firebase";
import { validatePasswordOrThrow } from "../utils/passwordPolicy";

const AuthContext = createContext(null);

function withTimeout(promise, ms = 20000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => {
        const err = new Error("Slow connection, please try again");
        err.code = "OPERATION_TIMEOUT";
        reject(err);
      }, ms)
    ),
  ]);
}

// Format Firebase auth error codes into clear, user-friendly messages
function formatAuthError(err) {
  if (!err) return "An unknown authentication error occurred.";
  if (err.code === "OPERATION_TIMEOUT" || err.message === "Slow connection, please try again") {
    return "Slow connection, please try again";
  }
  const code = err.code || "";
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Invalid email or password. Please verify your credentials.";
    case "auth/email-already-in-use":
      return "An account with this email address already exists. Please sign in.";
    case "auth/weak-password":
    case "auth/password-does-not-meet-requirements":
      return "Password must be at least 8 characters long and include at least one number (0–9).";
    case "auth/expired-action-code":
    case "auth/invalid-action-code":
      return "This password reset link is invalid or has expired. Please request a new reset link.";
    case "auth/requires-recent-login":
      return "For your security, please sign out and sign back in before changing your password.";
    case "auth/invalid-email":
      return "Please enter a valid email address.";
    case "auth/user-disabled":
      return "This account has been disabled. Please contact support.";
    case "auth/network-request-failed":
      return "Network connection issue. Please check your internet connection.";
    case "auth/too-many-requests":
      return "Too many unsuccessful attempts. Please try again later or reset your password.";
    case "auth/popup-closed-by-user":
      return "Google sign-in was cancelled before completion.";
    default:
      return err.message || "Authentication failed. Please try again.";
  }
}

/**
 * Unified privilege-resolution policy from Firebase Auth Custom Claims.
 * - Requires verified boolean custom claims (`admin: true` or `tutor: true`).
 * - Contradictory claims (e.g., both admin & tutor true, or role string mismatching boolean claim)
 *   strictly FAIL CLOSED to unprivileged "student".
 */
export function resolveClaimsPrivilege(rawClaims) {
  if (!rawClaims || typeof rawClaims !== "object") {
    return { isAdmin: false, isTutor: false, role: "student", hasContradiction: false };
  }

  const adminClaim = rawClaims.admin;
  const tutorClaim = rawClaims.tutor;
  const roleClaim = rawClaims.role;

  const invalidBooleanType =
    (adminClaim !== undefined && typeof adminClaim !== "boolean") ||
    (tutorClaim !== undefined && typeof tutorClaim !== "boolean");

  const bothPrivilegedTrue = adminClaim === true && tutorClaim === true;
  const adminRoleMismatch =
    (adminClaim === true && roleClaim !== undefined && roleClaim !== "admin") ||
    (roleClaim === "admin" && adminClaim !== true);
  const tutorRoleMismatch =
    (tutorClaim === true && roleClaim !== undefined && roleClaim !== "tutor") ||
    (roleClaim === "tutor" && tutorClaim !== true);

  if (invalidBooleanType || bothPrivilegedTrue || adminRoleMismatch || tutorRoleMismatch) {
    console.warn("Security: Contradictory or malformed custom claims detected; failing closed to student.");
    return { isAdmin: false, isTutor: false, role: "student", hasContradiction: true };
  }

  const verifiedAdmin = adminClaim === true;
  const verifiedTutor = tutorClaim === true || verifiedAdmin;
  const resolvedRole = verifiedAdmin ? "admin" : verifiedTutor ? "tutor" : "student";

  return {
    isAdmin: verifiedAdmin,
    isTutor: verifiedTutor,
    role: resolvedRole,
    hasContradiction: false,
  };
}

export async function allocateRegistrationCode(_uid, metadata = {}) {
  const allocateFn = httpsCallable(functions, "allocateRegistrationCode");
  const res = await withTimeout(
    allocateFn({
      email: metadata.email || "",
      fullName: metadata.fullName || metadata.displayName || "",
      displayName: metadata.displayName || metadata.fullName || "",
      surname: metadata.surname || "",
      firstName: metadata.firstName || "",
      studentType: metadata.studentType || "non_corper",
      nyscStateCode: metadata.nyscStateCode || null,
      phoneNumber: metadata.phoneNumber || "",
    }),
    20000
  );
  const regNumber = res?.data?.regNumber || null;
  if (!regNumber) {
    throw new Error("Registration code was not returned by server.");
  }
  return regNumber;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [claims, setClaims] = useState({});
  const [isAdmin, setIsAdmin] = useState(false);
  const [isTutor, setIsTutor] = useState(false);
  const [role, setRole] = useState("student");
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(null);
  const signupInFlightRef = useRef(false);
  const regCodeAttemptedUidRef = useRef(null);

  /**
   * Refreshes the ID token and custom claims from Firebase Authentication.
   * Forces a fresh token from Google servers.
   * If refresh fails, FAILS CLOSED immediately to prevent retaining stale privileges.
   */
  const refreshClaims = useCallback(async () => {
    if (!auth.currentUser) {
      setClaims({});
      setIsAdmin(false);
      setIsTutor(false);
      setRole("student");
      setAuthError(null);
      return {};
    }
    try {
      const tokenResult = await withTimeout(auth.currentUser.getIdTokenResult(true), 20000);
      const userClaims = tokenResult.claims || {};
      const { isAdmin: verifiedAdmin, isTutor: verifiedTutor, role: resolvedRole } =
        resolveClaimsPrivilege(userClaims);

      setClaims(userClaims);
      setIsAdmin(verifiedAdmin);
      setIsTutor(verifiedTutor);
      setRole(resolvedRole);
      setAuthError(null);

      return { claims: userClaims, role: resolvedRole, isAdmin: verifiedAdmin, isTutor: verifiedTutor };
    } catch (err) {
      console.error("Critical: Failed to refresh token claims. Failing closed to protect privileged routes:", err);
      // FAIL CLOSED: Immediately strip elevated states to prevent authorization retention
      setClaims({});
      setIsAdmin(false);
      setIsTutor(false);
      setRole("student");
      setAuthError("Failed to verify security privileges. Please check your network or re-authenticate.");
      throw err;
    }
  }, []);

  /**
   * Synchronizes non-privileged user profile from Firestore.
   * Never trusts Firestore role fields for privileged authorization.
   */
  const syncProfile = useCallback(async (user, verifiedRole) => {
    if (!user) {
      setUserProfile(null);
      return null;
    }

    const fallbackProfile = {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName || user.email?.split("@")[0] || "User",
      fullName: user.displayName || user.email?.split("@")[0] || "User",
      role: verifiedRole,
      studentType: "non_corper",
      status: "active",
      needsRegCode: true,
    };

    try {
      const docSnap = await withTimeout(getDoc(doc(db, "users", user.uid)), 20000);
      if (docSnap.exists()) {
        const data = docSnap.data();
        const profile = {
          ...data,
          uid: user.uid,
          email: user.email,
          displayName: data.displayName || user.displayName || user.email?.split("@")[0] || "User",
          fullName: data.fullName || data.displayName || user.displayName || user.email?.split("@")[0] || "User",
          role: verifiedRole, // Verified role from Custom Claims overrides any document role
          needsRegCode: !data.regNumber,
        };
        setUserProfile(profile);
        return { ...profile, _firestoreExists: true };
      } else {
        setUserProfile(fallbackProfile);
        return { ...fallbackProfile, _firestoreExists: false };
      }
    } catch (err) {
      console.warn("Firestore profile sync notice:", err);
      setUserProfile((prev) => prev || fallbackProfile);
      return { ...fallbackProfile, _firestoreExists: false };
    }
  }, []);

  /**
   * Main authentication state listener.
   * Strictly verifies authentication and Custom Claims before resolving loading.
   * Fails closed if token retrieval fails, and guarantees loading resolves promptly.
   */
  useEffect(() => {
    let isMounted = true;
    const safetyTimer = setTimeout(() => {
      if (isMounted) {
        setLoading(false);
      }
    }, 20000);

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!isMounted) return;
      setAuthError(null);
      if (user) {
        try {
          // Fetch verified claims directly from Firebase Authentication token
          const tokenResult = await withTimeout(user.getIdTokenResult(), 20000);
          const userClaims = tokenResult.claims || {};
          const { isAdmin: verifiedAdmin, isTutor: verifiedTutor, role: resolvedRole } =
            resolveClaimsPrivilege(userClaims);

          if (!isMounted) return;
          setCurrentUser(user);
          setClaims(userClaims);
          setIsAdmin(verifiedAdmin);
          setIsTutor(verifiedTutor);
          setRole(resolvedRole);
          setUserProfile((prev) =>
            prev && prev.uid === user.uid
              ? { ...prev, role: resolvedRole }
              : {
                  uid: user.uid,
                  email: user.email,
                  displayName: user.displayName || user.email?.split("@")[0] || "User",
                  fullName: user.displayName || user.email?.split("@")[0] || "User",
                  role: resolvedRole,
                  studentType: "non_corper",
                  status: "active",
                }
          );
          setLoading(false);
          clearTimeout(safetyTimer);

          const synced = await syncProfile(user, resolvedRole);
          if (
            synced &&
            synced._firestoreExists &&
            !synced.regNumber &&
            !signupInFlightRef.current &&
            regCodeAttemptedUidRef.current !== user.uid
          ) {
            regCodeAttemptedUidRef.current = user.uid;
            allocateRegistrationCode(user.uid, {
              email: synced.email || user.email || "",
              fullName: synced.fullName || user.displayName || "",
              displayName: synced.displayName || user.displayName || "",
              surname: synced.surname || "",
              firstName: synced.firstName || "",
              studentType: synced.studentType || "non_corper",
              nyscStateCode: synced.nyscStateCode || null,
              phoneNumber: synced.phoneNumber || "",
            })
              .then((regNumber) => {
                if (isMounted && regNumber) {
                  setUserProfile((prev) =>
                    prev && prev.uid === user.uid
                      ? { ...prev, regNumber, needsRegCode: false }
                      : prev
                  );
                }
              })
              .catch((allocErr) => {
                console.error("Background registration code allocation failed on sign-in:", allocErr);
              });
          }
        } catch (err) {
          console.error("Auth state claim verification failure, failing closed:", err);
          if (!isMounted) return;
          // Fail closed
          setCurrentUser(user);
          setClaims({});
          setIsAdmin(false);
          setIsTutor(false);
          setRole("student");
          setAuthError(
            err?.code === "OPERATION_TIMEOUT"
              ? "Slow connection, please try again"
              : "Failed to verify authorization claims."
          );
          setLoading(false);
          clearTimeout(safetyTimer);
          await syncProfile(user, "student");
        }
      } else {
        regCodeAttemptedUidRef.current = null;
        setCurrentUser(null);
        setUserProfile(null);
        setClaims({});
        setIsAdmin(false);
        setIsTutor(false);
        setRole("student");
        setLoading(false);
        clearTimeout(safetyTimer);
      }
    });

    return () => {
      isMounted = false;
      clearTimeout(safetyTimer);
      unsubscribe();
    };
  }, [syncProfile]);

  /**
   * signup:
   * Standard Firebase Authentication registration.
   * Enforces strict password policy (8+ chars, >= 1 digit) before creating account.
   * Uses a 20s timeout safety net, surfaces profile write or timeout errors visibly,
   * and sets `needsRegCode: true` if registration code allocation fails so it can be retried.
   */
  async function signup(email, password, arg3, arg4) {
    if (signupInFlightRef.current) {
      throw new Error("Registration is already in progress. Please wait.");
    }

    let displayName = "";
    let customProfile = {};
    if (typeof arg3 === "string") {
      displayName = arg3;
      customProfile = arg4 || {};
    } else if (typeof arg3 === "object" && arg3 !== null) {
      customProfile = arg3;
      displayName = customProfile.fullName || customProfile.displayName || "";
    }

    const cleanEmail = (email || "").trim().toLowerCase();
    const cleanName = (displayName || customProfile.fullName || "").trim();

    if (!cleanEmail) throw new Error("Please provide a valid email address.");
    validatePasswordOrThrow(password);

    signupInFlightRef.current = true;
    try {
      let userCredential;
      try {
        userCredential = await withTimeout(
          createUserWithEmailAndPassword(auth, cleanEmail, password),
          20000
        );
      } catch (authErr) {
        throw new Error(formatAuthError(authErr));
      }

      const user = userCredential.user;

      // Write initial user profile with ONLY permitted registration fields.
      // Crucially: 'role' is omitted so server-side logic assigns the authoritative role.
      const isNonCorper = customProfile.studentType === "non_corper";
      const surnameClean = (customProfile.surname || "").trim();
      const firstNameClean = (customProfile.firstName || "").trim();
      const initialData = {
        uid: user.uid,
        email: cleanEmail,
        displayName: cleanName || cleanEmail.split("@")[0],
        fullName: cleanName || cleanEmail.split("@")[0],
        surname: surnameClean || null,
        firstName: firstNameClean || null,
        studentType: customProfile.studentType || "non_corper",
        nyscStateCode: isNonCorper ? null : (customProfile.nyscStateCode || null),
        phoneNumber: customProfile.phoneNumber || "",
        createdAt: serverTimestamp(),
        status: "active",
      };

      const updateAuthProfilePromise = cleanName
        ? updateProfile(user, { displayName: cleanName }).catch((e) => {
            console.warn("Could not set display name in Firebase Auth:", e);
          })
        : Promise.resolve();

      // setDoc profile write failure or timeout MUST throw a user-visible error
      const writeFirestoreProfilePromise = withTimeout(
        setDoc(doc(db, "users", user.uid), initialData, { merge: true }),
        20000
      ).catch((firestoreErr) => {
        if (
          firestoreErr?.code === "OPERATION_TIMEOUT" ||
          firestoreErr?.message === "Slow connection, please try again"
        ) {
          throw new Error("Slow connection, please try again");
        }
        throw new Error(
          firestoreErr?.message || "Failed to save your user profile. Please try again."
        );
      });

      const tokenResultPromise = withTimeout(user.getIdTokenResult(false), 20000).catch((tokErr) => {
        if (
          tokErr?.code === "OPERATION_TIMEOUT" ||
          tokErr?.message === "Slow connection, please try again"
        ) {
          throw new Error("Slow connection, please try again");
        }
        throw new Error(tokErr?.message || "Failed to verify authentication token. Please try again.");
      });

      const allocateRegCodePromise = allocateRegistrationCode(user.uid, {
        email: cleanEmail,
        fullName: initialData.fullName,
        displayName: initialData.displayName,
        surname: surnameClean,
        firstName: firstNameClean,
        studentType: initialData.studentType,
        nyscStateCode: initialData.nyscStateCode,
        phoneNumber: initialData.phoneNumber,
      }).catch((allocErr) => {
        console.error("Registration code allocation failed during signup; flagging needsRegCode:", allocErr);
        return null;
      });

      const [, , tokenResult, allocatedRegNumber] = await Promise.all([
        updateAuthProfilePromise,
        writeFirestoreProfilePromise,
        tokenResultPromise,
        allocateRegCodePromise,
      ]);

      const userClaims = tokenResult?.claims || {};
      const { isAdmin: verifiedAdmin, isTutor: verifiedTutor, role: resolvedRole } =
        resolveClaimsPrivilege(userClaims);

      const resolvedProfile = {
        ...initialData,
        ...(allocatedRegNumber
          ? { regNumber: allocatedRegNumber, needsRegCode: false }
          : { needsRegCode: true }),
        role: resolvedRole,
      };

      setCurrentUser(user);
      setClaims(userClaims);
      setIsAdmin(verifiedAdmin);
      setIsTutor(verifiedTutor);
      setRole(resolvedRole);
      setUserProfile(resolvedProfile);

      return { user, role: resolvedRole, profile: resolvedProfile };
    } finally {
      signupInFlightRef.current = false;
    }
  }

  /**
   * login:
   * Standard Firebase Authentication sign-in.
   * Role is verified directly from Custom Claims.
   */
  async function login(email, password) {
    const cleanEmail = (email || "").trim().toLowerCase();
    if (!cleanEmail) throw new Error("Please enter your email address.");
    if (!password) throw new Error("Please enter your password.");

    let userCredential;
    try {
      userCredential = await withTimeout(
        signInWithEmailAndPassword(auth, cleanEmail, password),
        20000
      );
    } catch (authErr) {
      throw new Error(formatAuthError(authErr));
    }

    const user = userCredential.user;

    // Force refresh ID token to get latest Custom Claims
    let tokenResult;
    try {
      tokenResult = await withTimeout(user.getIdTokenResult(true), 20000);
    } catch (tokErr) {
      if (
        tokErr?.code === "OPERATION_TIMEOUT" ||
        tokErr?.message === "Slow connection, please try again"
      ) {
        throw new Error("Slow connection, please try again");
      }
      tokenResult = { claims: {} };
    }
    const userClaims = tokenResult.claims || {};
    const { isAdmin: verifiedAdmin, isTutor: verifiedTutor, role: resolvedRole } =
      resolveClaimsPrivilege(userClaims);

    setCurrentUser(user);
    setClaims(userClaims);
    setIsAdmin(verifiedAdmin);
    setIsTutor(verifiedTutor);
    setRole(resolvedRole);

    const profile = await syncProfile(user, resolvedRole);

    return { user, role: resolvedRole, profile, claims: userClaims, isAdmin: verifiedAdmin, isTutor: verifiedTutor };
  }

  /**
   * loginWithGoogle:
   * Google popup sign-in with strict Custom Claim role verification.
   * First-time users are provisioned with ONLY permitted registration fields (no role).
   */
  async function loginWithGoogle() {
    const provider = new GoogleAuthProvider();
    let result;
    try {
      result = await signInWithPopup(auth, provider);
    } catch (err) {
      throw new Error(formatAuthError(err));
    }

    const user = result.user;
    if (!user) throw new Error("Google sign-in was cancelled or failed.");

    let tokenResult;
    try {
      tokenResult = await withTimeout(user.getIdTokenResult(true), 20000);
    } catch (tokErr) {
      if (
        tokErr?.code === "OPERATION_TIMEOUT" ||
        tokErr?.message === "Slow connection, please try again"
      ) {
        throw new Error("Slow connection, please try again");
      }
      throw new Error(tokErr?.message || "Failed to verify authentication token. Please try again.");
    }
    const userClaims = tokenResult.claims || {};
    const { isAdmin: verifiedAdmin, isTutor: verifiedTutor, role: resolvedRole } =
      resolveClaimsPrivilege(userClaims);

    // Check if Firestore profile exists; create with ONLY permitted registration fields if first-time user
    const userRef = doc(db, "users", user.uid);
    let docSnap;
    try {
      docSnap = await withTimeout(getDoc(userRef), 20000);
    } catch (readErr) {
      if (
        readErr?.code === "OPERATION_TIMEOUT" ||
        readErr?.message === "Slow connection, please try again"
      ) {
        throw new Error("Slow connection, please try again");
      }
      throw new Error(readErr?.message || "Failed to load user profile. Please try again.");
    }

    let profileData = docSnap.exists() ? docSnap.data() : null;
    if (!docSnap.exists()) {
      let gSurname = "";
      let gFirstName = "";
      const nameParts = (user.displayName || "").trim().split(/\s+/).filter(Boolean);
      if (nameParts.length >= 2) {
        gSurname = nameParts[0];
        gFirstName = nameParts.slice(1).join(" ");
      } else if (nameParts.length === 1) {
        gSurname = nameParts[0];
        gFirstName = nameParts[0];
      }

      const initialGoogleData = {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || user.email?.split("@")[0] || "User",
        fullName: user.displayName || user.email?.split("@")[0] || "User",
        surname: gSurname || null,
        firstName: gFirstName || null,
        studentType: "non_corper",
        status: "active",
        createdAt: serverTimestamp(),
      };

      try {
        await withTimeout(setDoc(userRef, initialGoogleData, { merge: true }), 20000);
      } catch (writeErr) {
        if (
          writeErr?.code === "OPERATION_TIMEOUT" ||
          writeErr?.message === "Slow connection, please try again"
        ) {
          throw new Error("Slow connection, please try again");
        }
        throw new Error(writeErr?.message || "Failed to save your user profile. Please try again.");
      }
      profileData = initialGoogleData;
    }

    let allocatedRegNumber = profileData?.regNumber || null;
    if (!allocatedRegNumber) {
      allocatedRegNumber = await allocateRegistrationCode(user.uid, {
        email: profileData?.email || user.email || "",
        fullName: profileData?.fullName || user.displayName || "",
        displayName: profileData?.displayName || user.displayName || "",
        surname: profileData?.surname || "",
        firstName: profileData?.firstName || "",
        studentType: profileData?.studentType || "non_corper",
        nyscStateCode: profileData?.nyscStateCode || null,
        phoneNumber: profileData?.phoneNumber || "",
      }).catch((allocErr) => {
        console.error("Registration code allocation failed during Google sign-in; flagging needsRegCode:", allocErr);
        return null;
      });
    }

    setCurrentUser(user);
    setClaims(userClaims);
    setIsAdmin(verifiedAdmin);
    setIsTutor(verifiedTutor);
    setRole(resolvedRole);

    const synced = await syncProfile(user, resolvedRole);
    const resolvedProfile = {
      ...(synced || profileData || {}),
      ...(allocatedRegNumber
        ? { regNumber: allocatedRegNumber, needsRegCode: false }
        : { needsRegCode: !synced?.regNumber }),
      role: resolvedRole,
    };
    setUserProfile(resolvedProfile);

    return { user, role: resolvedRole, profile: resolvedProfile, claims: userClaims, isAdmin: verifiedAdmin, isTutor: verifiedTutor };
  }

  function resetPassword(email) {
    const cleanEmail = (email || "").trim().toLowerCase();
    if (!cleanEmail) throw new Error("Please enter your email address to reset password.");
    return sendPasswordResetEmail(auth, cleanEmail);
  }

  /**
   * Completes a password reset flow (oobCode from email link) while enforcing the password policy.
   */
  async function confirmResetPassword(oobCode, newPassword) {
    const cleanCode = (oobCode || "").trim();
    if (!cleanCode) {
      throw new Error("Missing or invalid password reset code.");
    }
    validatePasswordOrThrow(newPassword);
    try {
      await verifyPasswordResetCode(auth, cleanCode);
      await confirmPasswordReset(auth, cleanCode, newPassword);
      return true;
    } catch (err) {
      throw new Error(formatAuthError(err));
    }
  }

  /**
   * Updates the currently signed-in user's password while enforcing the password policy.
   */
  async function changeUserPassword(newPassword) {
    if (!auth.currentUser) {
      throw new Error("You must be signed in to update your password.");
    }
    validatePasswordOrThrow(newPassword);
    try {
      await updatePassword(auth.currentUser, newPassword);
      return true;
    } catch (err) {
      throw new Error(formatAuthError(err));
    }
  }

  async function logout() {
    try {
      await signOut(auth);
    } catch (e) {
      console.warn("Sign out notice:", e);
    } finally {
      setCurrentUser(null);
      setUserProfile(null);
      setClaims({});
      setIsAdmin(false);
      setIsTutor(false);
      setRole("student");
      setAuthError(null);
    }
  }

  const isSuspended = userProfile?.status === "suspended";
  const suspensionReason = userProfile?.suspensionReason || "";

  const value = {
    currentUser,
    userProfile,
    claims,
    isAdmin,
    isTutor,
    role,
    isSuspended,
    suspensionReason,
    loading,
    authError,
    signup,
    login,
    logout,
    loginWithGoogle,
    resetPassword,
    confirmResetPassword,
    changeUserPassword,
    refreshClaims,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
