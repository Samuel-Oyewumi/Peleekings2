import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

export default function ProtectedRoute({ children, adminOnly = false }) {
  const { currentUser, userProfile, loading } = useAuth();
  const location = useLocation();

  // Only block render on first-ever visits (no cached session).
  // Returning users: loading starts as false, page renders immediately.
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
          Signing you in…
        </p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // No active session — redirect to auth
  if (!currentUser) {
    // If we have a cached profile but currentUser isn't set yet (onAuthStateChanged
    // hasn't fired), give Firebase a moment before redirecting.
    const hasCachedProfile = (() => {
      try { return !!localStorage.getItem("peleekings_user_profile_cache"); } catch { return false; }
    })();
    if (hasCachedProfile) {
      // Render children optimistically — onAuthStateChanged will correct if session expired
      // This prevents a flash-redirect on page reload for logged-in users
    } else {
      return <Navigate to="/auth" state={{ from: location.pathname }} replace />;
    }
  }

  // adminOnly guard
  const isAdmin = userProfile?.role === "admin" || currentUser?.email?.toLowerCase() === "admin@peleekings.com";
  if (adminOnly && !isAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  return children;
}
