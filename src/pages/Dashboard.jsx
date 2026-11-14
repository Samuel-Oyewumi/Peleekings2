import { useState, useEffect } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  BookOpen,
  Compass,
  ClipboardList,
  Clock,
  FileText,
  Megaphone,
  Award,
  User,
  Briefcase,
  LogOut,
  Menu,
  X,
  Eye,
  EyeOff,
  CheckCircle2,
  Circle,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { useBodyScrollLock } from "../utils/scrollLock";
import { checkPasswordRequirements, validatePasswordOrThrow } from "../utils/passwordPolicy";
import {
  getUserActivity,
  submitAssignment,
  getAssignmentSubmission,
  getUserEnrollments,
  enrollInCourse,
  getWeeklyActivityData,
  incrementDailyActivity,
  isEnrollmentAuthorized,
} from "../contexts/userActivity";
import { COURSES_CATALOG } from "../data/courses";
import { getCurriculumForCourse } from "../data/courseCurricula";
import { doc, getDocs, collection, query, where, orderBy, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";

function EmptyState({ icon: Icon, title, text, buttonText, onButtonClick }) {
  return (
    <div
      style={{
        border: "2px dashed var(--border-light)",
        borderRadius: "var(--radius-md)",
        padding: "40px 24px",
        textAlign: "center",
        background: "#F8FAFC",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
      }}
    >
      {Icon && (
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: "50%",
            background: "#FFFFFF",
            border: "1px solid var(--border-light)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--primary-learner)",
            marginBottom: 4,
          }}
        >
          {typeof Icon === "function" || typeof Icon === "object" ? (
            <Icon size={22} aria-hidden="true" />
          ) : (
            Icon
          )}
        </div>
      )}
      <h3 style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>
        {title}
      </h3>
      {text && (
        <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", maxWidth: 420, margin: 0, lineHeight: 1.5 }}>
          {text}
        </p>
      )}
      {buttonText && onButtonClick && (
        <button
          type="button"
          className="btn btn-solid-dark btn-sm"
          style={{ marginTop: 8 }}
          onClick={onButtonClick}
        >
          {buttonText}
        </button>
      )}
    </div>
  );
}

