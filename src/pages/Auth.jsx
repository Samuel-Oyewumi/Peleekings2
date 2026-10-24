import { useState } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

export default function Auth() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, signup, resetPassword } = useAuth();

  // Mode: "signup" or "login"
  const initialMode = location.state?.mode || "signup";
  const [authMode, setAuthMode] = useState(initialMode);
  const [roleTab, setRoleTab] = useState(location.state?.tab || "student"); // "student" or "tutor"

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
        if (studentType === "corper" && !formData.nyscStateCode.trim()) {
          throw new Error("Please enter your NYSC State Code.");
        }
        if (!formData.password || formData.password.length < 6) {
          throw new Error("Password must be at least 6 characters.");
        }
        if (formData.password !== formData.confirmPassword) {
          throw new Error("Passwords do not match. Please verify both passwords.");
        }

        const cleanEmail = formData.email.trim().toLowerCase();
        const isAdmin = cleanEmail === "admin@peleekings.com";
        const fullName = `${formData.surname.trim()} ${formData.firstName.trim()}`;
        const customProfile = {
          fullName,
          surname: formData.surname.trim(),
          firstName: formData.firstName.trim(),
          otherName: formData.otherName.trim() || null,
          phoneNumber: formData.phoneNumber.trim() || "",
          studentType,
          nyscStateCode: studentType === "corper" ? formData.nyscStateCode.trim() : null,
          submittedRole: isAdmin ? "admin" : (roleTab === "tutor" ? "tutor" : "student"),
        };

        const authRes = await signup(cleanEmail, formData.password, fullName, customProfile);
        setLoading(false);

        // If admin signed up, take them immediately to /admin
        if (isAdmin || authRes.role === "admin") {
          navigate("/admin", { state: { welcomeToast: "Welcome Admin! Your account has been initialized." } });
          return;
        }

        // Show green confirmation panel for learners/tutors
        setRegisteredProfile(authRes.profile || { fullName, regNumber: "Assigned" });
      } else {
        // Log In
        const cleanEmail = formData.email.trim().toLowerCase();
        if (!cleanEmail) throw new Error("Please enter your email address.");
        if (!formData.password) throw new Error("Please enter your password.");

        const authRes = await login(cleanEmail, formData.password);
        const role = authRes.role;
        const profile = authRes.profile;
        setLoading(false);

        // Auto-detect admin: If email is admin@peleekings.com or role is admin, take directly to /admin
        if (role === "admin" || cleanEmail === "admin@peleekings.com" || profile?.role === "admin") {
          navigate("/admin", { state: { welcomeToast: "Welcome Admin! Signed in successfully." } });
        } else if (role === "tutor" || role === "instructor" || roleTab === "tutor") {
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
      console.error(err);
      setError(err.message || "Authentication error. Please check your credentials.");
      setLoading(false);
    }
  }

  function handleContinueFromConfirmation() {
    if (formData.email.trim().toLowerCase() === "admin@peleekings.com" || registeredProfile?.role === "admin") {
      navigate("/admin", { state: { welcomeToast: "Welcome Admin! Signed in successfully." } });
    } else if (roleTab === "tutor") {
      navigate("/teach-portal", {
        state: { welcomeToast: `Welcome ${registeredProfile?.fullName || ""}! You can now access your teaching portal.` },
      });
    } else {
      navigate("/dashboard", {
        state: {
          welcomeToast: `Welcome ${registeredProfile?.fullName || ""}! Your Registration Code is ${
            registeredProfile?.regNumber || "Verified"
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
            <div className="brand-logo-icon">P</div>
            <span>Peleekings</span>
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
                {registeredProfile.regNumber || "PENDING"}
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
                  setError("");
                }}
              >
                Create Account
              </button>
            </div>

            {/* Student vs Tutor Tabs for Login */}
            {authMode === "login" && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 6,
                  marginBottom: 14,
                  padding: 4,
                  background: "var(--bg-subtle)",
                  borderRadius: "8px",
                }}
              >
                <button
                  type="button"
                  onClick={() => setRoleTab("student")}
                  style={{
                    padding: "8px 8px",
                    borderRadius: "6px",
                    fontSize: "0.85rem",
                    fontWeight: 600,
                    border: "none",
                    cursor: "pointer",
                    background: roleTab === "student" ? "var(--primary-learner)" : "transparent",
                    color: roleTab === "student" ? "#FFFFFF" : "var(--text-muted)",
                    transition: "all 0.15s ease",
                  }}
                >
                  Student
                </button>
                <button
                  type="button"
                  onClick={() => setRoleTab("tutor")}
                  style={{
                    padding: "8px 8px",
                    borderRadius: "6px",
                    fontSize: "0.85rem",
                    fontWeight: 600,
                    border: "none",
                    cursor: "pointer",
                    background: roleTab === "tutor" ? "var(--tutor-accent)" : "transparent",
                    color: roleTab === "tutor" ? "#FFFFFF" : "var(--text-muted)",
                    transition: "all 0.15s ease",
                  }}
                >
                  Tutor
                </button>
              </div>
            )}

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
                  {/* Corper vs Non-Corper Selection Buttons */}
                  <div className="corper-selector-group">
                    <button
                      type="button"
                      className={`corper-select-btn ${studentType === "non_corper" ? "selected" : ""}`}
                      onClick={() => handleTypeSelect("non_corper")}
                    >
                      <span>👤</span>
                      Non-Corper
                    </button>
                    <button
                      type="button"
                      className={`corper-select-btn ${studentType === "corper" ? "selected" : ""}`}
                      onClick={() => handleTypeSelect("corper")}
                    >
                      <span>🎓</span>
                      Corper
                    </button>
                  </div>

                  {/* Personal Information Group */}
                  <div
                    style={{
                      fontSize: "0.8rem",
                      fontWeight: 700,
                      color: "var(--text-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      marginBottom: 12,
                    }}
                  >
                    Personal Information ({studentType === "non_corper" ? "Non-Corper" : "Corper"})
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
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

                  {/* NYSC Information (Only visible if Corper) */}
                  {studentType === "corper" && (
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
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
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
                      placeholder="name@example.com"
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
                    <div style={{ background: "#F0F9FF", border: "1px solid #BAE6FD", borderRadius: 8, padding: "14px 16px", marginTop: 4 }}>
                      {fpStatus === "sent" ? (
                        <p style={{ fontSize: "0.82rem", color: "#0369A1", fontWeight: 600 }}>
                          ✓ Reset link sent! Check your inbox for <strong>{fpEmail}</strong>.
                        </p>
                      ) : (
                        <>
                          <p style={{ fontSize: "0.8rem", color: "#0369A1", marginBottom: 8 }}>
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
                  background: roleTab === "tutor" && authMode === "login" ? "var(--tutor-accent)" : "var(--primary-learner)",
                }}
              >
                {loading
                  ? "Processing..."
                  : authMode === "signup"
                  ? "Create Account & Enter →"
                  : `Sign In as ${roleTab === "tutor" ? "Tutor" : "Student"} →`}
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
                  <Link to="/teach" style={{ color: "var(--primary-learner)", fontWeight: 600 }}>
                    Apply to become a tutor
                  </Link>
                </>
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
