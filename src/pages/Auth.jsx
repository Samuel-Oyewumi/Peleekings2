import { useState, useEffect, useRef } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { User, GraduationCap, Eye, EyeOff, CheckCircle2, Circle } from "lucide-react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../contexts/AuthContext";
import { checkPasswordRequirements, validatePasswordOrThrow } from "../utils/passwordPolicy";

export default function Auth() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, signup, logout, resetPassword, confirmResetPassword } = useAuth();

  const searchParams = new URLSearchParams(location.search);
  const queryMode = searchParams.get("mode");
  const oobCode = searchParams.get("oobCode") || "";

  // Mode: "signup" | "login" | "reset-confirm"
  const initialMode =
    queryMode === "resetPassword" && oobCode
      ? "reset-confirm"
      : location.state?.mode || "signup";
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

  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [resetCompleteMsg, setResetCompleteMsg] = useState("");
  // Forgot-password inline panel state
  const [showForgotPw, setShowForgotPw] = useState(false);
  const [fpEmail, setFpEmail] = useState("");
  const [fpStatus, setFpStatus] = useState(""); // "sent" | "error" | ""
  // Success state for showing the green confirmation panel
  const [registeredProfile, setRegisteredProfile] = useState(null);
  const isSubmittingRef = useRef(false);

  const passwordCheck = checkPasswordRequirements(formData.password);
  const passwordsMatch =
    Boolean(formData.confirmPassword) && formData.password === formData.confirmPassword;
  const passwordsMismatch =
    Boolean(formData.confirmPassword) && formData.password !== formData.confirmPassword;

  // Subscribe to real regNumber from Firestore users/{uid} until generated
  useEffect(() => {
    if (!registeredProfile?.uid) return;
    if (
      registeredProfile.regNumber &&
      registeredProfile.regNumber !== "Assigned" &&
      registeredProfile.regNumber !== "PENDING"
    ) {
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
    if (loading) return;
    setStudentType(type);
    if (type === "non_corper") {
      setFormData((prev) => ({ ...prev, nyscStateCode: "" }));
    }
  }

  async function handleSubmit(e) {
    if (e) e.preventDefault();
    if (isSubmittingRef.current || loading) return;

    setError("");
    setResetCompleteMsg("");
    isSubmittingRef.current = true;
    setLoading(true);

    try {
      if (authMode === "reset-confirm") {
        validatePasswordOrThrow(formData.password);
        if (formData.password !== formData.confirmPassword) {
          throw new Error("Passwords do not match. Please verify both passwords.");
        }
        await confirmResetPassword(oobCode, formData.password);
        setResetCompleteMsg("Your password has been updated. You may now sign in.");
        setFormData((prev) => ({ ...prev, password: "", confirmPassword: "" }));
        setAuthMode("login");
        return;
      }

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

        validatePasswordOrThrow(formData.password);

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
    } finally {
      isSubmittingRef.current = false;
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

  function renderPasswordChecklist() {
    return (
      <div
        className="password-requirements-box"
        aria-live="polite"
        style={{
          marginTop: 8,
          marginBottom: 14,
          padding: "10px 12px",
          background: "#F8FAFC",
          border: "1px solid var(--border-light)",
          borderRadius: "var(--radius-sm)",
          fontSize: "0.78rem",
        }}
      >
        <div style={{ fontWeight: 700, color: "var(--text-secondary)", marginBottom: 6 }}>
          Password requirements:
        </div>
        <div
          data-testid="pw-req-length"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: passwordCheck.hasMinLength ? "#15803D" : "var(--text-muted)",
            fontWeight: passwordCheck.hasMinLength ? 600 : 500,
            marginBottom: 4,
          }}
        >
          {passwordCheck.hasMinLength ? (
            <CheckCircle2 size={14} aria-hidden="true" />
          ) : (
            <Circle size={14} aria-hidden="true" />
          )}
          <span>At least 8 characters</span>
        </div>
        <div
          data-testid="pw-req-number"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: passwordCheck.hasNumber ? "#15803D" : "var(--text-muted)",
            fontWeight: passwordCheck.hasNumber ? 600 : 500,
          }}
        >
          {passwordCheck.hasNumber ? (
            <CheckCircle2 size={14} aria-hidden="true" />
          ) : (
            <Circle size={14} aria-hidden="true" />
          )}
          <span>Contains at least one number (0–9)</span>
        </div>
        {formData.confirmPassword && (
          <div
            data-testid="pw-req-match"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginTop: 4,
              color: passwordsMatch ? "#15803D" : "#B91C1C",
              fontWeight: 600,
            }}
          >
            {passwordsMatch ? (
              <CheckCircle2 size={14} aria-hidden="true" />
            ) : (
              <Circle size={14} aria-hidden="true" />
            )}
            <span>{passwordsMatch ? "Passwords match" : "Passwords do not match"}</span>
          </div>
        )}
      </div>
    );
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
              : authMode === "reset-confirm"
              ? "Set a new password"
              : authMode === "signup"
              ? "Create your account"
              : "Welcome back"}
          </h1>
          <p style={{ fontSize: "0.875rem", color: "var(--text-muted)" }}>
            {registeredProfile
              ? "Your account has been created successfully."
              : authMode === "reset-confirm"
              ? "Choose a strong password that meets the security requirements below."
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
                data-testid="registration-code-display"
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
            {authMode !== "reset-confirm" && (
              <>
                {/* Mode Switcher: Sign In vs Create Account */}
                <div className="auth-nav-tabs">
                  <button
                    type="button"
                    disabled={loading}
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
                    disabled={loading}
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
                    disabled={loading}
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
                      cursor: loading ? "not-allowed" : "pointer",
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
                    disabled={loading}
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
                      cursor: loading ? "not-allowed" : "pointer",
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
                      disabled={loading}
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
                        cursor: loading ? "not-allowed" : "pointer",
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
              </>
            )}

            {resetCompleteMsg && (
              <div
                style={{
                  background: "#EAF7EF",
                  color: "#166534",
                  border: "1px solid #BBF7D0",
                  padding: "10px 14px",
                  borderRadius: "var(--radius-sm)",
                  fontSize: "0.85rem",
                  marginBottom: 18,
                }}
              >
                {resetCompleteMsg}
              </div>
            )}

            {error && (
              <div
                role="alert"
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
              {authMode === "reset-confirm" && (
                <>
                  <div className="form-field-group">
                    <label className="form-field-label" htmlFor="reset-password-input">
                      New Password
                    </label>
                    <div style={{ position: "relative" }}>
                      <input
                        id="reset-password-input"
                        type={showPassword ? "text" : "password"}
                        name="password"
                        required
                        minLength={8}
                        disabled={loading}
                        placeholder="At least 8 chars with a number"
                        className="form-field-input"
                        style={{ paddingRight: 40 }}
                        value={formData.password}
                        onChange={handleChange}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((prev) => !prev)}
                        aria-label={showPassword ? "Hide password" : "Show password"}
                        style={{
                          position: "absolute",
                          right: 10,
                          top: "50%",
                          transform: "translateY(-50%)",
                          background: "none",
                          border: "none",
                          color: "var(--text-muted)",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          padding: 4,
                        }}
                      >
                        {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                      </button>
                    </div>
                  </div>

                  <div className="form-field-group">
                    <label className="form-field-label" htmlFor="reset-confirm-password-input">
                      Confirm New Password
                    </label>
                    <div style={{ position: "relative" }}>
                      <input
                        id="reset-confirm-password-input"
                        type={showConfirmPassword ? "text" : "password"}
                        name="confirmPassword"
                        required
                        minLength={8}
                        disabled={loading}
                        placeholder="Re-enter new password"
                        className="form-field-input"
                        style={{ paddingRight: 40 }}
                        value={formData.confirmPassword}
                        onChange={handleChange}
                      />
                      <button
                        type="button"
                        onClick={() => setShowConfirmPassword((prev) => !prev)}
                        aria-label={showConfirmPassword ? "Hide confirm password" : "Show confirm password"}
                        style={{
                          position: "absolute",
                          right: 10,
                          top: "50%",
                          transform: "translateY(-50%)",
                          background: "none",
                          border: "none",
                          color: "var(--text-muted)",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          padding: 4,
                        }}
                      >
                        {showConfirmPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                      </button>
                    </div>
                  </div>

                  {renderPasswordChecklist()}
                </>
              )}

              {authMode === "signup" && (
                <>
                  {/* Corper vs Non-Corper Selection Buttons (Learner mode only) */}
                  {roleTab === "student" && (
                    <div className="corper-selector-group">
                      <button
                        type="button"
                        disabled={loading}
                        className={`corper-select-btn ${studentType === "non_corper" ? "selected" : ""}`}
                        onClick={() => handleTypeSelect("non_corper")}
                      >
                        <User size={18} aria-hidden="true" />
                        <span className="corper-select-label">Non-Corper</span>
                      </button>
                      <button
                        type="button"
                        disabled={loading}
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
                        disabled={loading}
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
                        disabled={loading}
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
                      disabled={loading}
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
                      disabled={loading}
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
                      disabled={loading}
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
                          disabled={loading}
                          className="form-field-input"
                          value={formData.nyscStateCode}
                          onChange={handleChange}
                        />
                      </div>
                    </div>
                  )}

                  {/* Passwords */}
                  <div className="form-grid-2col">
                    <div className="form-field-group" style={{ marginBottom: 6 }}>
                      <label className="form-field-label" htmlFor="signup-password-input">
                        Password
                      </label>
                      <div style={{ position: "relative" }}>
                        <input
                          id="signup-password-input"
                          type={showPassword ? "text" : "password"}
                          name="password"
                          required
                          minLength={8}
                          disabled={loading}
                          placeholder="••••••••"
                          className="form-field-input"
                          style={{ paddingRight: 38 }}
                          value={formData.password}
                          onChange={handleChange}
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((prev) => !prev)}
                          aria-label={showPassword ? "Hide password" : "Show password"}
                          style={{
                            position: "absolute",
                            right: 8,
                            top: "50%",
                            transform: "translateY(-50%)",
                            background: "none",
                            border: "none",
                            color: "var(--text-muted)",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            padding: 4,
                          }}
                        >
                          {showPassword ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
                        </button>
                      </div>
                    </div>
                    <div className="form-field-group" style={{ marginBottom: 6 }}>
                      <label className="form-field-label" htmlFor="signup-confirm-password-input">
                        Confirm
                      </label>
                      <div style={{ position: "relative" }}>
                        <input
                          id="signup-confirm-password-input"
                          type={showConfirmPassword ? "text" : "password"}
                          name="confirmPassword"
                          required
                          minLength={8}
                          disabled={loading}
                          placeholder="••••••••"
                          className="form-field-input"
                          style={{
                            paddingRight: 38,
                            borderColor: passwordsMismatch ? "#DC2626" : undefined,
                          }}
                          value={formData.confirmPassword}
                          onChange={handleChange}
                        />
                        <button
                          type="button"
                          onClick={() => setShowConfirmPassword((prev) => !prev)}
                          aria-label={showConfirmPassword ? "Hide confirm password" : "Show confirm password"}
                          style={{
                            position: "absolute",
                            right: 8,
                            top: "50%",
                            transform: "translateY(-50%)",
                            background: "none",
                            border: "none",
                            color: "var(--text-muted)",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            padding: 4,
                          }}
                        >
                          {showConfirmPassword ? (
                            <EyeOff size={15} aria-hidden="true" />
                          ) : (
                            <Eye size={15} aria-hidden="true" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>

                  {renderPasswordChecklist()}
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
                      disabled={loading}
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
                    <div style={{ position: "relative" }}>
                      <input
                        type={showPassword ? "text" : "password"}
                        name="password"
                        required
                        disabled={loading}
                        placeholder="••••••••"
                        className="form-field-input"
                        style={{ paddingRight: 40 }}
                        value={formData.password}
                        onChange={handleChange}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((prev) => !prev)}
                        aria-label={showPassword ? "Hide password" : "Show password"}
                        style={{
                          position: "absolute",
                          right: 10,
                          top: "50%",
                          transform: "translateY(-50%)",
                          background: "none",
                          border: "none",
                          color: "var(--text-muted)",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          padding: 4,
                        }}
                      >
                        {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                      </button>
                    </div>
                  </div>

                  {/* Inline Forgot-Password Panel */}
                  {showForgotPw && (
                    <div style={{ background: "#FDF2F4", border: "1px solid #F9C6CE", borderRadius: 8, padding: "14px 16px", marginTop: 4 }}>
                      {fpStatus === "sent" ? (
                        <p style={{ fontSize: "0.82rem", color: "#3C181A", fontWeight: 600 }}>
                          ✓ Reset link sent! Check your inbox for <strong>{fpEmail}</strong>. Note: Your new password must be at least 8 characters and include at least one number (0–9).
                        </p>
                      ) : (
                        <>
                          <p style={{ fontSize: "0.8rem", color: "#3C181A", marginBottom: 8 }}>
                            Enter your email to receive a password reset link (minimum 8 characters &amp; 1 number required).
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
                  opacity: loading ? 0.75 : 1,
                  cursor: loading ? "not-allowed" : "pointer",
                  background:
                    roleTab === "admin" && authMode === "login"
                      ? "#0F172A"
                      : roleTab === "tutor"
                      ? "var(--tutor-accent)"
                      : "var(--primary-learner)",
                }}
              >
                {loading
                  ? authMode === "signup"
                    ? "Generating account & code..."
                    : "Processing..."
                  : authMode === "reset-confirm"
                  ? "Update Password →"
                  : authMode === "signup"
                  ? `Create ${roleTab === "tutor" ? "Tutor" : "Student"} Account →`
                  : `Sign In as ${roleTab === "admin" ? "Admin" : roleTab === "tutor" ? "Tutor" : "Student"} →`}
              </button>
            </form>

            <div style={{ textAlign: "center", marginTop: 18, fontSize: "0.85rem", color: "var(--text-muted)" }}>
              {authMode === "reset-confirm" ? (
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode("login");
                    setError("");
                  }}
                  style={{ color: "var(--primary-learner)", fontWeight: 600, background: "none", border: "none", cursor: "pointer" }}
                >
                  ← Back to Sign In
                </button>
              ) : authMode === "signup" ? (
                <>
                  Already have an account?{" "}
                  <button
                    type="button"
                    disabled={loading}
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
                    disabled={loading}
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
                    disabled={loading}
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