export default function Dashboard() {
  const { currentUser, userProfile, logout, changeUserPassword } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [activeNav, setActiveNav] = useState(location.state?.openTab || "dashboard");
  const [showMobileSidebar, setShowMobileSidebar] = useState(false);
  const [showPathModal, setShowPathModal] = useState(false);
  const [toastMessage, setToastMessage] = useState(location.state?.welcomeToast || "");
  const [showTutorBanner, setShowTutorBanner] = useState(location.state?.showTutorBanner || false);
  // Browse Courses tab state
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogFilter, setCatalogFilter] = useState("All");
  const [enrollingId, setEnrollingId] = useState(null);
  const [allCoursesList, setAllCoursesList] = useState(COURSES_CATALOG);

  // Profile password update state
  const [newProfilePassword, setNewProfilePassword] = useState("");
  const [confirmProfilePassword, setConfirmProfilePassword] = useState("");
  const [showProfilePassword, setShowProfilePassword] = useState(false);
  const [profilePwError, setProfilePwError] = useState("");
  const [profilePwSuccess, setProfilePwSuccess] = useState("");
  const [isUpdatingPassword, setIsUpdatingPassword] = useState(false);

  // Lock background page scroll on mobile/tablet (<= 1024px) when Profile view or Mobile Sidebar is open
  useBodyScrollLock(activeNav === "profile" || showMobileSidebar, {
    mobileOnly: true,
    breakpoint: 1024,
  });

  useEffect(() => {
    function handleResize() {
      if (window.innerWidth > 1024) {
        setShowMobileSidebar(false);
      }
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Support opening specific tab (e.g. "profile") via navigation state
  useEffect(() => {
    if (location.state?.openTab) {
      setActiveNav(location.state.openTab);
    }
  }, [location.state?.openTab, location.key]);

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
  const email = currentUser?.email || userProfile?.email || "";
  const nyscCode = isNonCorper ? "Not Applicable (Non-Corper)" : (userProfile?.nyscStateCode || "Not provided");

  const [realRegNumber, setRealRegNumber] = useState(userProfile?.regNumber || null);

  useEffect(() => {
    if (userProfile?.regNumber) {
      setRealRegNumber(userProfile.regNumber);
      return;
    }
    if (!currentUser?.uid) return;

    const unsub = onSnapshot(
      doc(db, "users", currentUser.uid),
      (docSnap) => {
        if (docSnap.exists() && docSnap.data().regNumber) {
          setRealRegNumber(docSnap.data().regNumber);
        }
      },
      (err) => {
        console.warn("Notice: onSnapshot regNumber subscription:", err);
      }
    );
    return () => unsub();
  }, [currentUser?.uid, userProfile?.regNumber]);

  const regCode = realRegNumber || "Generating your code...";

  function triggerToast(msg) {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(""), 3500);
  }

  const [userActivity, setUserActivity] = useState(() => getUserActivity(currentUser?.uid));
  const [liveEnrollments, setLiveEnrollments] = useState([]);
  const [, setWeeklyActivityLive] = useState(null);

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
            const status = enr.status || "pending";
            return {
              id: enr.courseId,
              title: catalogItem.title || enr.courseTitle || enr.courseId,
              type: enr.experienceType === "hands-on" ? "Hands-on Practical" : "Online",
              status,
              progress: enr.progressPercent || 0,
              currentModule:
                status === "pending"
                  ? "Pending administrator / instructor approval"
                  : `${(enr.completedItemIds || []).length} lessons completed`,
              image:
                catalogItem.image ||
                "https://images.unsplash.com/photo-1677442136019-21780ecad995?w=500&auto=format&fit=crop&q=80",
              enrolledAt: enr.enrolledAt?.toDate ? enr.enrolledAt.toDate().toISOString() : new Date().toISOString(),
            };
          });
          setLiveEnrollments(mapped);
        } else {
          setLiveEnrollments([]);
        }
      })
      .catch((err) => console.warn("Could not fetch live enrollments:", err));
  }, [currentUser, allCoursesList]);

  // Active courses enrolled: strictly require Firestore-verified active/approved enrollment (do not trust localStorage for enrollment access)
  const enrolledCourses = liveEnrollments.filter((c) => isEnrollmentAuthorized(c));
  const pendingEnrollments = liveEnrollments.filter((c) => c.status === "pending");
  const inactiveEnrollments = liveEnrollments.filter((c) =>
    ["rejected", "revoked", "suspended"].includes(c.status)
  );
  const completedCourses = enrolledCourses.filter((c) => (c.progress || 0) >= 100);

  // Live Announcements from Firestore
  const [liveAnnouncements, setLiveAnnouncements] = useState([]);
  const [loadingAnnouncements, setLoadingAnnouncements] = useState(false);

  useEffect(() => {
    async function loadAnnouncements() {
      setLoadingAnnouncements(true);
      try {
        const q = query(
          collection(db, "announcements"),
          where("status", "==", "published"),
          orderBy("createdAt", "desc")
        );
        const snap = await getDocs(q);
        const enrolledCourseIds = new Set(enrolledCourses.map((c) => c.id));
        const list = snap.docs
          .map((d) => {
            const data = d.data();
            let dateStr = "Recent";
            if (data.createdAt?.toDate) {
              dateStr = data.createdAt.toDate().toLocaleDateString();
            } else if (data.createdAt) {
              dateStr = new Date(data.createdAt).toLocaleDateString();
            }
            return { id: d.id, ...data, date: dateStr };
          })
          .filter((a) => {
            if (a.audience === "all" || a.audience === "learners") return true;
            if (a.audience === "course" && a.courseId && enrolledCourseIds.has(a.courseId)) return true;
            return false;
          });
        setLiveAnnouncements(list);
      } catch (err) {
        console.warn("Notice loading announcements for student dashboard:", err);
      } finally {
        setLoadingAnnouncements(false);
      }
    }
    loadAnnouncements();
  }, [enrolledCourses]);

  // Real Assignments loaded from Firestore + curriculum for actively enrolled courses
  const [courseAssignments, setCourseAssignments] = useState([]);
  const [loadingAssignments, setLoadingAssignments] = useState(false);
  const [activeUploadAssignment, setActiveUploadAssignment] = useState(null);
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadLink, setUploadLink] = useState("");
  const [uploadNotes, setUploadNotes] = useState("");
  const [isSubmittingAssignment, setIsSubmittingAssignment] = useState(false);

  // Lock background page scroll at all widths when any modal dialog is open
  useBodyScrollLock(showPathModal || Boolean(activeUploadAssignment));

  const userSubmissions = userActivity?.assignmentSubmissions || {};

  useEffect(() => {
    let isMounted = true;
    async function loadEnrolledCourseAssignments() {
      if (!currentUser?.uid || enrolledCourses.length === 0) {
        if (isMounted) setCourseAssignments([]);
        return;
      }
      setLoadingAssignments(true);
      try {
        const collected = [];
        for (const course of enrolledCourses) {
          const courseId = course.id;
          const courseTitle = course.title || courseId;
          const seenIds = new Set();

          // 1. Dynamic Firestore assignments under courses/{courseId}/assignments
          try {
            const snap = await getDocs(collection(db, "courses", courseId, "assignments"));
            snap.docs.forEach((d) => {
              const data = d.data();
              seenIds.add(d.id);
              collected.push({
                id: d.id,
                courseId,
                course: courseTitle,
                title: data.title || "Practical Course Assignment",
                description:
                  data.instructions ||
                  data.description ||
                  "Submit your practical deliverable or project link for instructor review.",
                dueAt: data.dueAt || null,
              });
            });
          } catch (err) {
            console.warn(`Could not fetch dynamic assignments for ${courseId}:`, err);
          }

          // 2. Canonical static curriculum assignment items for this course
          const curr = getCurriculumForCourse(courseId);
          (curr.modules || []).forEach((mod) => {
            (mod.lessons || []).forEach((les) => {
              if (les.type === "assignment" && les.id && !seenIds.has(les.id)) {
                seenIds.add(les.id);
                collected.push({
                  id: les.id,
                  courseId,
                  course: courseTitle,
                  title: les.title || curr.assignment?.title || "Practical Assignment",
                  description:
                    les.instructions ||
                    curr.assignment?.description ||
                    "Complete and submit your practical deliverable for this module.",
                  dueAt: les.dueAt || null,
                });
              }
            });
          });

          if (curr.assignment?.id && !seenIds.has(curr.assignment.id)) {
            seenIds.add(curr.assignment.id);
            collected.push({
              id: curr.assignment.id,
              courseId,
              course: courseTitle,
              title: curr.assignment.title || "Course Capstone Project",
              description:
                curr.assignment.description ||
                "Complete and submit your practical deliverable for this course.",
              dueAt: null,
            });
          }
        }

        // Enrich with Firestore submission records
        const enriched = await Promise.all(
          collected.map(async (item) => {
            let sub = null;
            try {
              sub = await getAssignmentSubmission(currentUser.uid, item.id);
            } catch {}
            if (!sub && userSubmissions[item.id]) {
              sub = userSubmissions[item.id];
            }
            if (sub) {
              return {
                ...item,
                status: sub.status === "graded" ? `Graded (${sub.grade})` : "Submitted (Under Review)",
                badge: "pill-success",
                submission: {
                  ...sub,
                  submittedAt: sub.submittedAt?.toDate
                    ? sub.submittedAt.toDate().toISOString()
                    : sub.submittedAt || new Date().toISOString(),
                },
              };
            }
            return {
              ...item,
              status: "Pending Submission",
              badge: "pill-tech",
              submission: null,
            };
          })
        );

        if (isMounted) {
          setCourseAssignments(enriched);
        }
      } catch (err) {
        console.warn("Failed to load enrolled course assignments:", err);
      } finally {
        if (isMounted) setLoadingAssignments(false);
      }
    }

    loadEnrolledCourseAssignments();
    return () => {
      isMounted = false;
    };
  }, [currentUser?.uid, enrolledCourses.length]);

  const assignments = courseAssignments;
  const submittedAssignmentsCount = assignments.filter((a) => Boolean(a.submission)).length;
  const pendingAssignmentsCount = Math.max(0, assignments.length - submittedAssignmentsCount);

  async function handleAssignmentUploadSubmit(e) {
    e.preventDefault();
    if (!uploadFile && !uploadLink.trim()) {
      triggerToast("Please choose a file to upload or provide a project link.");
      return;
    }
    if (!activeUploadAssignment?.courseId || !activeUploadAssignment?.id) {
      triggerToast("Invalid assignment context: missing courseId or assignmentId.");
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
        content: uploadNotes.trim() || uploadLink.trim() || (uploadFile ? uploadFile.name : ""),
        submittedAt: new Date().toISOString(),
        studentName: userName,
        studentEmail: email,
      };

      const savedSub = await submitAssignment(
        currentUser?.uid,
        activeUploadAssignment.courseId,
        activeUploadAssignment.id,
        submissionData
      );
      setCourseAssignments((prev) =>
        prev.map((item) =>
          item.id === activeUploadAssignment.id && item.courseId === activeUploadAssignment.courseId
            ? {
                ...item,
                status: "Submitted (Under Review)",
                badge: "pill-success",
                submission: {
                  ...submissionData,
                  ...savedSub,
                  submittedAt: new Date().toISOString(),
                },
              }
            : item
        )
      );
      triggerToast(`✓ Assignment "${activeUploadAssignment.title}" submitted successfully!`);
      setActiveUploadAssignment(null);
      setUploadFile(null);
      setUploadLink("");
      setUploadNotes("");
    } catch (err) {
      console.error("Assignment submission error:", err);
      triggerToast(err?.message || "Failed to submit assignment. Please try again.");
    } finally {
      setIsSubmittingAssignment(false);
    }
  }

  async function handleLogout() {
    await logout();
    navigate("/");
  }

  return (
    <div className={`dashboard-page-layout ${activeNav === "profile" ? "dashboard-profile-active" : ""}`}>
      {/* Toast banner with close button and auto-dismiss */}
      {toastMessage && (
        <div style={{
          position: "fixed",
          top: 80,
          right: 24,
          zIndex: 1000,
          background: "#3C181A",
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
      <aside
        className={`portal-left-sidebar ${showMobileSidebar ? "mobile-open" : ""}`}
        data-scroll-lock-scrollable="true"
      >
        {/* Mobile-only close header */}
        <div className="sidebar-mobile-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div className="brand-logo-icon" style={{ width: 28, height: 28, fontSize: "0.9rem" }}>
              <img src="/assets/aistudio/20260925_194828_31921ef2.png" alt="" className="brand-submark-img" />
            </div>
            <img src="/assets/aistudio/20260925_194706_376e00d5.png" alt="Peleekings" className="brand-wordmark-img" style={{ height: 20 }} />
          </div>
          <button
            type="button"
            className="sidebar-close-btn"
            onClick={() => setShowMobileSidebar(false)}
            aria-label="Close navigation"
          >
            <X size={18} aria-hidden="true" />
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
            { id: "dashboard", label: "Dashboard", Icon: LayoutDashboard },
            { id: "my-courses", label: "My Courses", Icon: BookOpen },
            { id: "browse-courses", label: "Browse Courses", Icon: Compass },
            { id: "assignments", label: "Assignments", Icon: ClipboardList },
            { id: "tests", label: "Tests", Icon: Clock },
            { id: "notes", label: "Notes", Icon: FileText },
            { id: "announcements", label: "Announcements", Icon: Megaphone },
            { id: "certificates", label: "Certificates", Icon: Award },
            { id: "profile", label: "Profile", Icon: User },
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
              <item.Icon size={18} aria-hidden="true" />
              {item.label}
            </button>
          ))}
        </nav>

        {/* Switch Portal & Logout */}
        <div style={{ marginTop: "auto", borderTop: "1px solid var(--border-light)", paddingTop: 16 }}>
          <Link
            to="/teach-portal"
            className="portal-nav-link"
            style={{ fontSize: "0.85rem", color: "var(--primary-learner)", marginBottom: 4 }}
          >
            <Briefcase size={18} aria-hidden="true" /> Teaching Portal
          </Link>
          <button
            onClick={handleLogout}
            className="portal-nav-link"
            style={{ color: "#DC2626", width: "100%" }}
          >
            <LogOut size={18} aria-hidden="true" /> Log out
          </button>
        </div>
      </aside>

      {/* ── Main Dashboard Content ─────────────────────────────────── */}
      <main
        className={`dashboard-main-area ${activeNav === "profile" ? "dashboard-profile-active" : ""}`}
        style={{ paddingBottom: 80 }}
      >
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
                <Menu size={18} aria-hidden="true" />
              </button>
              <div>
                <h1 style={{ fontSize: "clamp(1.35rem, 4vw, 1.9rem)", fontWeight: 800, marginBottom: 2 }}>
                  Good morning, {firstName}
                </h1>
                <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0 }}>
                  Ready to continue learning today?
                </p>
              </div>
            </div>
          </div>
          <div className="dashboard-date-pill" style={{ fontSize: "0.825rem", color: "var(--text-muted)", fontWeight: 500, background: "#FFFFFF", border: "1px solid var(--border-light)", padding: "8px 16px", borderRadius: "var(--radius-full)" }}>
            {new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "short", day: "numeric" })}
          </div>
        </div>

        {/* ── Mobile Quick Navigation Tabs (Thumb Zone Ergonomics) ── */}
        <div className="dashboard-mobile-quick-nav">
          {[
            { id: "dashboard", label: "Overview", Icon: LayoutDashboard },
            { id: "my-courses", label: "My Courses", Icon: BookOpen },
            { id: "browse-courses", label: "Browse", Icon: Compass },
            { id: "assignments", label: "Assignments", Icon: ClipboardList },
            { id: "tests", label: "Tests", Icon: Clock },
            { id: "notes", label: "Notes", Icon: FileText },
            { id: "announcements", label: "Updates", Icon: Megaphone },
            { id: "certificates", label: "Certificates", Icon: Award },
            { id: "profile", label: "Profile", Icon: User },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`dashboard-mobile-quick-pill ${activeNav === tab.id ? "active" : ""}`}
              onClick={() => setActiveNav(tab.id)}
            >
              <tab.Icon size={15} aria-hidden="true" />
              <span>{tab.label}</span>
            </button>
          ))}
        </div>


        {/* Stage 6: Dismissible Tutor Apply Banner */}
        {showTutorBanner && (
          <div
            style={{
              background: "#FDF2F4",
              border: "1px solid #F9C6CE",
              borderRadius: "10px",
              padding: "14px 16px",
              marginBottom: 20,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
            }}
          >
            <div style={{ fontSize: "0.88rem", color: "#3C181A", lineHeight: 1.45 }}>
              <strong>Want to teach on Peleekings?</strong> Share your expertise with hundreds of students.{" "}
              <Link to="/teach-portal" style={{ color: "#EC586E", fontWeight: 700, textDecoration: "underline", whiteSpace: "nowrap" }}>
                Open Tutor Portal &rarr;
              </Link>
            </div>
            <button
              onClick={() => setShowTutorBanner(false)}
              style={{
                background: "none",
                border: "none",
                color: "#EC586E",
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
            <div className="dashboard-continue-hero">
              {/* Left: Course info */}
              <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#F9EFA7", display: "inline-block" }} />
                    <span style={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "#F9EFA7" }}>
                      {enrolledCourses.length > 0 ? "Continue where you left off" : "Ready to start?"}
                    </span>
                  </div>
                  <h2 style={{ fontSize: "clamp(1.4rem, 4.5vw, 2rem)", fontWeight: 800, color: "#FFFFFF", marginBottom: 6, lineHeight: 1.15 }}>
                    {enrolledCourses.length > 0 ? enrolledCourses[0].title : "Explore Courses"}
                  </h2>
                  <p style={{ fontSize: "0.9rem", color: "#E2E8F0", marginBottom: 20 }}>
                    {enrolledCourses.length > 0 ? enrolledCourses[0].currentModule : "Enroll in a course to begin your learning journey."}
                  </p>
                </div>

                {enrolledCourses.length > 0 && (
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", color: "#E2E8F0", marginBottom: 6 }}>
                      <span>Course progress</span>
                      <span style={{ color: "#F9EFA7", fontWeight: 700 }}>{enrolledCourses[0].progress}%</span>
                    </div>
                    <div style={{ width: "100%", height: 6, background: "rgba(255,255,255,0.16)", borderRadius: 99, overflow: "hidden", marginBottom: 20 }}>
                      <div style={{ width: `${enrolledCourses[0].progress}%`, height: "100%", background: "#EC586E", borderRadius: 99, transition: "width 0.6s ease" }} />
                    </div>
                  </div>
                )}

                <button
                  className="btn btn-sm"
                  style={{
                    alignSelf: "flex-start",
                    background: "#EC586E",
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
                    {enrolledCourses.length > 0 ? pendingAssignmentsCount : 0}
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
                  { icon: "🎬", label: "My Courses", sub: "Resume your learning", color: "#FDF2F4", nav: "my-courses" },
                  { icon: "📝", label: "Assignments", sub: "View pending submissions", color: "#FEF9C3", nav: "assignments" },
                  { icon: "📄", label: "Notes & Resources", sub: "Course materials and tools", color: "#FFF4F0", nav: "notes" },
                  { icon: "⏱", label: "Tests", sub: "Check scheduled tests", color: "#EAF7EF", nav: "tests" },
                  { icon: "📢", label: "Announcements", sub: "Latest from instructors", color: "#FFF4F0", nav: "announcements" },
                  { icon: "🎓", label: "Certificates", sub: "View your achievements", color: "#FDF2F4", nav: "certificates" },
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
            {enrolledCourses.length === 0 && pendingEnrollments.length === 0 && inactiveEnrollments.length === 0 ? (
              <EmptyState
                icon={BookOpen}
                title="No courses enrolled yet"
                text="You haven't enrolled in any courses yet. Explore the catalog to start learning practical skills."
                buttonText="Browse courses"
                onButtonClick={() => setActiveNav("browse-courses")}
              />
            ) : (
              <div className="dashboard-catalog-grid">
                {enrolledCourses.map(c => (
                  <div key={c.id} style={{ border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", overflow: "hidden", background: "#F8FAFC" }}>
                    <img src={c.image} alt={c.title} style={{ width: "100%", height: 140, objectFit: "cover" }} />
                    <div style={{ padding: 16 }}>
                      <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
                        <span className="pill-badge pill-tech">{c.type}</span>
                        <span className="pill-badge pill-success">
                          {c.status === "approved" ? "Approved" : "Active"}
                        </span>
                      </div>
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
                {pendingEnrollments.map(c => (
                  <div key={c.id} style={{ border: "1px solid #FDE68A", borderRadius: "var(--radius-md)", overflow: "hidden", background: "#FFFBEB" }}>
                    <img src={c.image} alt={c.title} style={{ width: "100%", height: 140, objectFit: "cover", opacity: 0.85 }} />
                    <div style={{ padding: 16 }}>
                      <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
                        <span className="pill-badge pill-tech">{c.type}</span>
                        <span className="pill-badge" style={{ background: "#FEF3C7", color: "#92400E", fontWeight: 700 }}>Pending Approval</span>
                      </div>
                      <h3 style={{ fontSize: "1.05rem", fontWeight: 700, marginBottom: 6 }}>{c.title}</h3>
                      <div style={{ fontSize: "0.8rem", color: "#92400E", marginBottom: 16 }}>
                        Awaiting approval by a course instructor or administrator.
                      </div>
                      <button className="btn btn-outline btn-sm" style={{ width: "100%" }} onClick={() => navigate(`/course/${c.id}`)}>
                        ⏳ View Request Status &rarr;
                      </button>
                    </div>
                  </div>
                ))}
                {inactiveEnrollments.map(c => (
                  <div key={c.id} style={{ border: "1px solid #FECACA", borderRadius: "var(--radius-md)", overflow: "hidden", background: "#FEF2F2" }}>
                    <img src={c.image} alt={c.title} style={{ width: "100%", height: 140, objectFit: "cover", opacity: 0.7 }} />
                    <div style={{ padding: 16 }}>
                      <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
                        <span className="pill-badge pill-tech">{c.type}</span>
                        <span className="pill-badge pill-danger" style={{ textTransform: "capitalize" }}>
                          {c.status}
                        </span>
                      </div>
                      <h3 style={{ fontSize: "1.05rem", fontWeight: 700, marginBottom: 6 }}>{c.title}</h3>
                      <div style={{ fontSize: "0.8rem", color: "#991B1B", marginBottom: 16 }}>
                        Enrollment status: {c.status}. Please contact course staff or administration for assistance.
                      </div>
                      <button className="btn btn-outline btn-sm" style={{ width: "100%" }} onClick={() => navigate(`/course/${c.id}`)}>
                        View Course Details &rarr;
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── TAB: BROWSE COURSES ─────────────────────────────────────── */}
        {activeNav === "browse-courses" && (() => {
          const activeIds = new Set(enrolledCourses.map(e => e.id));
          const pendingIds = new Set(pendingEnrollments.map(e => e.id));
          const inactiveMap = new Map(inactiveEnrollments.map(e => [e.id, e.status]));
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
              const created = await enrollInCourse(currentUser.uid, course.id, "online");
              // Refresh live enrollments
              const updated = await getUserEnrollments(currentUser.uid);
              if (updated && updated.length > 0) {
                setLiveEnrollments(updated.map(enr => {
                  const cat = allCoursesList.find(c => c.id === enr.courseId) || COURSES_CATALOG.find(c => c.id === enr.courseId) || {};
                  const status = enr.status || "pending";
                  return {
                    id: enr.courseId,
                    title: cat.title || enr.courseTitle || enr.courseId,
                    type: enr.experienceType === "hands-on" ? "Hands-on Practical" : "Online",
                    status,
                    progress: enr.progressPercent || 0,
                    currentModule:
                      status === "pending"
                        ? "Pending administrator / instructor approval"
                        : `${(enr.completedItemIds || []).length} lessons completed`,
                    image: cat.image || "https://images.unsplash.com/photo-1677442136019-21780ecad995?w=500&auto=format&fit=crop&q=80",
                    enrolledAt: enr.enrolledAt?.toDate ? enr.enrolledAt.toDate().toISOString() : new Date().toISOString(),
                  };
                }));
              }
              if (created?.status === "active" || created?.status === "approved") {
                triggerToast(`✓ Enrolled in "${course.title}"! You now have active classroom access.`);
              } else {
                triggerToast(`⏳ Enrollment request submitted for "${course.title}" (Pending Approval).`);
              }
            } catch (err) {
              console.warn(err);
              triggerToast(err?.message || "Enrollment request failed. Please try again.");
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
                  const isEnrolled = activeIds.has(course.id);
                  const isPending = pendingIds.has(course.id);
                  const inactiveStatus = inactiveMap.get(course.id);
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
                        ) : isPending ? (
                          <button
                            className="btn btn-outline btn-sm"
                            style={{ width: "100%", borderColor: "#FDE68A", background: "#FFFBEB", color: "#92400E" }}
                            onClick={() => navigate(`/course/${course.id}`)}
                          >
                            ⏳ Pending Approval
                          </button>
                        ) : inactiveStatus ? (
                          <button
                            className="btn btn-outline btn-sm"
                            style={{ width: "100%", borderColor: "#FECACA", background: "#FEF2F2", color: "#991B1B", textTransform: "capitalize" }}
                            onClick={() => navigate(`/course/${course.id}`)}
                          >
                            Status: {inactiveStatus}
                          </button>
                        ) : (
                          <button
                            className="btn btn-solid-dark btn-sm"
                            style={{ width: "100%" }}
                            disabled={isEnrolling}
                            onClick={() => handleEnrollFromDashboard(course)}
                          >
                            {isEnrolling ? "Submitting…" : "Enroll Now →"}
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
              {enrolledCourses.length > 0 && assignments.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="pill-badge pill-tech" style={{ padding: "6px 12px", fontSize: "0.8rem" }}>
                    {submittedAssignmentsCount} of {assignments.length} Submitted
                  </span>
                </div>
              )}
            </div>

            {enrolledCourses.length === 0 ? (
              <EmptyState
                icon={ClipboardList}
                title="No assignments yet"
                text="Enroll in a course to access and submit course projects and practical assignments."
                buttonText="Browse courses"
                onButtonClick={() => setActiveNav("browse-courses")}
              />
            ) : loadingAssignments ? (
              <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>
                Loading course assignments...
              </div>
            ) : assignments.length === 0 ? (
              <EmptyState
                icon={ClipboardList}
                title="No assignments published yet"
                text="Your enrolled courses do not have any assignments published yet. Check back soon!"
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {assignments.map((ass) => (
                  <div
                    key={`${ass.courseId}_${ass.id}`}
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
                        <span style={{ fontSize: "0.78rem", color: "var(--text-muted)", fontWeight: 500 }}>
                          {ass.dueAt ? `Deadline: ${new Date(ass.dueAt).toLocaleDateString()}` : "Deadline: set by your instructor"}
                        </span>
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
                              {ass.submission.fileName || "Project Deliverable Submitted"}
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
            )}
          </div>
        )}

        {/* ── TAB: TESTS ─────────────────────────────────────────────── */}
        {activeNav === "tests" && (
          <div className="dashboard-tab-panel">
            <h2 style={{ fontSize: "1.5rem", fontWeight: 800, marginBottom: 6 }}>Quizzes &amp; Assessments</h2>
            <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: 24 }}>Modular evaluations testing your practical mastery.</p>
            <EmptyState
              icon={Clock}
              title="No tests yet"
              text="Scheduled quizzes and module assessments from your instructors will appear here."
            />
          </div>
        )}

        {/* ── TAB: CERTIFICATES ──────────────────────────────────────── */}
        {activeNav === "certificates" && (
          <div className="dashboard-tab-panel">
            <h2 style={{ fontSize: "1.5rem", fontWeight: 800, marginBottom: 6 }}>Certificates of Completion</h2>
            <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: 24 }}>Official verified Peleekings credentials with your Registration Code.</p>
            {completedCourses.length === 0 ? (
              <EmptyState
                icon={Award}
                title="No certificates yet"
                text="Complete 100% of an enrolled course to earn your official verified Peleekings certificate."
                buttonText="Go to my courses"
                onButtonClick={() => setActiveNav("my-courses")}
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                {completedCourses.map((course) => (
                  <div
                    key={course.id}
                    style={{
                      padding: 28,
                      border: "2px solid var(--primary-learner-border)",
                      background: "linear-gradient(135deg, #FDF2F4, #FEFCE8)",
                      borderRadius: "var(--radius-md)",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                      <div>
                        <span className="pill-badge pill-success" style={{ marginBottom: 8 }}>VERIFIED CREDENTIAL</span>
                        <h3 style={{ fontSize: "1.3rem", fontWeight: 800 }}>{course.title}</h3>
                        <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: 4 }}>
                          Recipient: <strong>{userName}</strong> &bull; Registration ID: <strong>{regCode}</strong>
                        </div>
                      </div>
                      <div className="brand-logo-icon" style={{ width: 48, height: 48, borderRadius: "50%" }}>
                        <img src="/assets/aistudio/20260925_194828_31921ef2.png" alt="Peleekings" className="brand-submark-img" />
                      </div>
                    </div>
                    <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", marginBottom: 20 }}>
                      This is to certify that the recipient has satisfactorily completed all modules and practical project requirements for <strong>{course.title}</strong>.
                    </p>
                    <button
                      className="btn btn-solid-dark btn-sm"
                      onClick={() => {
                        triggerToast(`Downloading Certificate for ${course.title}...`);
                        const blob = new Blob(
                          [
                            `Official Certificate of Completion\nAwarded to: ${userName}\nReg ID: ${regCode}\nCourse: ${course.title}\nDate: ${new Date().toLocaleDateString()}`,
                          ],
                          { type: "text/plain" }
                        );
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `Certificate_${regCode}_${course.title.replace(/[^a-z0-9]+/gi, "_")}.txt`;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(url);
                      }}
                    >
                      Download Official Certificate ↓
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── TAB: PROFILE ───────────────────────────────────────────── */}
        {activeNav === "profile" && (
          <div
            className="dashboard-tab-panel dashboard-profile-panel"
            data-testid="dashboard-profile-panel"
            style={{ maxWidth: 640 }}
          >
            <div
              className="dashboard-profile-header"
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 12,
                marginBottom: 16,
              }}
            >
              <div>
                <h2 style={{ fontSize: "1.5rem", fontWeight: 800, marginBottom: 6 }}>Learner Profile</h2>
                <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", margin: 0 }}>
                  Your registration details and account settings.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-outline btn-sm profile-mobile-close-btn"
                onClick={() => setActiveNav("dashboard")}
                aria-label="Close profile and return to dashboard"
              >
                <X size={16} aria-hidden="true" /> Done
              </button>
            </div>

            <div
              className="dashboard-profile-scroll-body"
              data-testid="dashboard-profile-scroll-body"
              data-scroll-lock-scrollable="true"
            >
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
                <div style={{ marginTop: 4 }}>
                  <button className="btn btn-solid-dark" onClick={() => triggerToast("Profile data verified with Peleekings Registry.")}>
                    Save Profile Settings
                  </button>
                </div>

                {/* Password Update Section (Consistent 8+ char & numeric policy) */}
                <div
                  style={{
                    marginTop: 12,
                    paddingTop: 20,
                    borderTop: "1px solid var(--border-light)",
                  }}
                >
                  <h3 style={{ fontSize: "1.05rem", fontWeight: 700, marginBottom: 4 }}>
                    Update Account Password
                  </h3>
                  <p style={{ fontSize: "0.825rem", color: "var(--text-muted)", marginBottom: 14 }}>
                    Use a strong password with at least 8 characters and at least one number (0–9).
                  </p>

                  {profilePwError && (
                    <div
                      role="alert"
                      style={{
                        background: "#FEE2E2",
                        color: "#B91C1C",
                        padding: "10px 12px",
                        borderRadius: "var(--radius-sm)",
                        fontSize: "0.825rem",
                        marginBottom: 12,
                      }}
                    >
                      {profilePwError}
                    </div>
                  )}

                  {profilePwSuccess && (
                    <div
                      style={{
                        background: "#EAF7EF",
                        color: "#166534",
                        border: "1px solid #BBF7D0",
                        padding: "10px 12px",
                        borderRadius: "var(--radius-sm)",
                        fontSize: "0.825rem",
                        marginBottom: 12,
                      }}
                    >
                      {profilePwSuccess}
                    </div>
                  )}

                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (isUpdatingPassword) return;
                      setProfilePwError("");
                      setProfilePwSuccess("");
                      try {
                        validatePasswordOrThrow(newProfilePassword);
                        if (newProfilePassword !== confirmProfilePassword) {
                          throw new Error("Passwords do not match. Please verify both passwords.");
                        }
                        setIsUpdatingPassword(true);
                        await changeUserPassword(newProfilePassword);
                        setNewProfilePassword("");
                        setConfirmProfilePassword("");
                        setProfilePwSuccess("Password updated successfully.");
                      } catch (err) {
                        setProfilePwError(err.message || "Failed to update password.");
                      } finally {
                        setIsUpdatingPassword(false);
                      }
                    }}
                  >
                    <div className="profile-fields-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <div>
                        <label style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)", display: "block", marginBottom: 6 }}>
                          New Password
                        </label>
                        <div style={{ position: "relative" }}>
                          <input
                            type={showProfilePassword ? "text" : "password"}
                            minLength={8}
                            value={newProfilePassword}
                            onChange={(e) => {
                              setNewProfilePassword(e.target.value);
                              setProfilePwError("");
                              setProfilePwSuccess("");
                            }}
                            placeholder="At least 8 chars + 1 number"
                            className="form-field-input"
                            style={{ paddingRight: 36 }}
                          />
                          <button
                            type="button"
                            onClick={() => setShowProfilePassword((prev) => !prev)}
                            aria-label={showProfilePassword ? "Hide password" : "Show password"}
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
                            {showProfilePassword ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
                          </button>
                        </div>
                      </div>
                      <div>
                        <label style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)", display: "block", marginBottom: 6 }}>
                          Confirm New Password
                        </label>
                        <input
                          type={showProfilePassword ? "text" : "password"}
                          minLength={8}
                          value={confirmProfilePassword}
                          onChange={(e) => {
                            setConfirmProfilePassword(e.target.value);
                            setProfilePwError("");
                            setProfilePwSuccess("");
                          }}
                          placeholder="Re-enter new password"
                          className="form-field-input"
                        />
                      </div>
                    </div>

                    {(() => {
                      const pwReq = checkPasswordRequirements(newProfilePassword);
                      return (
                        <div
                          style={{
                            marginTop: 10,
                            marginBottom: 12,
                            padding: "8px 12px",
                            background: "#F8FAFC",
                            border: "1px solid var(--border-light)",
                            borderRadius: "var(--radius-sm)",
                            fontSize: "0.78rem",
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 14,
                          }}
                        >
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 5,
                              color: pwReq.hasMinLength ? "#15803D" : "var(--text-muted)",
                              fontWeight: pwReq.hasMinLength ? 600 : 500,
                            }}
                          >
                            {pwReq.hasMinLength ? <CheckCircle2 size={14} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />}
                            At least 8 characters
                          </span>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 5,
                              color: pwReq.hasNumber ? "#15803D" : "var(--text-muted)",
                              fontWeight: pwReq.hasNumber ? 600 : 500,
                            }}
                          >
                            {pwReq.hasNumber ? <CheckCircle2 size={14} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />}
                            Contains at least one number (0–9)
                          </span>
                        </div>
                      );
                    })()}

                    <button
                      type="submit"
                      disabled={isUpdatingPassword}
                      className="btn btn-outline btn-sm"
                    >
                      {isUpdatingPassword ? "Updating Password..." : "Update Password"}
                    </button>
                  </form>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── TAB: NOTES ─────────────────────────────────────────────── */}
        {activeNav === "notes" && (
          <div className="dashboard-tab-panel">
            <h2 style={{ fontSize: "1.5rem", fontWeight: 800, marginBottom: 6 }}>Notes &amp; Resources</h2>
            <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: 24 }}>Downloadable lecture notes, study guides, and course reference materials.</p>
            <EmptyState
              icon={FileText}
              title="No notes yet"
              text="Lecture notes and downloadable study materials from your enrolled courses will appear here."
              buttonText={enrolledCourses.length === 0 ? "Browse courses" : undefined}
              onButtonClick={enrolledCourses.length === 0 ? () => setActiveNav("browse-courses") : undefined}
            />
          </div>
        )}

        {/* ── TAB: ANNOUNCEMENTS ─────────────────────────────────────── */}
        {activeNav === "announcements" && (
          <div className="dashboard-tab-panel">
            <h2 style={{ fontSize: "1.5rem", fontWeight: 800, marginBottom: 6 }}>Announcements &amp; Broadcasts</h2>
            <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: 24 }}>Stay updated with course broadcasts and instructor notices.</p>

            {loadingAnnouncements ? (
              <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>Loading announcements...</div>
            ) : liveAnnouncements.length === 0 ? (
              <EmptyState
                icon={Megaphone}
                title="No announcements yet"
                text="Course broadcasts, live session updates, and instructor notices will be posted here."
                buttonText={enrolledCourses.length === 0 ? "Browse courses" : undefined}
                onButtonClick={enrolledCourses.length === 0 ? () => setActiveNav("browse-courses") : undefined}
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {liveAnnouncements.map((ann) => (
                  <div
                    key={ann.id}
                    style={{
                      padding: 20,
                      borderRadius: 12,
                      background: "#FFFFFF",
                      border: "1px solid var(--border-light)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                      <span className="pill-badge pill-tech">{ann.category || "General"}</span>
                      {ann.pinned && <span className="pill-badge pill-creative">📌 PINNED</span>}
                      {ann.priority === "urgent" && <span className="pill-badge pill-danger">URGENT</span>}
                      <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Posted {ann.date}</span>
                    </div>
                    <h3 style={{ margin: "0 0 8px", fontSize: "1.2rem", fontWeight: 800 }}>{ann.title}</h3>
                    <p style={{ margin: 0, fontSize: "0.9rem", color: "var(--text-secondary)", lineHeight: 1.6, whiteSpace: "pre-line" }}>
                      {ann.body}
                    </p>
                  </div>
                ))}
              </div>
            )}
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
    </div>
  );
}
