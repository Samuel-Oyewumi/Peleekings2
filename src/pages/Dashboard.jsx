import { useState, useEffect } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { getUserActivity, submitAssignment, getUserEnrollments, enrollInCourse, getWeeklyActivityData, incrementDailyActivity } from "../contexts/userActivity";
import { COURSES_CATALOG } from "../data/courses";
import { doc, setDoc, getDocs, collection } from "firebase/firestore";
import { db } from "../firebase";

function computeUserRegCode(profile, uid) {
  if (profile?.regNumber && profile.regNumber !== "Pending assignment") {
    return profile.regNumber;
  }
  const nameParts = (profile?.fullName || profile?.displayName || "Learner").trim().split(/\s+/);
  const sInit = (profile?.surname?.[0] || (nameParts.length > 1 ? nameParts[0][0] : "P")).toUpperCase();
  const fInit = (profile?.firstName?.[0] || (nameParts.length > 1 ? nameParts[1][0] : "K")).toUpperCase();

  if (profile?.studentType === "corper" && profile?.nyscStateCode) {
    const raw = profile.nyscStateCode.replace(/\D/g, "");
    if (raw.length >= 4) return `${sInit}${fInit}${raw.slice(-4)}`;
  }

  const seedStr = uid || profile?.email || "peleekings";
  const num = 1000 + Math.abs(seedStr.split("").reduce((acc, c) => acc + c.charCodeAt(0) * 19, 0) % 9000);
  return profile?.studentType === "corper" ? `${sInit}${fInit}${num}` : `${num}${fInit}${sInit}`;
}

