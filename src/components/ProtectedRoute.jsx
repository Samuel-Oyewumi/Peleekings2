import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

/**
 * ProtectedRoute:
 * Strict session and Custom Claim authorization guard.
 * Does NOT render optimistically from cache.
 * Always awaits verified authentication and claims verification.
 */
export default function ProtectedRoute({ children, adminOnly = false, tutorOnly = false }) {
  const { currentUser, isAdmin, isTutor, isSuspended, suspensionReason, logout, loading } = useAuth();
  const location = useLocation();

  // Always wait for Firebase Auth and Custom Claims verification
  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: 14,
          color: "var(--text-muted)",
          fontFamily: "var(--font-sans)",
          background: "var(--bg-main)",
        }}
      >
        <div
          style={{
            width: 34,
            height: 34,
            border: "3px solid rgba(86, 36, 208, 0.15)",
            borderTopColor: "var(--primary-learner)",
            borderRadius: "50%",
            animation: "spin 0.7s linear infinite",
          }}
        />
        <p style={{ fontSize: "0.875rem", fontWeight: 500 }}>
          Verifying security session…
        </p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // No verified authentication session
  if (!currentUser) {
    return <Navigate to="/auth" state={{ from: location.pathname }} replace />;
  }

  // Account suspension guard: suspended accounts are blocked from accessing protected portals
  if (isSuspended && !isAdmin) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: 16,
          padding: 24,
          textAlign: "center",
          color: "var(--text-primary)",
          fontFamily: "var(--font-sans)",
          background: "var(--bg-main)",
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: "50%",
            background: "#FEE2E2",
            color: "#DC2626",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "1.75rem",
          }}
        >
          ⚠️
        </div>
        <h2 style={{ fontSize: "1.5rem", fontWeight: 800, margin: 0 }}>
          Account Suspended
        </h2>
        <p style={{ maxWidth: 460, color: "var(--text-muted)", fontSize: "0.95rem", lineHeight: 1.5, margin: 0 }}>
          {suspensionReason || "Your account has been suspended by administration. If you believe this is an error, please reach out to academic support."}
        </p>
        <div style={{ marginTop: 8 }}>
          <button
            onClick={logout}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: "1px solid var(--border-light)",
              background: "#FFFFFF",
              color: "var(--text-primary)",
              fontWeight: 600,
              fontSize: "0.875rem",
              cursor: "pointer",
            }}
          >
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  // Admin access guard: requires verified claims.admin === true
  if (adminOnly && !isAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  // Tutor access guard: requires verified claims.tutor === true or claims.admin === true
  if (tutorOnly && !isTutor) {
    return <Navigate to="/dashboard" replace />;
  }

  return children;
}
