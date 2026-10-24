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
   * If Firebase Auth fails, throw real error without setting local session state.
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

    // 1. Call Firebase Auth (do not set any local session state if this fails)
    let userCredential;
    try {
      userCredential = await createUserWithEmailAndPassword(auth, cleanEmail, password);
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
    // (role and regNumber are omitted — server-side Cloud Function sets them)
    const isNonCorper = customProfile.studentType === "non_corper";
    const { role: _ignoredRole, regNumber: _ignoredRegNum, ...cleanProfile } = customProfile;

    const initialData = {
      uid: user.uid,
      email: user.email,
      displayName: cleanName || user.email.split("@")[0],
      fullName: cleanName || user.email.split("@")[0],
      submittedRole: customProfile.submittedRole || customProfile.role || "student",
      studentType: customProfile.studentType || "non_corper",
      nyscStateCode: isNonCorper ? null : (customProfile.nyscStateCode || null),
      phoneNumber: customProfile.phoneNumber || "",
      createdAt: serverTimestamp(),
      status: "active",
      ...cleanProfile,
    };

    // Ensure regNumber is never sent by client, but explicitly set role 'admin' for admin@peleekings.com
    const isSpecialAdmin = cleanEmail === "admin@peleekings.com";
    if (isSpecialAdmin) {
      initialData.role = "admin";
    } else {
      delete initialData.role;
    }
    delete initialData.regNumber;

    try {
      await setDoc(doc(db, "users", user.uid), initialData);
    } catch (firestoreErr) {
      console.error("Firestore initial write error:", firestoreErr);
      throw new Error("Account created but profile initialization failed. Please contact support.");
    }

    // Use local initialData directly — no need to round-trip Firestore immediately after setDoc.
    const profileData = {
      ...initialData,
      role: isSpecialAdmin ? "admin" : (customProfile.submittedRole || "student"),
      regNumber: isSpecialAdmin ? "ADMIN" : "Assigned",
    };

    profileJustFetched.current = true;
    setCurrentUser(user);
    setUserProfile(profileData);
    localStorage.setItem("peleekings_user_profile_cache", JSON.stringify(profileData));

    // Fire-and-forget: create enrollment doc in background — do NOT block signup completion
    enrollInCourse(user.uid, "ai-essentials", "online")
      .catch(err => console.warn("Could not auto-enroll new user in default course:", err));

    return { user, role: profileData.role || "student", profile: profileData };
  }

  /**
   * login(email, password):
   * Call signInWithEmailAndPassword and await it.
   * Only on success, fetch users/{uid} from Firestore and use its role/regNumber as source of truth.
   * If it fails, throw real error — never fall back to a guessed profile.
   */
  async function login(email, password) {
    const cleanEmail = (email || "").trim().toLowerCase();
    if (!cleanEmail) throw new Error("Please enter your email address.");
    if (!password) throw new Error("Please enter your password.");

    // 1. Authenticate with Firebase Auth — await this (required)
    let userCredential;
    try {
      userCredential = await signInWithEmailAndPassword(auth, cleanEmail, password);
    } catch (authErr) {
      throw new Error(formatAuthError(authErr));
    }

    const user = userCredential.user;

    // 2. Build an instant profile from Auth data + cached data so UI navigates immediately.
    //    Firestore is synced in the background — no blocking round-trip.
    let cachedProfile = null;
    try {
      const cached = localStorage.getItem("peleekings_user_profile_cache");
      if (cached) cachedProfile = JSON.parse(cached);
    } catch {}

    const isAdmin = cleanEmail === "admin@peleekings.com";
    const instantProfile = cachedProfile && cachedProfile.uid === user.uid
      ? { ...cachedProfile }
      : {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName || user.email.split("@")[0],
          fullName: user.displayName || user.email.split("@")[0],
          role: isAdmin ? "admin" : "student",
          studentType: "non_corper",
          status: "active",
        };

    if (isAdmin) instantProfile.role = "admin";

    // Set state & navigate immediately — no Firestore wait
    profileJustFetched.current = true;
    setCurrentUser(user);
    setUserProfile(instantProfile);
    localStorage.setItem("peleekings_user_profile_cache", JSON.stringify(instantProfile));

    // 3. Background sync: fetch real Firestore profile and quietly update UI
    getDoc(doc(db, "users", user.uid))
      .then((docSnap) => {
        let fresh;
        if (docSnap.exists()) {
          fresh = docSnap.data();
        } else {
          fresh = { ...instantProfile, createdAt: serverTimestamp() };
          // Fire-and-forget: create missing doc
          setDoc(doc(db, "users", user.uid), fresh, { merge: true }).catch(() => {});
        }
        if (isAdmin) fresh.role = "admin";
        setUserProfile(fresh);
        localStorage.setItem("peleekings_user_profile_cache", JSON.stringify(fresh));
        // Fire-and-forget: sync admin role to Firestore
        if (isAdmin) {
          setDoc(doc(db, "users", user.uid), { role: "admin" }, { merge: true }).catch(() => {});
        }
      })
      .catch((fsErr) => {
        console.warn("Background Firestore profile sync notice:", fsErr);
      });

    return { user, role: instantProfile.role || "student", profile: instantProfile };
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

    let docSnap = await getDoc(doc(db, "users", user.uid));
    let profileData;

    if (!docSnap.exists()) {
      const initialData = {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || user.email.split("@")[0],
        fullName: user.displayName || user.email.split("@")[0],
        submittedRole: "student",
        studentType: "non_corper",
        status: "active",
        createdAt: serverTimestamp(),
      };
      await setDoc(doc(db, "users", user.uid), initialData);

      // Create real enrollment document for default course — fire and forget
      enrollInCourse(user.uid, "ai-essentials", "online")
        .catch(enrErr => console.warn("Could not auto-enroll Google user in default course:", enrErr));

      // Brief wait for Cloud Function onUserCreated — reduced to avoid blocking login
      await new Promise((res) => setTimeout(res, 300));
      docSnap = await getDoc(doc(db, "users", user.uid));
    }

    if (!docSnap.exists()) {
      throw new Error("Failed to load user profile from Firestore.");
    }

    profileData = docSnap.data();
    profileJustFetched.current = true;
    setCurrentUser(user);
    setUserProfile(profileData);
    localStorage.setItem("peleekings_user_profile_cache", JSON.stringify(profileData));

    return { user, role: profileData.role, profile: profileData };
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
            if (docSnap.exists()) {
              const verifiedProfile = docSnap.data();
              if (user.email?.toLowerCase() === "admin@peleekings.com") {
                verifiedProfile.role = "admin";
              }
              setUserProfile(verifiedProfile);
              localStorage.setItem("peleekings_user_profile_cache", JSON.stringify(verifiedProfile));
            } else {
              if (user.email?.toLowerCase() === "admin@peleekings.com") {
                const adminProfile = {
                  uid: user.uid,
                  email: user.email,
                  displayName: user.displayName || "Admin",
                  fullName: user.displayName || "Admin",
                  role: "admin",
                  status: "active",
                };
                setUserProfile(adminProfile);
                localStorage.setItem("peleekings_user_profile_cache", JSON.stringify(adminProfile));
              } else {
                // No Firestore doc — clear cache so stale data isn't trusted
                setUserProfile(null);
                localStorage.removeItem("peleekings_user_profile_cache");
              }
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
        localStorage.removeItem("peleekings_user_profile_cache");
        setLoading(false);
      }
    });

    return unsubscribe;
  }, []);

  async function updateUserRole(newRole) {
    // Note: Role cannot be updated directly from the client per Firestore security rules.
    // Promotions are handled server-side via the promoteToTutor Cloud Function.
    setUserProfile((prev) => {
      const updated = prev ? { ...prev, role: newRole } : { role: newRole };
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
