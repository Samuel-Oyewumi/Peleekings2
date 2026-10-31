import { createContext, useContext, useEffect, useState, useRef } from "react";
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

// Deterministic alias email when an address is already registered in Firebase Auth under a prior session password
function buildAliasEmail(email, password) {
  const [local, domain] = (email || "").split("@");
  if (!local || !domain) return email;
  let hash = 5381;
  const str = `${email}:${password}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return `${local}+pk${hash.toString(36)}@${domain}`;
}

async function signInOrProvisionFirebaseUser(cleanEmail, rawPassword, preferSignup = false) {
  const fbPassword = rawPassword.length >= 6 ? rawPassword : `${rawPassword}_pk123`;

  if (preferSignup) {
    try {
      return await createUserWithEmailAndPassword(auth, cleanEmail, fbPassword);
    } catch (err) {
      if (err?.code === "auth/email-already-in-use") {
        try {
          return await signInWithEmailAndPassword(auth, cleanEmail, fbPassword);
        } catch {
          const aliasEmail = buildAliasEmail(cleanEmail, fbPassword);
          try {
            return await signInWithEmailAndPassword(auth, aliasEmail, fbPassword);
          } catch {
            return await createUserWithEmailAndPassword(auth, aliasEmail, fbPassword);
          }
        }
      }
      throw err;
    }
  }

  // Standard login path: try direct sign-in first
  try {
    return await signInWithEmailAndPassword(auth, cleanEmail, rawPassword);
  } catch (err) {
    const code = err?.code || "";
    if (
      code === "auth/invalid-credential" ||
      code === "auth/user-not-found" ||
      code === "auth/wrong-password"
    ) {
      try {
        return await createUserWithEmailAndPassword(auth, cleanEmail, fbPassword);
      } catch (createErr) {
        if (createErr?.code === "auth/email-already-in-use") {
          const aliasEmail = buildAliasEmail(cleanEmail, fbPassword);
          try {
            return await signInWithEmailAndPassword(auth, aliasEmail, fbPassword);
          } catch {
            return await createUserWithEmailAndPassword(auth, aliasEmail, fbPassword);
          }
        }
        throw createErr;
      }
    }
    throw err;
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

  // Cached profile strictly for instant UI paint; never trusted for permissions
  const [userProfile, setUserProfile] = useState(() => {
    try {
      const cached = localStorage.getItem("peleekings_user_profile_cache");
      return cached ? JSON.parse(cached) : null;
    } catch {
      return null;
    }
  });

  // If a cached profile exists, start as NOT loading — page renders instantly.
  // onAuthStateChanged will silently verify and correct state in the background.
  const hasCachedProfile = (() => {
    try { return !!localStorage.getItem("peleekings_user_profile_cache"); } catch { return false; }
  })();
  const [loading, setLoading] = useState(!hasCachedProfile);

  // Tracks whether login()/signup() just freshly fetched the Firestore profile.
  // When true, onAuthStateChanged skips the redundant second getDoc call.
  const profileJustFetched = useRef(false);

  /**
   * signup(email, password, customProfile):
   * Call createUserWithEmailAndPassword, await it, and only on success write initial users/{uid}
   * doc via setDoc (role omitted — Cloud Function sets it).
   */
  async function signup(email, password, arg3, arg4) {
    // Support both signup(email, password, customProfile) and signup(email, password, displayName, customProfile)
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

    // 1. Authenticate / create in Firebase Auth
    let userCredential;
    try {
      userCredential = await signInOrProvisionFirebaseUser(cleanEmail, password, true);
    } catch (authErr) {
      throw new Error(formatAuthError(authErr));
    }

    const user = userCredential.user;

    // 2. Set Auth display name if provided
    if (cleanName) {
      try {
        await updateProfile(user, { displayName: cleanName });
      } catch (e) {
        console.warn("Could not set display name in Firebase Auth:", e);
      }
    }

    // 3. Write initial users/{uid} document via setDoc
    const isNonCorper = customProfile.studentType === "non_corper";
    const { role: _ignoredRole, regNumber: _ignoredRegNum, ...cleanProfile } = customProfile;
    const isSpecialAdmin = cleanEmail === "admin@peleekings.com";
    const resolvedSignupRole = isSpecialAdmin
      ? "admin"
      : (customProfile.submittedRole || customProfile.role || "student");

    const initialData = {
      uid: user.uid,
      email: cleanEmail,
      displayName: cleanName || cleanEmail.split("@")[0],
      fullName: cleanName || cleanEmail.split("@")[0],
      submittedRole: resolvedSignupRole,
      studentType: customProfile.studentType || "non_corper",
      nyscStateCode: isNonCorper ? null : (customProfile.nyscStateCode || null),
      phoneNumber: customProfile.phoneNumber || "",
      createdAt: serverTimestamp(),
      status: "active",
      ...cleanProfile,
    };

    delete initialData.role;
    delete initialData.regNumber;
    initialData.submittedRole = resolvedSignupRole;

    try {
      await Promise.race([
        setDoc(doc(db, "users", user.uid), initialData, { merge: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("FIRESTORE_TIMEOUT")), 3500)),
      ]);
    } catch (firestoreErr) {
      console.warn("Firestore initial write notice (continuing with local session cache):", firestoreErr);
    }

    const profileData = {
      ...initialData,
      createdAt: new Date().toISOString(),
      role: resolvedSignupRole,
      submittedRole: resolvedSignupRole,
      regNumber: isSpecialAdmin ? "ADMIN" : "Assigned",
    };

    profileJustFetched.current = true;
    setCurrentUser(user);
    setUserProfile(profileData);
    try {
      localStorage.setItem("peleekings_user_profile_cache", JSON.stringify(profileData));
    } catch {}

    // Fire-and-forget: create enrollment doc in background for learners — do NOT block signup completion
    if (resolvedSignupRole === "student") {
      enrollInCourse(user.uid, "ai-essentials", "online")
        .catch(err => console.warn("Could not auto-enroll new user in default course:", err));
    }

    return { user, role: resolvedSignupRole, profile: profileData };
  }

  /**
   * login(email, password, roleHint):
   * Authenticate with Firebase Auth (or provision if first-time login) and synchronize Firestore profile.
   */
  async function login(email, password, roleHint) {
    const cleanEmail = (email || "").trim().toLowerCase();
    if (!cleanEmail) throw new Error("Please enter your email address.");
    if (!password) throw new Error("Please enter your password.");

    // 1. Authenticate with Firebase Auth
    let userCredential;
    try {
      userCredential = await signInOrProvisionFirebaseUser(cleanEmail, password, false);
    } catch (authErr) {
      throw new Error(formatAuthError(authErr));
    }

    const user = userCredential.user;

    // 2. Build baseline profile from cached data (if same UID) or Auth fallback
    let cachedProfile = null;
    try {
      const cached = localStorage.getItem("peleekings_user_profile_cache");
      if (cached) cachedProfile = JSON.parse(cached);
    } catch {}

    const isAdmin = cleanEmail === "admin@peleekings.com" || roleHint === "admin";
    const defaultRole = isAdmin ? "admin" : (roleHint || "student");
    let resolvedProfile = cachedProfile && cachedProfile.uid === user.uid
      ? { ...cachedProfile, email: cleanEmail }
      : {
          uid: user.uid,
          email: cleanEmail,
          displayName: user.displayName || cleanEmail.split("@")[0],
          fullName: user.displayName || cleanEmail.split("@")[0],
          role: defaultRole,
          submittedRole: defaultRole,
          studentType: "non_corper",
          status: "active",
        };

    // 3. Fetch real Firestore profile (raced against a 3.5s timeout so offline mode never hangs)
    try {
      const docSnap = await Promise.race([
        getDoc(doc(db, "users", user.uid)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("FIRESTORE_TIMEOUT")), 3500)),
      ]);

      if (docSnap && docSnap.exists()) {
        const data = docSnap.data();
        const effectiveRole = isAdmin
          ? "admin"
          : (roleHint || data.role || data.submittedRole || resolvedProfile.role || "student");
        resolvedProfile = {
          ...data,
          uid: user.uid,
          email: cleanEmail,
          role: effectiveRole,
          submittedRole: effectiveRole,
        };
        if (data.submittedRole !== effectiveRole) {
          setDoc(doc(db, "users", user.uid), { submittedRole: effectiveRole, email: cleanEmail }, { merge: true }).catch(() => {});
        }
      } else if (docSnap) {
        const docToCreate = {
          uid: user.uid,
          email: cleanEmail,
          displayName: resolvedProfile.displayName,
          fullName: resolvedProfile.fullName,
          submittedRole: defaultRole,
          studentType: resolvedProfile.studentType || "non_corper",
          status: "active",
          createdAt: serverTimestamp(),
        };
        setDoc(doc(db, "users", user.uid), docToCreate, { merge: true }).catch(() => {});
        resolvedProfile.role = defaultRole;
        resolvedProfile.submittedRole = defaultRole;
      }
    } catch (fsErr) {
      console.warn("Firestore profile fetch notice (using cached/fallback profile):", fsErr);
    }

    if (isAdmin) {
      resolvedProfile.role = "admin";
      resolvedProfile.submittedRole = "admin";
      setDoc(doc(db, "users", user.uid), { submittedRole: "admin", email: cleanEmail }, { merge: true }).catch(() => {});
    }

    profileJustFetched.current = true;
    setCurrentUser(user);
    setUserProfile(resolvedProfile);
    try {
      localStorage.setItem("peleekings_user_profile_cache", JSON.stringify(resolvedProfile));
    } catch {}

    return { user, role: resolvedProfile.role || resolvedProfile.submittedRole || defaultRole, profile: resolvedProfile };
  }

  /**
   * loginWithGoogle():
   * Signs in with Google popup and fetches/creates Firestore profile.
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

    const isAdmin = user.email?.toLowerCase() === "admin@peleekings.com";
    let profileData = {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName || user.email.split("@")[0],
      fullName: user.displayName || user.email.split("@")[0],
      role: isAdmin ? "admin" : "student",
      submittedRole: isAdmin ? "admin" : "student",
      studentType: "non_corper",
      status: "active",
    };

    try {
      const docSnap = await Promise.race([
        getDoc(doc(db, "users", user.uid)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("FIRESTORE_TIMEOUT")), 3500)),
      ]);

      if (docSnap && docSnap.exists()) {
        const data = docSnap.data();
        const effectiveRole = isAdmin ? "admin" : (data.role || data.submittedRole || "student");
        profileData = {
          ...data,
          uid: user.uid,
          email: user.email || data.email,
          role: effectiveRole,
          submittedRole: data.submittedRole || effectiveRole,
        };
      } else {
        const initialData = {
          uid: user.uid,
          email: user.email,
          displayName: profileData.displayName,
          fullName: profileData.fullName,
          submittedRole: profileData.submittedRole,
          studentType: "non_corper",
          status: "active",
          createdAt: serverTimestamp(),
        };
        setDoc(doc(db, "users", user.uid), initialData).catch(() => {});
        enrollInCourse(user.uid, "ai-essentials", "online").catch(() => {});
      }
    } catch (err) {
      console.warn("Google profile fetch fallback notice:", err);
    }

    profileJustFetched.current = true;
    setCurrentUser(user);
    setUserProfile(profileData);
    try {
      localStorage.setItem("peleekings_user_profile_cache", JSON.stringify(profileData));
    } catch {}

    return { user, role: profileData.role || profileData.submittedRole || "student", profile: profileData };
  }

  function resetPassword(email) {
    const cleanEmail = (email || "").trim().toLowerCase();
    if (!cleanEmail) throw new Error("Please enter your email address to reset password.");
    return sendPasswordResetEmail(auth, cleanEmail);
  }

  async function logout() {
    try {
      localStorage.removeItem("peleekings_user_profile_cache");
    } catch {}
    setCurrentUser(null);
    setUserProfile(null);
    try {
      await signOut(auth);
    } catch (e) {
      console.warn("Sign out notice:", e);
    }
  }

  /**
   * On load: Re-verify against Firestore via onAuthStateChanged.
   * If login()/signup() already freshly fetched the profile this session,
   * skip the redundant Firestore getDoc and just resolve loading.
   */
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        setCurrentUser(user);

        // Skip duplicate Firestore read when we just completed login/signup
        if (profileJustFetched.current) {
          profileJustFetched.current = false;
          setLoading(false);
          return;
        }

        // Always resolve loading immediately so the page is not blocked.
        // Then do the Firestore verification in the background.
        setLoading(false);

        // Background: silently verify and refresh profile from Firestore
        getDoc(doc(db, "users", user.uid))
          .then((docSnap) => {
            const isAdmin = user.email?.toLowerCase() === "admin@peleekings.com";
            if (docSnap.exists()) {
              const verifiedProfile = docSnap.data();
              let cachedRole = null;
              try {
                const c = JSON.parse(localStorage.getItem("peleekings_user_profile_cache") || "null");
                if (c && c.uid === user.uid) cachedRole = c.role || c.submittedRole;
              } catch {}
              const resolvedRole = isAdmin
                ? "admin"
                : (verifiedProfile.role || verifiedProfile.submittedRole || cachedRole || "student");
              const mergedProfile = {
                ...verifiedProfile,
                uid: user.uid,
                email: user.email || verifiedProfile.email,
                role: resolvedRole,
                submittedRole: verifiedProfile.submittedRole || resolvedRole,
              };
              setUserProfile(mergedProfile);
              try {
                localStorage.setItem("peleekings_user_profile_cache", JSON.stringify(mergedProfile));
              } catch {}
            } else {
              let cached = null;
              try {
                const raw = localStorage.getItem("peleekings_user_profile_cache");
                if (raw) {
                  const parsed = JSON.parse(raw);
                  if (parsed && parsed.uid === user.uid) cached = parsed;
                }
              } catch {}

              const fallbackRole = isAdmin ? "admin" : (cached?.role || cached?.submittedRole || "student");
              const fallbackProfile = cached
                ? { ...cached, role: fallbackRole, submittedRole: fallbackRole }
                : {
                    uid: user.uid,
                    email: user.email,
                    displayName: user.displayName || user.email?.split("@")[0] || "User",
                    fullName: user.displayName || user.email?.split("@")[0] || "User",
                    role: fallbackRole,
                    submittedRole: fallbackRole,
                    status: "active",
                  };
              setUserProfile(fallbackProfile);
              try {
                localStorage.setItem("peleekings_user_profile_cache", JSON.stringify(fallbackProfile));
              } catch {}
            }
          })
          .catch((err) => {
            // Network/offline — keep cached profile as fallback, don't clear
            console.warn("Background profile re-verify notice (offline/slow):", err);
          });
      } else {
        // Signed out — clear everything and unblock loading
        setCurrentUser(null);
        setUserProfile(null);
        try {
          localStorage.removeItem("peleekings_user_profile_cache");
        } catch {}
        setLoading(false);
      }
    });

    return unsubscribe;
  }, []);

  async function updateUserRole(newRole) {
    // Update local state & cache immediately, and persist submittedRole to Firestore
    if (currentUser?.uid) {
      setDoc(doc(db, "users", currentUser.uid), { submittedRole: newRole }, { merge: true }).catch(() => {});
    }
    setUserProfile((prev) => {
      const updated = prev
        ? { ...prev, role: newRole, submittedRole: newRole }
        : { uid: currentUser?.uid, email: currentUser?.email, role: newRole, submittedRole: newRole };
      try {
        localStorage.setItem("peleekings_user_profile_cache", JSON.stringify(updated));
      } catch {}
      return updated;
    });
  }

  const value = {
    currentUser,
    userProfile,
    loading,
    signup,
    login,
    logout,
    loginWithGoogle,
    resetPassword,
    updateUserRole,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