export default function Dashboard() {
  const { currentUser, userProfile, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [activeNav, setActiveNav] = useState("dashboard");
  const [showMobileSidebar, setShowMobileSidebar] = useState(false);
  const [showPathModal, setShowPathModal] = useState(false);
  const [toastMessage, setToastMessage] = useState(location.state?.welcomeToast || "");
  const [showTutorBanner, setShowTutorBanner] = useState(location.state?.showTutorBanner || false);
  // Browse Courses tab state
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogFilter, setCatalogFilter] = useState("All");
  const [enrollingId, setEnrollingId] = useState(null);
  const [allCoursesList, setAllCoursesList] = useState(COURSES_CATALOG);

  // Auto-dismiss welcome toast after 4 seconds
  useEffect(() => {
    if (toastMessage) {
      const timer = setTimeout(() => {
        setToastMessage("");
        try {
          window.history.replaceState({}, document.title);
        } catch {}
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [toastMessage]);

  const isNonCorper = userProfile?.studentType === "non_corper";
  const userName = userProfile?.fullName || currentUser?.displayName || currentUser?.email?.split("@")[0] || "Learner";
  const firstName = userProfile?.firstName || (userName.split(" ").length > 1 ? userName.split(" ")[0] : userName) || "Learner";
  const regCode = computeUserRegCode(userProfile, currentUser?.uid);
  const email = currentUser?.email || userProfile?.email || "";
  const nyscCode = isNonCorper ? "Not Applicable (Non-Corper)" : (userProfile?.nyscStateCode || "Not provided");

  // Sync valid regNumber to Firestore if missing or was set to 'Pending assignment'
  useEffect(() => {
    if (currentUser?.uid && (!userProfile?.regNumber || userProfile.regNumber === "Pending assignment")) {
      const generated = computeUserRegCode(userProfile, currentUser.uid);
      if (generated) {
        setDoc(doc(db, "users", currentUser.uid), { regNumber: generated }, { merge: true }).catch(() => {});
      }
    }
  }, [currentUser?.uid, userProfile?.regNumber]);

  function triggerToast(msg) {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(""), 3500);
  }

  const [userActivity, setUserActivity] = useState(() => getUserActivity(currentUser?.uid));
  const [liveEnrollments, setLiveEnrollments] = useState([]);
  const [weeklyActivityLive, setWeeklyActivityLive] = useState(null);

  // Load live weekly activity
  useEffect(() => {
    if (!currentUser?.uid) return;

    function refreshActivity() {
      getWeeklyActivityData(currentUser.uid).then((data) => {
        if (data) setWeeklyActivityLive(data);
      });
    }

    refreshActivity();

    // Listen for instant increments from anywhere in the app
    function onActivityIncremented(e) {
      if (e.detail?.uid === currentUser.uid) {
        refreshActivity();
      }
    }
    window.addEventListener("peleekings_activity_incremented", onActivityIncremented);

    // Track active time: increment every 60 seconds while Dashboard is open
    const activityInterval = setInterval(() => {
      incrementDailyActivity(currentUser.uid, 1);
    }, 60000);

    return () => {
      clearInterval(activityInterval);
      window.removeEventListener("peleekings_activity_incremented", onActivityIncremented);
    };
  }, [currentUser?.uid]);

  useEffect(() => {
    setUserActivity(getUserActivity(currentUser?.uid));
    function handleUpdate(e) {
      if (e.detail?.userId === currentUser?.uid) {
        setUserActivity(e.detail.data);
      }
    }
    window.addEventListener("peleekings_activity_updated", handleUpdate);
    return () => window.removeEventListener("peleekings_activity_updated", handleUpdate);
  }, [currentUser]);

  // Load live Firestore courses (created by instructors/admins) and merge with catalog
  useEffect(() => {
    async function loadDynamicCourses() {
      try {
        const snap = await getDocs(collection(db, "courses"));
        if (!snap.empty) {
          const fromDb = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          const combined = [
            ...fromDb,
            ...COURSES_CATALOG.filter((c) => !fromDb.some((fc) => fc.id === c.id)),
          ];
          setAllCoursesList(combined);
        }
      } catch (err) {
        console.warn("Notice: could not load dynamic courses from Firestore:", err);
      }
    }
    loadDynamicCourses();
  }, []);

  useEffect(() => {
    if (!currentUser?.uid) return;
    getUserEnrollments(currentUser.uid)
      .then((enrollments) => {
        if (enrollments && enrollments.length > 0) {
          const mapped = enrollments.map((enr) => {
            const catalogItem = allCoursesList.find((c) => c.id === enr.courseId) || COURSES_CATALOG.find((c) => c.id === enr.courseId) || {};
            return {
              id: enr.courseId,
              title: catalogItem.title || enr.courseTitle || enr.courseId,
              type: enr.experienceType === "hands-on" ? "Hands-on Practical" : "Online",
              progress: enr.progressPercent || 0,
              currentModule: `${(enr.completedItemIds || []).length} lessons completed`,
              image:
                catalogItem.image ||
                "https://images.unsplash.com/photo-1677442136019-21780ecad995?w=500&auto=format&fit=crop&q=80",
              enrolledAt: enr.enrolledAt?.toDate ? enr.enrolledAt.toDate().toISOString() : new Date().toISOString(),
            };
          });
          setLiveEnrollments(mapped);
        }
      })
      .catch((err) => console.warn("Could not fetch live enrollments:", err));
  }, [currentUser, allCoursesList]);

  // Active courses enrolled: prioritize live Firestore enrollments, fall back to cached
  const enrolledCourses = liveEnrollments.length > 0 ? liveEnrollments : (userActivity?.enrolledCourses || []);

  const weeklyActivityData = weeklyActivityLive || userActivity?.weeklyActivity || [
    { day: "Mon", hours: 4, label: "0m" },
    { day: "Tue", hours: 4, label: "0m" },
    { day: "Wed", hours: 4, label: "0m" },
    { day: "Thu", hours: 4, label: "0m" },
    { day: "Fri", hours: 4, label: "0m" },
    { day: "Sat", hours: 4, label: "0m" },
    { day: "Sun", hours: 4, label: "0m" },
  ];

  // Compute total minutes from live data
  const totalWeeklyMinutes = weeklyActivityLive
    ? weeklyActivityLive.reduce((sum, d) => sum + (d.minutes || 0), 0)
    : null;
  const totalWeeklyLabel = totalWeeklyMinutes != null
    ? (totalWeeklyMinutes === 0 ? "0m this week"
      : totalWeeklyMinutes < 60 ? `${totalWeeklyMinutes}m this week`
      : `${Math.floor(totalWeeklyMinutes / 60)}h ${totalWeeklyMinutes % 60 > 0 ? totalWeeklyMinutes % 60 + "m" : ""}`.trim() + " this week")
    : "4h 32m";

  const DEFAULT_ASSIGNMENTS = [
    {
      id: "ass-1",
      title: "Zapier Automated Pipeline Architecture",
      course: "AI Essentials & Automation",
      due: "Fri, Oct 24 • 6:00 PM",
      status: "Pending Submission",
      badge: "pill-audio",
      description: "Design and implement an automated workflow integrating a webhook trigger with an AI agent or multi-step action. Submit your architecture blueprint as a PDF or export file."
    },
    {
      id: "ass-2",
      title: "Visual Brand Identity Mockup in Figma",
      course: "Graphic Design Fundamentals",
      due: "Mon, Oct 27 • 11:59 PM",
      status: "Pending Submission",
      badge: "pill-tech",
      description: "Create a complete visual style guide including color palette, typography hierarchy, and a mobile/desktop component set. Submit your Figma link or exported assets."
    },
    {
      id: "ass-3",
      title: "Organic Social Media Campaign Blueprint",
      course: "Social Media Management",
      due: "Nov 02 • 5:00 PM",
      status: "Pending Submission",
      badge: "pill-tech",
      description: "Draft a 30-day content calendar, hook scripts, and audience distribution plan for a target client. Submit as a document or spreadsheet."
    }
  ];

  const [activeUploadAssignment, setActiveUploadAssignment] = useState(null);
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadLink, setUploadLink] = useState("");
  const [uploadNotes, setUploadNotes] = useState("");
  const [isSubmittingAssignment, setIsSubmittingAssignment] = useState(false);

  const userSubmissions = userActivity?.assignmentSubmissions || {};

  const assignments = DEFAULT_ASSIGNMENTS.map(item => {
    const submission = userSubmissions[item.id];
    if (submission) {
      return {
        ...item,
        status: "Submitted (Under Review)",
        badge: "pill-success",
        submission
      };
    }
    return item;
  });

  async function handleAssignmentUploadSubmit(e) {
    e.preventDefault();
    if (!uploadFile && !uploadLink.trim()) {
      alert("Please choose a file to upload or provide a project link.");
      return;
    }

    setIsSubmittingAssignment(true);

    try {
      const submissionData = {
        file: uploadFile || null,
        fileName: uploadFile ? uploadFile.name : null,
        fileSize: uploadFile ? `${(uploadFile.size / 1024).toFixed(1)} KB` : null,
        fileType: uploadFile ? uploadFile.type : null,
        projectLink: uploadLink.trim() || null,
        notes: uploadNotes.trim() || null,
        submittedAt: new Date().toISOString(),
        studentName: userName,
        studentEmail: email,
      };

      await submitAssignment(currentUser?.uid, activeUploadAssignment.id, submissionData);
      triggerToast(`Assignment "${activeUploadAssignment.title}" submitted successfully!`);
      setActiveUploadAssignment(null);
      setUploadFile(null);
      setUploadLink("");
      setUploadNotes("");
    } catch (err) {
      console.error("Assignment submission error:", err);
      triggerToast("Failed to submit assignment. Please try again.");
    } finally {
      setIsSubmittingAssignment(false);
    }
  }

  async function handleLogout() {
    await logout();
    navigate("/");
  }

  return (
    <div className="dashboard-page-layout">
      {/* Toast banner with close button and auto-dismiss */}
      {toastMessage && (
        <div style={{
          position: "fixed",
          top: 80,
          right: 24,
          zIndex: 1000,
          background: "#0F172A",
          color: "#FFFFFF",
          padding: "12px 18px",
          borderRadius: "var(--radius-sm)",
          boxShadow: "var(--shadow-lg)",
          fontSize: "0.875rem",
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          gap: 12
        }}>
          <span>{toastMessage}</span>
          <button
            onClick={() => {
              setToastMessage("");
              try { window.history.replaceState({}, document.title); } catch {}
            }}
            style={{
              background: "transparent",
              border: "none",
              color: "#94A3B8",
              cursor: "pointer",
              fontSize: "1rem",
              lineHeight: 1,
              padding: "0 4px"
            }}
            title="Close"
          >
            ✕
          </button>
        </div>
      )}
      {/* Mobile Drawer Backdrop */}
      {showMobileSidebar && (
        <div
          className="portal-sidebar-backdrop"
          onClick={() => setShowMobileSidebar(false)}
          aria-label="Close menu"
        />
      )}

      {/* ── Left Sidebar (Screen 5) ─────────────────────────────────── */}
      <aside className={`portal-left-sidebar ${showMobileSidebar ? "mobile-open" : ""}`}>
        {/* Mobile-only close header */}
        <div className="sidebar-mobile-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div className="brand-logo-icon" style={{ width: 28, height: 28, fontSize: "0.9rem" }}>P</div>
            <span style={{ fontWeight: 800, fontSize: "1rem" }}>Peleekings</span>
          </div>
          <button
            type="button"
            className="sidebar-close-btn"
            onClick={() => setShowMobileSidebar(false)}
            aria-label="Close navigation"
          >
            ✕
          </button>
        </div>

        {/* User Card */}
        <div className="sidebar-user-card">
          <div className="user-avatar-circle">
            {currentUser?.photoURL ? (
              <img src={currentUser.photoURL} alt="Avatar" style={{ width: "100%", height: "100%", borderRadius: "50%", objectFit: "cover" }} />
            ) : (
              userName.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase()
            )}
          </div>
          <div style={{ overflow: "hidden" }}>
            <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "var(--text-primary)", whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
              {userName}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className={`pill-badge ${userProfile?.studentType === "non_corper" ? "pill-creative" : "pill-tech"}`} style={{ padding: "2px 8px", fontSize: "0.68rem" }}>
                {userProfile?.studentType === "non_corper" ? "Non-Corper" : "Corper"}
              </span>
              {regCode && regCode !== "Pending assignment" ? (
                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", fontWeight: 600 }}>
                  {regCode}
                </span>
              ) : null}
            </div>
          </div>
        </div>

        {/* Navigation Menu */}
        <nav className="portal-nav-menu">
          {[
            { id: "dashboard", label: "Dashboard", icon: "📊" },
            { id: "my-courses", label: "My Courses", icon: "📚" },
            { id: "browse-courses", label: "Browse Courses", icon: "🔍" },
            { id: "assignments", label: "Assignments", icon: "📝" },
            { id: "tests", label: "Tests", icon: "⏱" },
            { id: "notes", label: "Notes", icon: "📄" },
            { id: "announcements", label: "Announcements", icon: "📢" },
            { id: "certificates", label: "Certificates", icon: "🎓" },
            { id: "profile", label: "Profile", icon: "👤" },
          ].map(item => (
            <button
              key={item.id}
              className={`portal-nav-link ${activeNav === item.id ? "active" : ""}`}
              onClick={() => {
                setShowMobileSidebar(false);
                if (item.action) item.action();
                else setActiveNav(item.id);
              }}
            >
              <span>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        {/* Switch Portal & Logout */}
        <div style={{ marginTop: "auto", borderTop: "1px solid var(--border-light)", paddingTop: 16 }}>
          <Link
            to="/become-instructor"
            className="portal-nav-link"
            style={{ fontSize: "0.85rem", color: "var(--primary-learner)", marginBottom: 4 }}
          >
            <span>💼</span> Teaching Portal
          </Link>
          <button
            onClick={handleLogout}
            className="portal-nav-link"
            style={{ color: "#DC2626", width: "100%" }}
          >
            <span>⎋</span> Log out
          </button>
        </div>
      </aside>

      {/* ── Main Dashboard Content ─────────────────────────────────── */}
      <main className="dashboard-main-area" style={{ paddingBottom: 80 }}>
        {/* Top Header / Greeting */}
        <div className="dashboard-greeting-row">
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button
                type="button"
                className="btn btn-outline btn-sm mobile-sidebar-toggle-btn"
                onClick={() => setShowMobileSidebar(prev => !prev)}
                aria-label="Open menu"
              >
                ☰
              </button>
              <div>
                <h1 style={{ fontSize: "1.9rem", fontWeight: 800, marginBottom: 2 }}>
                  Good morning, {firstName} &#128075;
                </h1>
                <p style={{ color: "var(--text-secondary)", fontSize: "0.95rem", margin: 0 }}>
                  Ready to continue learning today?
                </p>
              </div>
            </div>
          </div>
          <div style={{ fontSize: "0.875rem", color: "var(--text-muted)", fontWeight: 500, background: "#FFFFFF", border: "1px solid var(--border-light)", padding: "8px 16px", borderRadius: "var(--radius-full)" }}>
            {new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "short", day: "numeric" })}
          </div>
        </div>


        {/* Stage 6: Dismissible Tutor Apply Banner */}
        {showTutorBanner && (
          <div
            style={{
              background: "#F3EEFC",
              border: "1px solid #D8C7F8",
              borderRadius: "10px",
              padding: "14px 20px",
              marginBottom: 20,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 16,
            }}
          >
            <div style={{ fontSize: "0.9rem", color: "#5624D0" }}>
              <strong>Want to teach on Peleekings?</strong> Share your expertise with hundreds of students.{" "}
              <Link to="/teach" style={{ color: "#5624D0", fontWeight: 700, textDecoration: "underline" }}>
                Apply here &rarr;
              </Link>
            </div>
            <button
              onClick={() => setShowTutorBanner(false)}
              style={{
                background: "none",
                border: "none",
                color: "#5624D0",
                cursor: "pointer",
                fontSize: "1.1rem",
                lineHeight: 1,
                padding: "4px 8px",
              }}
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        )}

        {/* ── TAB: OVERVIEW / DASHBOARD ──────────────────────────────── */}
        {activeNav === "dashboard" && (
          <>
            {/* ── DARK HERO: Continue where you left off ── */}
            <div style={{
              background: "linear-gradient(135deg, #0F172A 60%, #1a2744 100%)",
              borderRadius: "var(--radius-md)",
              padding: "32px 28px",
              marginBottom: 24,
              display: "grid",
              gridTemplateColumns: enrolledCourses.length > 0 ? "1fr auto" : "1fr",
              gap: 24,
              alignItems: "stretch",
              minHeight: 200,
            }}>
              {/* Left: Course info */}
              <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#22C55E", display: "inline-block" }} />
                    <span style={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "#22C55E" }}>
                      {enrolledCourses.length > 0 ? "Continue where you left off" : "Ready to start?"}
                    </span>
                  </div>
                  <h2 style={{ fontSize: "2rem", fontWeight: 800, color: "#FFFFFF", marginBottom: 6, lineHeight: 1.15 }}>
                    {enrolledCourses.length > 0 ? enrolledCourses[0].title : "Explore Courses"}
                  </h2>
                  <p style={{ fontSize: "0.9rem", color: "#94A3B8", marginBottom: 20 }}>
                    {enrolledCourses.length > 0 ? enrolledCourses[0].currentModule : "Enroll in a course to begin your learning journey."}
                  </p>
                </div>

                {enrolledCourses.length > 0 && (
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", color: "#94A3B8", marginBottom: 6 }}>
                      <span>Course progress</span>
                      <span style={{ color: "#22C55E", fontWeight: 700 }}>{enrolledCourses[0].progress}%</span>
                    </div>
                    <div style={{ width: "100%", height: 6, background: "rgba(255,255,255,0.12)", borderRadius: 99, overflow: "hidden", marginBottom: 20 }}>
                      <div style={{ width: `${enrolledCourses[0].progress}%`, height: "100%", background: "#22C55E", borderRadius: 99, transition: "width 0.6s ease" }} />
                    </div>
                  </div>
                )}

                <button
                  className="btn btn-sm"
                  style={{
                    alignSelf: "flex-start",
                    background: "#22C55E",
                    color: "#FFFFFF",
                    border: "none",
                    borderRadius: 8,
                    fontWeight: 700,
                    padding: "10px 22px",
                    fontSize: "0.9rem",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                  onClick={() => enrolledCourses.length > 0
                    ? navigate(`/course/${enrolledCourses[0].id}`, { state: { classroom: true } })
                    : setActiveNav("browse-courses")
                  }
                >
                  ▶ {enrolledCourses.length > 0 ? "Start learning" : "Browse courses"}
                </button>
              </div>

              {/* Right: Next upcoming deadline panel */}
              {enrolledCourses.length > 0 && (
                <div style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 12,
                  padding: "20px 22px",
                  minWidth: 220,
                  maxWidth: 270,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "#22C55E" }}>📋 Upcoming deadline</span>
                  </div>
                  <div style={{ fontWeight: 800, fontSize: "1.05rem", color: "#FFFFFF", lineHeight: 1.3 }}>
                    Assignment Due
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.8rem", color: "#94A3B8" }}>
                    <span>⏰</span>
                    <span>Fri, Oct 24 • 6:00 PM</span>
                  </div>
                  <div style={{ fontSize: "0.78rem", color: "#64748B", marginTop: 8, lineHeight: 1.5 }}>
                    Submit your project link or file before the deadline to get graded.
                  </div>
                </div>
              )}
            </div>

            {/* ── COMPACT INTERACTIVE STAT CARDS ── */}
            <div className="dashboard-stats-grid">
              {/* Card 1: Course Progress (Green Accent) */}
              <div className="incubator-stat-card card-green" onClick={() => setActiveNav("my-courses")}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                  <div className="stat-card-icon-box icon-green">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline>
                      <polyline points="17 6 23 6 23 12"></polyline>
                    </svg>
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.1, letterSpacing: "-0.02em" }}>
                    {enrolledCourses.length > 0 ? `${enrolledCourses[0].progress}%` : "0%"}
                  </div>
                  <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: 4, fontWeight: 500 }}>
                    Course progress
                  </div>
                </div>
              </div>

              {/* Card 2: Enrolled Courses (Amber Accent) */}
              <div className="incubator-stat-card card-amber" onClick={() => setActiveNav("my-courses")}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                  <div className="stat-card-icon-box icon-amber">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
                      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
                    </svg>
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.1, letterSpacing: "-0.02em" }}>
                    {enrolledCourses.length}
                  </div>
                  <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: 4, fontWeight: 500 }}>
                    {enrolledCourses.length === 1 ? "Course enrolled" : "Courses enrolled"}
                  </div>
                </div>
              </div>

              {/* Card 3: Assignments Pending (Indigo Accent) */}
              <div className="incubator-stat-card card-indigo" onClick={() => setActiveNav("assignments")}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                  <div className="stat-card-icon-box icon-indigo">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"></circle>
                      <path d="M8 12l2.5 2.5L16 9"></path>
                    </svg>
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.1, letterSpacing: "-0.02em" }}>
                    {DEFAULT_ASSIGNMENTS.length - Object.keys(userSubmissions).length}
                  </div>
                  <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: 4, fontWeight: 500 }}>
                    Assignments pending
                  </div>
                </div>
              </div>
            </div>

            {/* ── "Not the right course?" row ── */}
            <div style={{
              background: "#FFFFFF",
              border: "1px solid var(--border-light)",
              borderRadius: "var(--radius-md)",
              padding: "18px 22px",
              marginBottom: 28,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              cursor: "pointer",
            }}
              onClick={() => setActiveNav("browse-courses")}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: "#F1F5F9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.1rem" }}>⇄</div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "var(--text-primary)" }}>Looking for a different course?</div>
                  <div style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}>Browse the full catalog and enroll in any course that fits your goals.</div>
                </div>
              </div>
              <span style={{ fontSize: "1.1rem", color: "var(--text-muted)" }}>→</span>
            </div>

            {/* ── QUICK ACCESS ── */}
            <div style={{ marginBottom: 32 }}>
              <div style={{ fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 14 }}>
                Quick Access
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {[
                  { icon: "🎬", label: "My Courses", sub: "Resume your learning", color: "#FEE2E2", nav: "my-courses" },
                  { icon: "📝", label: "Assignments", sub: "View pending submissions", color: "#FEF3C7", nav: "assignments" },
                  { icon: "📄", label: "Notes & Resources", sub: "Course materials and tools", color: "#EEF2FF", nav: "notes" },
                  { icon: "⏱", label: "Tests", sub: "Check scheduled tests", color: "#F0FDF4", nav: "tests" },
                  { icon: "📢", label: "Announcements", sub: "Latest from instructors", color: "#FFF7ED", nav: "announcements" },
                  { icon: "🎓", label: "Certificates", sub: "View your achievements", color: "#F5F3FF", nav: "certificates" },
                ].map(item => (
                  <button
                    key={item.nav}
                    onClick={() => setActiveNav(item.nav)}
                    style={{
                      background: "#FFFFFF",
                      border: "1px solid var(--border-light)",
                      borderRadius: "var(--radius-md)",
                      padding: "16px 20px",
                      textAlign: "left",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 16,
                      width: "100%",
                      transition: "box-shadow 0.15s ease",
                    }}
                    onMouseEnter={e => { e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.07)"; }}
                    onMouseLeave={e => { e.currentTarget.style.boxShadow = "none"; }}
                  >
                    <div style={{ width: 48, height: 48, borderRadius: 12, background: item.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.3rem", flexShrink: 0 }}>
                      {item.icon}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "var(--text-primary)", marginBottom: 2 }}>{item.label}</div>
                      <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{item.sub}</div>
                    </div>
                    <span style={{ fontSize: "1rem", color: "var(--text-muted)" }}>›</span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* ── TAB: MY COURSES ────────────────────────────────────────── */}
        {activeNav === "my-courses" && (
          <div className="dashboard-tab-panel">
            <h2 style={{ fontSize: "1.5rem", fontWeight: 800, marginBottom: 6 }}>My Enrolled Courses</h2>
            <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: 24 }}>Manage your active learning modules and track progress.</p>
            <div className="dashboard-catalog-grid">
              {enrolledCourses.map(c => (
                <div key={c.id} style={{ border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", overflow: "hidden", background: "#F8FAFC" }}>
                  <img src={c.image} alt={c.title} style={{ width: "100%", height: 140, objectFit: "cover" }} />
                  <div style={{ padding: 16 }}>
                    <span className="pill-badge pill-tech" style={{ marginBottom: 6 }}>{c.type}</span>
                    <h3 style={{ fontSize: "1.05rem", fontWeight: 700, marginBottom: 6 }}>{c.title}</h3>
                    <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 12 }}>{c.currentModule}</div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", fontWeight: 600, marginBottom: 4 }}>
                      <span>Progress</span>
                      <span>{c.progress}%</span>
                    </div>
                    <div style={{ width: "100%", height: 6, background: "#E2E8F0", borderRadius: 99, marginBottom: 16 }}>
                      <div style={{ width: `${c.progress}%`, height: "100%", background: "var(--primary-learner)", borderRadius: 99 }} />
                    </div>
                    <button className="btn btn-solid-dark btn-sm" style={{ width: "100%" }} onClick={() => navigate(`/course/${c.id}`)}>
                      Resume Course &rarr;
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── TAB: BROWSE COURSES ─────────────────────────────────────── */}
        {activeNav === "browse-courses" && (() => {
          const enrolledIds = new Set(liveEnrollments.map(e => e.id));
          const categories = ["All", ...Array.from(new Set(allCoursesList.map(c => c.category).filter(Boolean)))];
          const filtered = allCoursesList.filter(c => {
            const matchCat = catalogFilter === "All" || c.category === catalogFilter;
            const q = catalogSearch.toLowerCase();
            const matchQ = !q || c.title?.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q) || c.badge?.toLowerCase().includes(q);
            return matchCat && matchQ;
          });

          async function handleEnrollFromDashboard(course) {
            if (!currentUser?.uid) return;
            setEnrollingId(course.id);
            try {
              await enrollInCourse(currentUser.uid, course.id, "online");
              // Refresh live enrollments
              const updated = await getUserEnrollments(currentUser.uid);
              if (updated && updated.length > 0) {
                setLiveEnrollments(updated.map(enr => {
                  const cat = COURSES_CATALOG.find(c => c.id === enr.courseId) || {};
                  return {
                    id: enr.courseId,
                    title: cat.title || enr.courseTitle || enr.courseId,
                    type: enr.experienceType === "hands-on" ? "Hands-on Practical" : "Online",
                    progress: enr.progressPercent || 0,
                    currentModule: `${(enr.completedItemIds || []).length} lessons completed`,
                    image: cat.image || "https://images.unsplash.com/photo-1677442136019-21780ecad995?w=500&auto=format&fit=crop&q=80",
                    enrolledAt: enr.enrolledAt?.toDate ? enr.enrolledAt.toDate().toISOString() : new Date().toISOString(),
                  };
                }));
              }
              triggerToast(`🎉 Enrolled in "${course.title}"! Go to My Courses to start learning.`);
            } catch (err) {
              console.error(err);
              triggerToast("Enrollment failed. Please try again.");
            } finally {
              setEnrollingId(null);
            }
          }

          return (
            <div className="dashboard-tab-panel">
              <div className="dashboard-browse-header">
                <div>
                  <h2 style={{ fontSize: "1.5rem", fontWeight: 800, marginBottom: 6 }}>Browse All Courses</h2>
                  <p style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}>Enroll in any course directly from your dashboard.</p>
                </div>
                <input
                  type="text"
                  placeholder="Search courses…"
                  value={catalogSearch}
                  onChange={e => setCatalogSearch(e.target.value)}
                  className="form-field-input dashboard-catalog-search"
                />
              </div>

              {/* Category filters */}
              <div className="filter-pills-row" style={{ marginBottom: 24 }}>
                {categories.map(cat => (
                  <button
                    key={cat}
                    onClick={() => setCatalogFilter(cat)}
                    style={{
                      padding: "6px 14px",
                      borderRadius: 999,
                      fontSize: "0.82rem",
                      fontWeight: 600,
                      border: "1px solid var(--border-light)",
                      cursor: "pointer",
                      background: catalogFilter === cat ? "var(--primary-learner)" : "#FFFFFF",
                      color: catalogFilter === cat ? "#FFFFFF" : "var(--text-secondary)",
                      transition: "all 0.15s",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {cat}
                  </button>
                ))}
              </div>

              {/* Course cards grid */}
              <div className="dashboard-catalog-grid">
                {filtered.map(course => {
                  const isEnrolled = enrolledIds.has(course.id);
                  const isEnrolling = enrollingId === course.id;
                  return (
                    <div key={course.id} style={{ border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", overflow: "hidden", background: "#FFFFFF", display: "flex", flexDirection: "column" }}>
                      <div style={{ height: 140, overflow: "hidden", position: "relative" }}>
                        <img src={course.image} alt={course.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        <span className={`pill-badge ${course.badgeClass || "pill-tech"}`} style={{ position: "absolute", top: 10, left: 10, fontSize: "0.7rem" }}>
                          {course.badge}
                        </span>
                      </div>
                      <div style={{ padding: 16, flex: 1, display: "flex", flexDirection: "column" }}>
                        <h3 style={{ fontSize: "0.975rem", fontWeight: 700, marginBottom: 6, lineHeight: 1.35 }}>{course.title}</h3>
                        <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", lineHeight: 1.5, flex: 1, marginBottom: 14 }}>
                          {course.description?.slice(0, 90)}{course.description?.length > 90 ? "…" : ""}
                        </p>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: 14 }}>
                          <span>⏱ {course.duration}</span>
                          <span>📦 {course.modulesCount} modules</span>
                          <span>⭐ {course.rating}</span>
                        </div>
                        {isEnrolled ? (
                          <button
                            className="btn btn-outline btn-sm"
                            style={{ width: "100%" }}
                            onClick={() => navigate(`/course/${course.id}`, { state: { classroom: true } })}
                          >
                            ✓ Continue Learning →
                          </button>
                        ) : (
                          <button
                            className="btn btn-solid-dark btn-sm"
                            style={{ width: "100%" }}
                            disabled={isEnrolling}
                            onClick={() => handleEnrollFromDashboard(course)}
                          >
                            {isEnrolling ? "Enrolling…" : "Enroll Now →"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* ── TAB: ASSIGNMENTS ───────────────────────────────────────── */}
        {activeNav === "assignments" && (
          <div className="dashboard-tab-panel">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16, marginBottom: 24 }}>
              <div>
                <h2 style={{ fontSize: "1.5rem", fontWeight: 800, marginBottom: 6 }}>Assignments &amp; Projects</h2>
                <p style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}>Submit required course deliverables, upload practical projects, and track instructor reviews.</p>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="pill-badge pill-tech" style={{ padding: "6px 12px", fontSize: "0.8rem" }}>
                  {Object.keys(userSubmissions).length} of {DEFAULT_ASSIGNMENTS.length} Submitted
                </span>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {assignments.map((ass) => (
                <div
                  key={ass.id}
                  style={{
                    padding: 22,
                    border: "1px solid var(--border-light)",
                    borderRadius: "var(--radius-md)",
                    background: ass.submission ? "#F0FDF4" : "#F8FAFC",
                    display: "flex",
                    flexDirection: "column",
                    gap: 14,
                    transition: "border-color 0.2s"
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                        <span className={`pill-badge ${ass.badge}`}>{ass.status}</span>
                        <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{ass.course}</span>
                      </div>
                      <h3 style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--text-primary)" }}>{ass.title}</h3>
                      <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginTop: 6, maxWidth: 680, lineHeight: 1.5 }}>
                        {ass.description}
                      </p>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
                      <span style={{ fontSize: "0.78rem", color: "var(--text-muted)", fontWeight: 500 }}>Due: {ass.due}</span>
                      <button
                        className={`btn ${ass.submission ? "btn-outline" : "btn-solid-dark"} btn-sm`}
                        onClick={() => {
                          setActiveUploadAssignment(ass);
                          setUploadFile(null);
                          setUploadLink(ass.submission?.projectLink || "");
                          setUploadNotes(ass.submission?.notes || "");
                        }}
                      >
                        {ass.submission ? "Replace / Re-upload ↻" : "Upload Deliverable ↑"}
                      </button>
                    </div>
                  </div>

                  {/* If already submitted, display submission details */}
                  {ass.submission && (
                    <div style={{ background: "#FFFFFF", padding: "12px 16px", borderRadius: "var(--radius-sm)", border: "1px solid #BBF7D0", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ width: 34, height: 34, borderRadius: 6, background: "#DCFCE7", color: "#166534", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1rem" }}>
                          📄
                        </div>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: "0.875rem", color: "#166534" }}>
                            {ass.submission.fileName || "Project Link Submitted"}
                          </div>
                          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                            {ass.submission.fileSize && `${ass.submission.fileSize} • `}
                            Submitted on {new Date(ass.submission.submittedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </div>
                        </div>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        {ass.submission.projectLink && (
                          <a
                            href={ass.submission.projectLink}
                            target="_blank"
                            rel="noreferrer"
                            className="btn btn-ghost btn-sm"
                            style={{ fontSize: "0.78rem", color: "var(--primary-learner)" }}
                          >
                            🔗 View Project Link
                          </a>
                        )}
                        <span className="pill-badge pill-success" style={{ fontSize: "0.75rem" }}>
                          ✓ Received by Instructor
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── TAB: TESTS ─────────────────────────────────────────────── */}
        {activeNav === "tests" && (
          <div className="dashboard-tab-panel">
            <h2 style={{ fontSize: "1.5rem", fontWeight: 800, marginBottom: 6 }}>Quizzes &amp; Assessments</h2>
            <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: 24 }}>Modular evaluations testing your practical mastery.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {[
                { title: "Module 02 Assessment: AI Prompt Chaining", score: "96 / 100", date: "Completed Oct 14", badge: "pill-success" },
                { title: "Module 01 Assessment: Introduction & ML Basics", score: "88 / 100", date: "Completed Oct 08", badge: "pill-success" },
                { title: "Design Principles & Typography Test", score: "Upcoming", date: "Sat, Oct 25 • 10:00 AM", badge: "pill-tech" },
              ].map((test, i) => (
                <div key={i} style={{ padding: 18, border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#F8FAFC" }}>
                  <div>
                    <h3 style={{ fontSize: "1rem", fontWeight: 700 }}>{test.title}</h3>
                    <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 2 }}>{test.date}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span className={`pill-badge ${test.badge}`}>{test.score}</span>
                    <button className="btn btn-outline btn-sm" onClick={() => triggerToast(`Reviewing results for ${test.title}`)}>
                      Review &rarr;
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── TAB: CERTIFICATES ──────────────────────────────────────── */}
        {activeNav === "certificates" && (
          <div className="dashboard-tab-panel">
            <h2 style={{ fontSize: "1.5rem", fontWeight: 800, marginBottom: 6 }}>Certificates of Completion</h2>
            <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: 24 }}>Official verified Peleekings credentials with your Registration Code.</p>
            <div style={{ padding: 28, border: "2px solid var(--primary-learner-border)", background: "linear-gradient(135deg, #FAF5FF, #EFF6FF)", borderRadius: "var(--radius-md)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                <div>
                  <span className="pill-badge pill-success" style={{ marginBottom: 8 }}>VERIFIED CREDENTIAL</span>
                  <h3 style={{ fontSize: "1.3rem", fontWeight: 800 }}>Foundations of Digital Computing</h3>
                  <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: 4 }}>
                    Recipient: <strong>{userName}</strong> &bull; Registration ID: <strong>{regCode}</strong>
                  </div>
                </div>
                <div style={{ width: 48, height: 48, borderRadius: "50%", background: "#0F172A", color: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900 }}>
                  P
                </div>
              </div>
              <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", marginBottom: 20 }}>
                This is to certify that the recipient has satisfactorily demonstrated proficiency in computing fundamentals and practical project applications.
              </p>
              <button
                className="btn btn-solid-dark btn-sm"
                onClick={() => {
                  triggerToast("Downloading Certificate PDF...");
                  const blob = new Blob([`Official Certificate of Completion\nAwarded to: ${userName}\nReg ID: ${regCode}\nCourse: Foundations of Digital Computing\nDate: ${new Date().toLocaleDateString()}`], { type: "text/plain" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `Certificate_${regCode}.txt`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                }}
              >
                Download Official Certificate ↓
              </button>
            </div>
          </div>
        )}

        {/* ── TAB: PROFILE ───────────────────────────────────────────── */}
        {activeNav === "profile" && (
          <div className="dashboard-tab-panel" style={{ maxWidth: 640 }}>
            <h2 style={{ fontSize: "1.5rem", fontWeight: 800, marginBottom: 6 }}>Learner Profile</h2>
            <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: 24 }}>Your registration details and account settings.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <label style={{ fontSize: "0.825rem", fontWeight: 600, color: "var(--text-secondary)", display: "block", marginBottom: 6 }}>Full Name</label>
                <input type="text" readOnly className="form-field-input" value={userName} style={{ background: "#F8FAFC" }} />
              </div>
              <div>
                <label style={{ fontSize: "0.825rem", fontWeight: 600, color: "var(--text-secondary)", display: "block", marginBottom: 6 }}>Email Address</label>
                <input type="email" readOnly className="form-field-input" value={email} style={{ background: "#F8FAFC" }} />
              </div>
              <div className="profile-fields-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={{ fontSize: "0.825rem", fontWeight: 600, color: "var(--text-secondary)", display: "block", marginBottom: 6 }}>User ID</label>
                  <input
                    type="text"
                    readOnly
                    className="form-field-input"
                    value={regCode || "—"}
                    style={{ background: "var(--success-bg)", color: "var(--success-text)", fontWeight: 700, letterSpacing: "0.04em" }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: "0.825rem", fontWeight: 600, color: "var(--text-secondary)", display: "block", marginBottom: 6 }}>
                    {userProfile?.studentType === "non_corper" ? "Learner Category" : "NYSC State Code"}
                  </label>
                  <input
                    type="text"
                    readOnly
                    className="form-field-input"
                    value={userProfile?.studentType === "non_corper" ? "Non-Corper (Independent Learner)" : nyscCode}
                    style={{ background: "#F8FAFC" }}
                  />
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <button className="btn btn-solid-dark" onClick={() => triggerToast("Profile data verified with Peleekings Registry.")}>
                  Save Profile Settings
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── TAB: NOTES & ANNOUNCEMENTS FALLBACK ────────────────────── */}
        {(activeNav === "notes" || activeNav === "announcements") && (
          <div className="dashboard-tab-panel">
            <h2 style={{ fontSize: "1.5rem", fontWeight: 800, textTransform: "capitalize", marginBottom: 6 }}>{activeNav}</h2>
            <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: 20 }}>Stay updated with course broadcasts and downloadable reference material.</p>
            <div style={{ padding: 18, background: "#F8FAFC", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-light)" }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Module 4 Live Q&amp;A Scheduled</div>
              <div style={{ fontSize: "0.825rem", color: "var(--text-muted)", marginBottom: 8 }}>Posted by Lead Instructor &bull; 2 days ago</div>
              <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>Join us on Saturday 10:00 AM for an interactive walkthrough on setting up production webhooks.</p>
            </div>
          </div>
        )}

        {/* ── Learning Path Modal ────────────────────────────────────── */}
        {showPathModal && (
          <div className="modal-backdrop-overlay" onClick={() => setShowPathModal(false)}>
            <div className="modal-dialog-box" onClick={e => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <div>
                  <span className="pill-badge pill-tech" style={{ marginBottom: 4 }}>CAREER PATH</span>
                  <h3 style={{ fontSize: "1.4rem", fontWeight: 800 }}>Become a Digital Creator</h3>
                </div>
                <button className="btn-ghost" onClick={() => setShowPathModal(false)}>✕</button>
              </div>
              <p style={{ fontSize: "0.9rem", color: "var(--text-secondary)", marginBottom: 20 }}>
                A step-by-step roadmap combining Graphic Design, Videography, Social Media Growth, and Automation tools.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
                {[
                  "Step 1: Visual Design with Figma",
                  "Step 2: Video Capture & Premiere Pro Editing",
                  "Step 3: Audience Distribution on YouTube & TikTok",
                  "Step 4: AI Automation & Repurposing Pipeline",
                ].map((step, idx) => (
                  <div key={idx} style={{ padding: "10px 14px", background: "#F8FAFC", borderRadius: 8, fontSize: "0.875rem", fontWeight: 600 }}>
                    {step}
                  </div>
                ))}
              </div>
              <button className="btn btn-solid-dark" style={{ width: "100%" }} onClick={() => { setShowPathModal(false); navigate("/course/ai-essentials"); }}>
                Enroll in Path &rarr;
              </button>
            </div>
          </div>
        )}

        {/* ── Assignment Upload Modal ───────────────────────────────── */}
        {activeUploadAssignment && (
          <div className="modal-backdrop-overlay" onClick={() => !isSubmittingAssignment && setActiveUploadAssignment(null)}>
            <div
              className="modal-dialog-box"
              style={{ maxWidth: 560, width: "92%", padding: "26px" }}
              onClick={e => e.stopPropagation()}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                <div>
                  <span className="pill-badge pill-tech" style={{ marginBottom: 6 }}>ASSIGNMENT SUBMISSION</span>
                  <h3 style={{ fontSize: "1.3rem", fontWeight: 800 }}>{activeUploadAssignment.title}</h3>
                  <div style={{ fontSize: "0.825rem", color: "var(--text-muted)", marginTop: 2 }}>{activeUploadAssignment.course}</div>
                </div>
                <button
                  className="btn-ghost"
                  onClick={() => setActiveUploadAssignment(null)}
                  style={{ fontSize: "1.2rem", cursor: "pointer", border: "none" }}
                  disabled={isSubmittingAssignment}
                >
                  ✕
                </button>
              </div>

              <form onSubmit={handleAssignmentUploadSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {/* File Upload Zone */}
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>
                    Upload Deliverable File (PDF, ZIP, DOCX, Images, Figma)
                  </label>
                  <div
                    style={{
                      border: "2px dashed var(--border-light)",
                      borderRadius: "var(--radius-md)",
                      padding: "24px 16px",
                      textAlign: "center",
                      background: uploadFile ? "#F0FDF4" : "#F8FAFC",
                      borderColor: uploadFile ? "var(--success-border, #86EFAC)" : "var(--border-light)",
                      cursor: "pointer",
                      transition: "all 0.2s"
                    }}
                    onClick={() => document.getElementById("assignment-file-input")?.click()}
                  >
                    <input
                      id="assignment-file-input"
                      type="file"
                      style={{ display: "none" }}
                      onChange={e => {
                        if (e.target.files?.[0]) {
                          setUploadFile(e.target.files[0]);
                        }
                      }}
                      accept=".pdf,.doc,.docx,.zip,.png,.jpg,.jpeg,.fig,.txt"
                    />

                    {uploadFile ? (
                      <div>
                        <div style={{ fontSize: "2rem", marginBottom: 6 }}>✅</div>
                        <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "#15803D" }}>{uploadFile.name}</div>
                        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 2 }}>
                          {(uploadFile.size / 1024).toFixed(1)} KB • Click to choose a different file
                        </div>
                      </div>
                    ) : (
                      <div>
                        <div style={{ fontSize: "2rem", marginBottom: 6 }}>📁</div>
                        <div style={{ fontWeight: 700, fontSize: "0.925rem", color: "var(--text-primary)" }}>
                          Click to browse or drag &amp; drop file here
                        </div>
                        <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginTop: 4 }}>
                          Supports PDF, ZIP, DOCX, PNG, JPG (Max 25MB)
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Alternative / Supplemental Project URL */}
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>
                    Project Link / Repository URL (Optional)
                  </label>
                  <input
                    type="url"
                    className="form-field-input"
                    placeholder="e.g. https://www.figma.com/file/... or https://github.com/..."
                    value={uploadLink}
                    onChange={e => setUploadLink(e.target.value)}
                    style={{ background: "#F8FAFC" }}
                  />
                </div>

                {/* Learner Notes to Instructor */}
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>
                    Notes / Comments for Grader (Optional)
                  </label>
                  <textarea
                    rows="3"
                    className="form-field-input"
                    placeholder="Add any specific context, login test details, or notes on your design decisions..."
                    value={uploadNotes}
                    onChange={e => setUploadNotes(e.target.value)}
                    style={{ background: "#F8FAFC", resize: "vertical" }}
                  />
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => setActiveUploadAssignment(null)}
                    disabled={isSubmittingAssignment}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn btn-solid-dark"
                    disabled={isSubmittingAssignment}
                  >
                    {isSubmittingAssignment ? "Uploading Deliverable..." : "Submit Assignment &rarr;"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>

      {/* ── Fixed Bottom Nav Bar (mobile) ── */}
      <nav style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        height: 64,
        background: "#FFFFFF",
        borderTop: "1px solid var(--border-light)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-around",
        zIndex: 300,
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}>
        {[
          { id: "dashboard", label: "Dashboard", icon: (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          )},
          { id: "my-courses", label: "Courses", icon: (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
          )},
          { id: "assignments", label: "Assignments", icon: (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
          )},
          { id: "profile", label: "Settings", icon: (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 1 0-16 0"/></svg>
          )},
        ].map(item => {
          const isActive = activeNav === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setActiveNav(item.id)}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 3,
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "6px 12px",
                color: isActive ? "var(--primary-learner)" : "#94A3B8",
                fontWeight: isActive ? 700 : 500,
                fontSize: "0.68rem",
                transition: "color 0.15s ease",
                minWidth: 52,
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
