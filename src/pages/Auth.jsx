import { useState, useEffect } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { User, GraduationCap } from "lucide-react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../contexts/AuthContext";

export default function Auth() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, signup, logout, resetPassword } = useAuth();

  // Mode: "signup" or "login"
  const initialMode = location.state?.mode || "signup";
  const [authMode, setAuthMode] = useState(initialMode);
  const [roleTab, setRoleTab] = useState(location.state?.tab || "student"); // "student" | "tutor" | "admin"

  // Registration type: "corper" vs "non_corper"
  const [studentType, setStudentType] = useState("non_corper");

  // Form state
  const [formData, setFormData] = useState({
    surname: "",
    firstName: "",
    otherName: "",
    email: "",
    phoneNumber: "",
    nyscStateCode: "",
    password: "",
    confirmPassword: "",
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Forgot-password inline panel state
  const [showForgotPw, setShowForgotPw] = useState(false);
  const [fpEmail, setFpEmail] = useState("");
  const [fpStatus, setFpStatus] = useState(""); // "sent" | "error" | ""
  // Success state for showing the green confirmation panel
  const [registeredProfile, setRegisteredProfile] = useState(null);

  // Subscribe to real regNumber from Firestore users/{uid} until generated
  useEffect(() => {
    if (!registeredProfile?.uid) return;
    if (registeredProfile.regNumber && registeredProfile.regNumber !== "Assigned" && registeredProfile.regNumber !== "PENDING") {
      return;
    }
    const unsub = onSnapshot(
      doc(db, "users", registeredProfile.uid),
      (snap) => {
        if (snap.exists()) {
          const uData = snap.data();
          if (uData.regNumber) {
            setRegisteredProfile((prev) => ({
              ...prev,
              ...uData,
              regNumber: uData.regNumber,
            }));
          }
        }
      },
      (err) => {
        console.warn("Notice: Auth registration code listener error:", err);
      }
    );
    return () => unsub();
  }, [registeredProfile?.uid, registeredProfile?.regNumber]);

  function handleChange(e) {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    setError("");
  }

  function handleTypeSelect(type) {
    setStudentType(type);
    if (type === "non_corper") {
      setFormData((prev) => ({ ...prev, nyscStateCode: "" }));
    }
  }

  async function handleSubmit(e) {
    if (e) e.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (authMode === "signup") {
        if (!formData.surname.trim() || !formData.firstName.trim()) {
          throw new Error("Please enter your surname and first name.");
        }
        if (!formData.email.trim()) {
          throw new Error("Please enter a valid email address.");
        }
        if (roleTab === "student" && studentType === "corper" && !formData.nyscStateCode.trim()) {
          throw new Error("Please enter your NYSC State Code.");
        }
        if (!formData.password || formData.password.length < 6) {
          throw new Error("Password must be at least 6 characters.");
        }
        if (formData.password !== formData.confirmPassword) {
          throw new Error("Passwords do not match. Please verify both passwords.");
        }

        const cleanEmail = formData.email.trim().toLowerCase();
        const fullName = `${formData.surname.trim()} ${formData.firstName.trim()}`;
        const effectiveStudentType = roleTab === "tutor" ? "non_corper" : studentType;
        const customProfile = {
          fullName,
          surname: formData.surname.trim(),
          firstName: formData.firstName.trim(),
          otherName: formData.otherName.trim() || null,
          phoneNumber: formData.phoneNumber.trim() || "",
          studentType: effectiveStudentType,
          nyscStateCode: effectiveStudentType === "corper" ? formData.nyscStateCode.trim() : null,
        };

        const authRes = await signup(cleanEmail, formData.password, fullName, customProfile);
        setLoading(false);

        // If admin signed up with verified admin claim, route to /admin
        if (authRes.role === "admin") {
          navigate("/admin", { state: { welcomeToast: "Welcome Admin! Your account has been initialized." } });
          return;
        }

        // Show green confirmation panel for learners/tutors
        setRegisteredProfile({
          uid: authRes.user.uid,
          fullName,
          regNumber: authRes.profile?.regNumber || null,
          role: authRes.role,
        });
      } else {
        // Log In
        const cleanEmail = formData.email.trim().toLowerCase();
        if (!cleanEmail) throw new Error("Please enter your email address.");
        if (!formData.password) throw new Error("Please enter your password.");

        const authRes = await login(cleanEmail, formData.password);
        const isUserAdmin = authRes.isAdmin === true;
        const isUserTutor = authRes.isTutor === true;
        const profile = authRes.profile;

        // Validate Admin tab access: strictly require verified Custom Claim
        if (roleTab === "admin" && !isUserAdmin) {
          await logout();
          throw new Error("Access denied: This account does not have verified Administrator privileges.");
        }

        setLoading(false);

        // Route based on verified role from Custom Claims
        if (isUserAdmin) {
          navigate("/admin", { state: { welcomeToast: "Welcome Admin! Signed in successfully." } });
        } else if (isUserTutor) {
          navigate("/teach-portal", { state: { welcomeToast: `Welcome back, ${profile?.fullName || "Instructor"}!` } });
        } else {
          navigate("/dashboard", {
            state: {
              welcomeToast: `Welcome back, ${profile?.fullName || "Learner"}!`,
            },
          });
        }
      }
    } catch (err) {
      setError(err.message || "Authentication error. Please check your credentials.");
      setLoading(false);
    }
  }

  function handleContinueFromConfirmation() {
    if (registeredProfile?.role === "admin") {
      navigate("/admin", { state: { welcomeToast: "Welcome Admin! Signed in successfully." } });
    } else if (registeredProfile?.role === "tutor") {
      navigate("/teach-portal", {
        state: { welcomeToast: `Welcome ${registeredProfile?.fullName || ""}! You can now access your teaching portal.` },
      });
    } else {
      navigate("/dashboard", {
        state: {
          welcomeToast: `Welcome ${registeredProfile?.fullName || ""}!${
            registeredProfile?.regNumber ? ` Your Registration Code is ${registeredProfile.regNumber}.` : ""
          }`,
        },
      });
    }
  }

  return (
    <div className="auth-page-wrapper">
      <div className="auth-card-container">
        {/* Brand Header */}
        <div className="auth-title-block">
          <Link to="/" className="brand-wrapper" style={{ justifyContent: "center", marginBottom: 16 }}>
            <div className="brand-logo-icon">
              <img src="/assets/aistudio/20260925_194828_31921ef2.png" alt="" className="brand-submark-img" />
            </div>
            <img src="/assets/aistudio/20260925_194706_376e00d5.png" alt="Peleekings" className="brand-wordmark-img" />
          </Link>
          <h1 style={{ fontSize: "1.65rem", fontWeight: 800, color: "var(--text-primary)", marginBottom: 6 }}>
            {registeredProfile
              ? "Registration Complete"
              : authMode === "signup"
              ? "Create your account"
              : "Welcome back"}
          </h1>
          <p style={{ fontSize: "0.875rem", color: "var(--text-muted)" }}>
            {registeredProfile
              ? "Your account has been created successfully."
              : authMode === "signup"
              ? "Choose how you want to register."
              : "Sign in to access your portal and courses."}
          </p>
        </div>

        {/* Stage 1 One-Time Green Confirmation Panel */}
        {registeredProfile ? (
          <div style={{ animation: "fadeIn 0.3s ease" }}>
            <div
              style={{
                background: "#EAF7EF",
                border: "1px solid #BBF7D0",
                borderRadius: "12px",
                padding: "24px 20px",
                textAlign: "center",
                margin: "20px 0 24px",
              }}
            >
              <div
                style={{
                  fontSize: "0.85rem",
                  fontWeight: 700,
                  color: "#166534",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  marginBottom: 8,
                }}
              >
                Your Registration Code
              </div>
              <div
                style={{
                  fontSize: "2.25rem",
                  fontWeight: 800,
                  color: "#1B7A43",
                  letterSpacing: "0.08em",
                  fontFamily: "monospace",
                  marginBottom: 8,
                }}
              >
                {registeredProfile.regNumber || "Generating..."}
              </div>
              <div style={{ fontSize: "0.8rem", color: "#4B5563" }}>
                Generated automatically for instant clearance
              </div>
            </div>

            <button
              onClick={handleContinueFromConfirmation}
              className="btn btn-solid-dark btn-lg"
              style={{ width: "100%" }}
            >
              Continue to Dashboard →
            </button>
          </div>
        ) : (
          <>
            {/* Mode Switcher: Sign In vs Create Account */}
            <div className="auth-nav-tabs">
              <button
                type="button"
                className={`auth-nav-tab-btn ${authMode === "login" ? "active" : ""}`}
                onClick={() => {
                  setAuthMode("login");
                  setError("");
                }}
              >
                Sign In
              </button>
              <button
                type="button"
                className={`auth-nav-tab-btn ${authMode === "signup" ? "active" : ""}`}
                onClick={() => {
                  setAuthMode("signup");
                  if (roleTab === "admin") setRoleTab("student");
                  setError("");
                }}
              >
                Create Account
              </button>
            </div>

            {/* Role Selector Tabs: Student / Tutor / Admin (Login) or Student / Tutor (Sign Up) */}
            <div
              className="auth-role-tabs"
              style={{
                display: "grid",
                gridTemplateColumns: authMode === "login" ? "1fr 1fr 1fr" : "1fr 1fr",
                gap: 6,
                marginBottom: 14,
                padding: 4,
                background: "var(--bg-subtle)",
                borderRadius: "8px",
              }}
            >
              <button
                type="button"
                className={`auth-role-tab-btn ${roleTab === "student" ? "selected" : ""}`}
                onClick={() => {
                  setRoleTab("student");
                  setError("");
                }}
                style={{
                  padding: "8px 8px",
                  borderRadius: "6px",
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  border: "none",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  background: roleTab === "student" ? "#D13F57" : "transparent",
                  color: roleTab === "student" ? "#FFFFFF" : "var(--text-muted)",
                  transition: "all 0.15s ease",
                }}
              >
                Student
              </button>
              <button
                type="button"
                className={`auth-role-tab-btn ${roleTab === "tutor" ? "selected" : ""}`}
                onClick={() => {
                  setRoleTab("tutor");
                  setError("");
                }}
                style={{
                  padding: "8px 8px",
                  borderRadius: "6px",
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  border: "none",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  background:
                    roleTab === "tutor"
                      ? authMode === "signup"
                        ? "#D13F57"
                        : "var(--tutor-accent)"
                      : "transparent",
                  color: roleTab === "tutor" ? "#FFFFFF" : "var(--text-muted)",
                  transition: "all 0.15s ease",
                }}
              >
                Tutor
              </button>
              {authMode === "login" && (
                <button
                  type="button"
                  className={`auth-role-tab-btn ${roleTab === "admin" ? "selected" : ""}`}
                  onClick={() => {
                    setRoleTab("admin");
                    setError("");
                  }}
                  style={{
                    padding: "8px 8px",
                    borderRadius: "6px",
                    fontSize: "0.85rem",
                    fontWeight: 600,
                    border: "none",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    background: roleTab === "admin" ? "#0F172A" : "transparent",
                    color: roleTab === "admin" ? "#FFFFFF" : "var(--text-muted)",
                    transition: "all 0.15s ease",
                  }}
                >
                  Admin
                </button>
              )}
            </div>

            {error && (
              <div
                style={{
                  background: "#FEE2E2",
                  color: "#B91C1C",
                  padding: "10px 14px",
                  borderRadius: "var(--radius-sm)",
                  fontSize: "0.85rem",
                  marginBottom: 18,
                }}
              >
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit}>
              {authMode === "signup" && (
                <>
                  {/* Corper vs Non-Corper Selection Buttons (Learner mode only) */}
                  {roleTab === "student" && (
                    <div className="corper-selector-group">
                      <button
                        type="button"
                        className={`corper-select-btn ${studentType === "non_corper" ? "selected" : ""}`}
                        onClick={() => handleTypeSelect("non_corper")}
                      >
                        <User size={18} aria-hidden="true" />
                        <span className="corper-select-label">Non-Corper</span>
                      </button>
                      <button
                        type="button"
                        className={`corper-select-btn ${studentType === "corper" ? "selected" : ""}`}
                        onClick={() => handleTypeSelect("corper")}
                      >
                        <GraduationCap size={18} aria-hidden="true" />
                        <span className="corper-select-label">Corper</span>
                      </button>
                    </div>
                  )}

                  {/* Personal Information Group */}
                  <div className="auth-section-label">
                    {roleTab === "tutor"
                      ? "Instructor Profile Information"
                      : "Personal Information"}
                  </div>

                  <div className="form-grid-2col">
                    <div className="form-field-group">
                      <label className="form-field-label">Surname</label>
                      <input
                        type="text"
                        name="surname"
                        required
                        className="form-field-input"
                        value={formData.surname}
                        onChange={handleChange}
                      />
                    </div>
                    <div className="form-field-group">
                      <label className="form-field-label">First Name</label>
                      <input
                        type="text"
                        name="firstName"
                        required
                        className="form-field-input"
                        value={formData.firstName}
                        onChange={handleChange}
                      />
                    </div>
                  </div>

                  <div className="form-field-group">
                    <label className="form-field-label">Other Name (Optional)</label>
                    <input
                      type="text"
                      name="otherName"
                      className="form-field-input"
                      value={formData.otherName}
                      onChange={handleChange}
                    />
                  </div>

                  <div className="form-field-group">
                    <label className="form-field-label">Email Address</label>
                    <input
                      type="email"
                      name="email"
                      required
                      className="form-field-input"
                      value={formData.email}
                      onChange={handleChange}
                    />
                  </div>

                  <div className="form-field-group">
                    <label className="form-field-label">Phone Number</label>
                    <input
                      type="tel"
                      name="phoneNumber"
                      className="form-field-input"
                      value={formData.phoneNumber}
                      onChange={handleChange}
                    />
                  </div>

                  {/* NYSC Information (Only visible if Student + Corper) */}
                  {roleTab === "student" && studentType === "corper" && (
                    <div>
                      <div
                        style={{
                          fontSize: "0.8rem",
                          fontWeight: 700,
                          color: "var(--text-muted)",
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          margin: "16px 0 10px",
                        }}
                      >
                        NYSC Information
                      </div>
                      <div className="form-field-group">
                        <label className="form-field-label">NYSC State Code</label>
                        <input
                          type="text"
                          name="nyscStateCode"
                          placeholder="e.g. AB/23A/1399"
                          required
                          className="form-field-input"
                          value={formData.nyscStateCode}
                          onChange={handleChange}
                        />
                      </div>
                    </div>
                  )}

                  {/* Passwords */}
                  <div className="form-grid-2col">
                    <div className="form-field-group">
                      <label className="form-field-label">Password</label>
                      <input
                        type="password"
                        name="password"
                        required
                        placeholder="••••••••"
                        className="form-field-input"
                        value={formData.password}
                        onChange={handleChange}
                      />
                    </div>
                    <div className="form-field-group">
                      <label className="form-field-label">Confirm</label>
                      <input
                        type="password"
                        name="confirmPassword"
                        required
                        placeholder="••••••••"
                        className="form-field-input"
                        value={formData.confirmPassword}
                        onChange={handleChange}
                      />
                    </div>
                  </div>
                </>
              )}

              {authMode === "login" && (
                <>
                  <div className="form-field-group">
                    <label className="form-field-label">Email Address</label>
                    <input
                      type="email"
                      name="email"
                      required
                      placeholder={roleTab === "admin" ? "admin@example.com" : "name@example.com"}
                      className="form-field-input"
                      value={formData.email}
                      onChange={handleChange}
                    />
                  </div>

                  <div className="form-field-group">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <label className="form-field-label">Password</label>
                      <button
                        type="button"
                        onClick={() => { setShowForgotPw(prev => !prev); setFpStatus(""); setFpEmail(formData.email || ""); }}
                        style={{ fontSize: "0.775rem", color: "var(--primary-learner)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}
                      >
                        Forgot password?
                      </button>
                    </div>
                    <input
                      type="password"
                      name="password"
                      required
                      placeholder="••••••••"
                      className="form-field-input"
                      value={formData.password}
                      onChange={handleChange}
                    />
                  </div>

                  {/* Inline Forgot-Password Panel */}
                  {showForgotPw && (
                    <div style={{ background: "#FDF2F4", border: "1px solid #F9C6CE", borderRadius: 8, padding: "14px 16px", marginTop: 4 }}>
                      {fpStatus === "sent" ? (
                        <p style={{ fontSize: "0.82rem", color: "#3C181A", fontWeight: 600 }}>
                          ✓ Reset link sent! Check your inbox for <strong>{fpEmail}</strong>.
                        </p>
                      ) : (
                        <>
                          <p style={{ fontSize: "0.8rem", color: "#3C181A", marginBottom: 8 }}>
                            Enter your email to receive a password reset link.
                          </p>
                          <div style={{ display: "flex", gap: 8 }}>
                            <input
                              type="email"
                              placeholder="name@example.com"
                              value={fpEmail}
                              onChange={e => setFpEmail(e.target.value)}
                              className="form-field-input"
                              style={{ flex: 1, marginBottom: 0 }}
                            />
                            <button
                              type="button"
                              className="btn btn-solid-dark btn-sm"
                              style={{ whiteSpace: "nowrap" }}
                              onClick={async () => {
                                if (!fpEmail.trim()) return;
                                try {
                                  await resetPassword(fpEmail.trim());
                                  setFpStatus("sent");
                                } catch (err) {
                                  setFpStatus("error");
                                  setError(err.message || "Failed to send reset email.");
                                }
                              }}
                            >
                              Send Link
                            </button>
                          </div>
                          {fpStatus === "error" && (
                            <p style={{ fontSize: "0.78rem", color: "#B91C1C", marginTop: 6 }}>Could not send reset email. Check the address and try again.</p>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </>
              )}

              <button
                type="submit"
                disabled={loading}
                className="btn btn-solid-dark btn-lg"
                style={{
                  width: "100%",
                  marginTop: 8,
                  background:
                    roleTab === "admin" && authMode === "login"
                      ? "#0F172A"
                      : roleTab === "tutor"
                      ? "var(--tutor-accent)"
                      : "var(--primary-learner)",
                }}
              >
                {loading
                  ? "Processing..."
                  : authMode === "signup"
                  ? `Create ${roleTab === "tutor" ? "Tutor" : "Student"} Account →`
                  : `Sign In as ${roleTab === "admin" ? "Admin" : roleTab === "tutor" ? "Tutor" : "Student"} →`}
              </button>
            </form>

            <div style={{ textAlign: "center", marginTop: 18, fontSize: "0.85rem", color: "var(--text-muted)" }}>
              {authMode === "signup" ? (
                <>
                  Already have an account?{" "}
                  <button
                    type="button"
                    onClick={() => setAuthMode("login")}
                    style={{ color: "var(--primary-learner)", fontWeight: 600, background: "none", border: "none", cursor: "pointer" }}
                  >
                    Sign In
                  </button>
                </>
              ) : roleTab === "tutor" ? (
                <>
                  New to teaching?{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setAuthMode("signup");
                      setRoleTab("tutor");
                      setError("");
                    }}
                    style={{ color: "var(--primary-learner)", fontWeight: 600, background: "none", border: "none", cursor: "pointer" }}
                  >
                    Create a Tutor account
                  </button>
                </>
              ) : roleTab === "admin" ? (
                <span>Authorized Peleekings administrator access only.</span>
              ) : (
                <>
                  Don't have an account?{" "}
                  <button
                    type="button"
                    onClick={() => setAuthMode("signup")}
                    style={{ color: "var(--primary-learner)", fontWeight: 600, background: "none", border: "none", cursor: "pointer" }}
                  >
                    Create one
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
