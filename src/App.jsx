import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import Navbar from "./components/Navbar";
import ProtectedRoute from "./components/ProtectedRoute";
import Home from "./pages/Home";
import "./index.css";

// Automatically resets scroll position to top upon route change
function ScrollToTop() {
  const { pathname, hash } = useLocation();

  useEffect(() => {
    if (!hash) {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    }
  }, [pathname, hash]);

  return null;
}

// Lazy-loaded routes to eliminate initial bundle overhead
const Auth = lazy(() => import("./pages/Auth"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const AdminPanel = lazy(() => import("./pages/AdminPanel"));
const CoursePage = lazy(() => import("./pages/CoursePage"));
const TeachingPortal = lazy(() => import("./pages/TeachingPortal"));
const TeachMarketing = lazy(() => import("./pages/TeachMarketing"));
const BecomeInstructor = lazy(() => import("./pages/BecomeInstructor"));
const About = lazy(() => import("./pages/About"));

function PageLoader() {
  return (
    <div style={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: "0.95rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 20, height: 20, border: "2px solid #E2E8F0", borderTopColor: "var(--primary-learner)", borderRadius: "50%", animation: "spin 0.6s linear infinite" }} />
        <span style={{ fontWeight: 500 }}>Loading...</span>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function WithNavbar({ children }) {
  return (
    <>
      <Navbar />
      {children}
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <ScrollToTop />
        <Suspense fallback={<PageLoader />}>
          <Routes>
            {/* Auth page — standalone, no header */}
            <Route path="/auth" element={<Auth />} />

            {/* Public Marketing & Informational Routes */}
            <Route path="/" element={<WithNavbar><Home /></WithNavbar>} />
            <Route path="/about" element={<WithNavbar><About /></WithNavbar>} />
            <Route path="/teach" element={<WithNavbar><TeachMarketing /></WithNavbar>} />

            {/* Teaching Portal (Handles both Application form for students and Teaching Portal for tutors/admins) */}
            <Route
              path="/teach-portal"
              element={<ProtectedRoute><TeachingPortal /></ProtectedRoute>}
            />
            <Route
              path="/become-instructor"
              element={<ProtectedRoute><BecomeInstructor /></ProtectedRoute>}
            />

            {/* Learner Portal Routes */}
            <Route
              path="/dashboard"
              element={<ProtectedRoute><WithNavbar><Dashboard /></WithNavbar></ProtectedRoute>}
            />
            <Route
              path="/course/:id"
              element={<ProtectedRoute><WithNavbar><CoursePage /></WithNavbar></ProtectedRoute>}
            />

            {/* Administrator Console */}
            <Route
              path="/admin"
              element={<ProtectedRoute adminOnly><WithNavbar><AdminPanel /></WithNavbar></ProtectedRoute>}
            />

            {/* Fallback route */}
            <Route path="*" element={<WithNavbar><Home /></WithNavbar>} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
  );
}
