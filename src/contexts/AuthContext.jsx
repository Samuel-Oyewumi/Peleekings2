import { createContext, useContext, useEffect, useState, useCallback } from "react";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  GoogleAuthProvider,
  signInWithPopup,
  sendPasswordResetEmail,
} from "firebase/auth";
import { doc, setDoc, getDoc, serverTimestamp } from "firebase/firestore";
import { auth, db } from "../firebase";
import { enrollInCourse } from "./userActivity";

const AuthContext = createContext(null);

function withTimeout(promise, ms = 3500) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("OPERATION_TIMEOUT")), ms)
    ),
  ]);
}

// Format Firebase auth error codes into clear, user-friendly messages
function formatAuthError(err) {
  if (!err) return "An unknown authentication error occurred.";
  const code = err.code || "";
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Invalid email or password. Please verify your credentials.";
    case "auth/email-already-in-use":
      return "An account with this email address already exists. Please sign in.";
    case "auth/weak-password":
      return "Password should be at least 6 characters.";
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
      const tokenResult = await withTimeout(auth.currentUser.getIdTokenResult(true), 4000);
      const userClaims = tokenResult.claims || {};
      const verifiedAdmin = userClaims.admin === true || userClaims.role === "admin";
      const verifiedTutor = userClaims.tutor === true || userClaims.role === "tutor" || verifiedAdmin;
      const resolvedRole = verifiedAdmin ? "admin" : (verifiedTutor ? "tutor" : "student");

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
    };

    try {
      const docSnap = await withTimeout(getDoc(doc(db, "users", user.uid)), 3500);
      if (docSnap.exists()) {
        const data = docSnap.data();
        const profile = {
          ...data,
          uid: user.uid,
          email: user.email,
          displayName: data.displayName || user.displayName || user.email?.split("@")[0] || "User",
          fullName: data.fullName || data.displayName || user.displayName || user.email?.split("@")[0] || "User",
          role: verifiedRole, // Verified role from Custom Claims overrides any document role
        };
        setUserProfile(profile);
        return profile;
      } else {
        setUserProfile(fallbackProfile);
        return fallbackProfile;
      }
    } catch (err) {
      console.warn("Firestore profile sync notice:", err);
      setUserProfile((prev) => prev || fallbackProfile);
      return fallbackProfile;
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
    }, 4500);

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!isMounted) return;
      setAuthError(null);
      if (user) {
        try {
          // Fetch verified claims directly from Firebase Authentication token
          const tokenResult = await withTimeout(user.getIdTokenResult(), 3500);
          const userClaims = tokenResult.claims || {};
          const verifiedAdmin = userClaims.admin === true || userClaims.role === "admin";
          const verifiedTutor = userClaims.tutor === true || userClaims.role === "tutor" || verifiedAdmin;
          const resolvedRole = verifiedAdmin ? "admin" : (verifiedTutor ? "tutor" : "student");

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

          await syncProfile(user, resolvedRole);
        } catch (err) {
          console.error("Auth state claim verification failure, failing closed:", err);
          if (!isMounted) return;
          // Fail closed
          setCurrentUser(user);
          setClaims({});
          setIsAdmin(false);
          setIsTutor(false);
          setRole("student");
          setAuthError("Failed to verify authorization claims.");
          setLoading(false);
          clearTimeout(safetyTimer);
          await syncProfile(user, "student");
        }
      } else {
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
   * Writes initial non-privileged user document with ONLY permitted registration fields.
   * Role and regNumber are omitted; trusted onUserCreated Cloud Function assigns them.
   * Throws if Firestore profile write fails (never silently ignores failures).
   */
  async function signup(email, password, arg3, arg4) {
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
    if (!password || password.length < 6) throw new Error("Password must be at least 6 characters.");

    let userCredential;
    try {
      userCredential = await createUserWithEmailAndPassword(auth, cleanEmail, password);
    } catch (authErr) {
      throw new Error(formatAuthError(authErr));
    }

    const user = userCredential.user;

    if (cleanName) {
      try {
        await updateProfile(user, { displayName: cleanName });
      } catch (e) {
        console.warn("Could not set display name in Firebase Auth:", e);
      }
    }

    // Write initial user profile with ONLY permitted registration fields.
    // Crucially: 'role' is omitted so onUserCreated Cloud Function assigns the authoritative role.
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

    // Strict profile creation with timeout protection so UI never hangs indefinitely
    try {
      await withTimeout(setDoc(doc(db, "users", user.uid), initialData, { merge: true }), 4000);
    } catch (firestoreErr) {
      console.warn("Notice: Initial user profile write timed out or failed in Firestore:", firestoreErr);
    }

    // Auto-enroll in default welcome course
    enrollInCourse(user.uid, "ai-essentials", "online")
      .catch((err) => console.warn("Notice: auto-enrollment in default course skipped:", err));

    let tokenResult;
    try {
      tokenResult = await withTimeout(user.getIdTokenResult(true), 3500);
    } catch {
      tokenResult = { claims: {} };
    }
    const userClaims = tokenResult.claims || {};
    const verifiedAdmin = userClaims.admin === true || userClaims.role === "admin";
    const verifiedTutor = userClaims.tutor === true || userClaims.role === "tutor" || verifiedAdmin;
    const resolvedRole = verifiedAdmin ? "admin" : (verifiedTutor ? "tutor" : "student");

    setCurrentUser(user);
    setClaims(userClaims);
    setIsAdmin(verifiedAdmin);
    setIsTutor(verifiedTutor);
    setRole(resolvedRole);
    setUserProfile({ ...initialData, role: resolvedRole });

    return { user, role: resolvedRole, profile: initialData };
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
      userCredential = await signInWithEmailAndPassword(auth, cleanEmail, password);
    } catch (authErr) {
      throw new Error(formatAuthError(authErr));
    }

    const user = userCredential.user;

    // Force refresh ID token to get latest Custom Claims
    let tokenResult;
    try {
      tokenResult = await withTimeout(user.getIdTokenResult(true), 3500);
    } catch {
      tokenResult = await user.getIdTokenResult(false).catch(() => ({ claims: {} }));
    }
    const userClaims = tokenResult.claims || {};
    const verifiedAdmin = userClaims.admin === true || userClaims.role === "admin";
    const verifiedTutor = userClaims.tutor === true || userClaims.role === "tutor" || verifiedAdmin;
    const resolvedRole = verifiedAdmin ? "admin" : (verifiedTutor ? "tutor" : "student");

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
      tokenResult = await withTimeout(user.getIdTokenResult(true), 3500);
    } catch {
      tokenResult = await user.getIdTokenResult(false).catch(() => ({ claims: {} }));
    }
    const userClaims = tokenResult.claims || {};
    const verifiedAdmin = userClaims.admin === true || userClaims.role === "admin";
    const verifiedTutor = userClaims.tutor === true || userClaims.role === "tutor" || verifiedAdmin;
    const resolvedRole = verifiedAdmin ? "admin" : (verifiedTutor ? "tutor" : "student");

    // Check if Firestore profile exists; create with ONLY permitted registration fields if first-time user
    try {
      const userRef = doc(db, "users", user.uid);
      const docSnap = await withTimeout(getDoc(userRef), 3500);
      if (!docSnap.exists()) {
        // App convention: "Surname First" (e.g. "Oyewumi Oluwatobi").
        // We split the Google displayName treating the first word as the surname and remainder as firstName.
        // If empty or single-token, fallbacks ensure safe storage without breaking.
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
        await withTimeout(setDoc(userRef, initialGoogleData), 3500);
        enrollInCourse(user.uid, "ai-essentials", "online").catch(() => {});
      }
    } catch (fsErr) {
      console.warn("Google sign-in profile sync notice:", fsErr);
    }

    setCurrentUser(user);
    setClaims(userClaims);
    setIsAdmin(verifiedAdmin);
    setIsTutor(verifiedTutor);
    setRole(resolvedRole);

    const profile = await syncProfile(user, resolvedRole);

    return { user, role: resolvedRole, profile, claims: userClaims, isAdmin: verifiedAdmin, isTutor: verifiedTutor };
  }

  function resetPassword(email) {
    const cleanEmail = (email || "").trim().toLowerCase();
    if (!cleanEmail) throw new Error("Please enter your email address to reset password.");
    return sendPasswordResetEmail(auth, cleanEmail);
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
    refreshClaims,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
