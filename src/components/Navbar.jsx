import { useState, useEffect, useRef } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { COURSES_CATALOG } from "../data/courses";
import { getResources, uploadResource, DEFAULT_RESOURCES } from "../contexts/resourcesService";
import { subscribeToNotifications, markNotificationAsRead, markAllNotificationsAsRead } from "../contexts/notificationsService";

export default function Navbar() {
  const { currentUser, userProfile, logout, updateUserRole } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // Dropdowns state
  const [showMenu, setShowMenu] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showResourcesModal, setShowResourcesModal] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);

  // Platform resources state
  const [platformResources, setPlatformResources] = useState(DEFAULT_RESOURCES);
  const [showResourceUploadForm, setShowResourceUploadForm] = useState(false);
  const [resourceUploadData, setResourceUploadData] = useState({
    title: "",
    description: "",
    category: "Tech & Digital Skills",
    externalUrl: "",
    file: null,
  });
  const [isUploadingResource, setIsUploadingResource] = useState(false);
  const [resourceUploadSuccess, setResourceUploadSuccess] = useState("");

  // Active search modal state
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCategory, setSearchCategory] = useState("All");

  // Notifications state with full messages
  const [notifications, setNotifications] = useState([
    {
      id: 1,
      title: "Assignment Graded",
      text: "Module 02 Prompt Engineering received 95%",
      fullMessage: "Congratulations! Your Module 02 Prompt Engineering assignment has been graded by your instructor with a score of 95/100 (Distinction). Your prompt chaining pipelines and Zapier automation workflows demonstrated exceptional practical mastery.",
      time: "2h ago",
      unread: true,
      actionLink: "/dashboard"
    },
    {
      id: 2,
      title: "New Lesson Available",
      text: "AI Essentials & Automation: Module 5 unlocked",
      fullMessage: "Module 5: 'End-to-End Enterprise Automations' is now available in your classroom. In this module, you will build production-grade webhooks, multi-agent chains, and data extractors.",
      time: "1d ago",
      unread: true,
      actionLink: "/course/ai-essentials"
    },
    {
      id: 3,
      title: "Welcome to Peleekings",
      text: "Your registration code is AS1399",
      fullMessage: "Welcome to Peleekings E-Learning Platform! Your account is active with official registration code AS1399. You can use this code for all credential verifications, certificates of completion, and NYSC skill endorsements.",
      time: "3d ago",
      unread: false,
      actionLink: "/dashboard"
    },
  ]);

  const [activeSection, setActiveSection] = useState("courses");
  const [selectedNotification, setSelectedNotification] = useState(null);

  const navRef = useRef(null);

  // Subscribe to real-time user notifications
  useEffect(() => {
    if (!currentUser?.uid) return;
    const unsubscribe = subscribeToNotifications(currentUser.uid, (items) => {
      if (items && items.length > 0) {
        setNotifications(
          items.map((it) => ({
            id: it.id,
            title: it.title,
            text: it.body,
            fullMessage: it.body,
            time: it.createdAt?.seconds
              ? new Date(it.createdAt.seconds * 1000).toLocaleDateString()
              : "Recent",
            unread: !it.read,
            actionLink: it.courseId ? `/course/${it.courseId}` : "/dashboard",
          }))
        );
      }
    });
    return unsubscribe;
  }, [currentUser?.uid]);

  // Load platform resources when Resources modal opens
  useEffect(() => {
    if (showResourcesModal) {
      getResources("platform")
        .then((res) => {
          if (res && res.length > 0) setPlatformResources(res);
        })
        .catch((err) => console.warn("Error fetching platform resources:", err));
    }
  }, [showResourcesModal]);

  async function handleUploadResource(e) {
    e.preventDefault();
    if (!resourceUploadData.title.trim() || (!resourceUploadData.file && !resourceUploadData.externalUrl.trim())) {
      alert("Please provide a resource title and either a file to upload or an external URL.");
      return;
    }

    setIsUploadingResource(true);
    setResourceUploadSuccess("");

    try {
      const newRes = await uploadResource({
        file: resourceUploadData.file,
        title: resourceUploadData.title,
        description: resourceUploadData.description,
        category: resourceUploadData.category,
        courseId: "platform",
        externalUrl: resourceUploadData.externalUrl,
        user: currentUser
          ? {
              uid: currentUser.uid,
              displayName: currentUser.displayName || userProfile?.fullName,
              email: currentUser.email,
              role: userProfile?.role,
            }
          : null,
      });

      setPlatformResources((prev) => [newRes, ...prev]);
      setResourceUploadSuccess("✓ Resource published successfully!");
      setResourceUploadData({
        title: "",
        description: "",
        category: "Tech & Digital Skills",
        externalUrl: "",
        file: null,
      });
      setShowResourceUploadForm(false);
      setTimeout(() => setResourceUploadSuccess(""), 4000);
    } catch (err) {
      console.error("Resource upload error:", err);
      alert(err.message || "Failed to upload resource. Please check file permissions.");
    } finally {
      setIsUploadingResource(false);
    }
  }

  // Close menus on click outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (navRef.current && !navRef.current.contains(event.target)) {
        setShowMenu(false);
        setShowNotifications(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Close mobile menu on route change
  useEffect(() => {
    setShowMobileMenu(false);
    setShowMenu(false);
    setShowNotifications(false);
  }, [location.pathname]);



  const isLanding = location.pathname === "/";
  const isDashboard = location.pathname === "/dashboard";
  // Always show authenticated user profile & notifications when logged in
  const showAuthUser = !!currentUser;

  // Keyboard shortcut for active search modal (Ctrl+K / Cmd+K)
  useEffect(() => {
    function handleKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowSearchModal(prev => !prev);
      }
      if (e.key === "Escape") {
        setShowSearchModal(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const filteredSearchCourses = COURSES_CATALOG.filter(course => {
    const matchesCategory =
      searchCategory === "All" ||
      course.category === searchCategory ||
      course.badge === searchCategory;
    const q = searchQuery.toLowerCase().trim();
    const matchesQuery =
      !q ||
      course.title.toLowerCase().includes(q) ||
      course.description.toLowerCase().includes(q) ||
      course.badge.toLowerCase().includes(q);
    return matchesCategory && matchesQuery;
  });

  const nameToUse =
    userProfile?.fullName ||
    currentUser?.displayName ||
    (userProfile?.firstName && userProfile?.surname ? `${userProfile.firstName} ${userProfile.surname}` : "") ||
    currentUser?.email?.split("@")[0] ||
    "PK";

  const initials = nameToUse
    .trim()
    .split(/\s+/)
    .map(n => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "PK";

  const unreadCount = notifications.filter(n => n.unread).length;

  async function handleLogout() {
    setShowMenu(false);
    await logout();
    navigate("/");
  }

  function markAllNotificationsRead() {
    setNotifications(prev => prev.map(n => ({ ...n, unread: false })));
    // Persist to Firestore so badge doesn't reappear on reload
    if (currentUser?.uid) {
      markAllNotificationsAsRead(
        currentUser.uid,
        notifications.map(n => ({ id: n.id, read: !n.unread }))
      ).catch(err => console.warn("Could not mark all notifications read in Firestore:", err));
    }
  }

  const isActive = (path) => location.pathname === path;

  return (
    <header className="site-navbar" ref={navRef}>
      {/* Brand Logo */}
      <Link to="/" className="brand-wrapper" id="nav-brand">
        <div className="brand-logo-icon">P</div>
        <span>Peleekings</span>
      </Link>



      {/* Right Actions */}
      <div className="nav-actions-group">
        {/* Active Search Button Trigger */}
        <button
          className="btn-ghost"
          style={{ width: 38, height: 38, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
          onClick={() => setShowSearchModal(true)}
          title="Search courses (Ctrl+K)"
          aria-label="Search courses"
          id="nav-search-btn"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
        </button>

        {showAuthUser ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {/* Notification bell button with interactive dropdown */}
            <div style={{ position: "relative" }}>
              <button
                className="btn-ghost"
                style={{ width: 38, height: 38, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", position: "relative", cursor: "pointer" }}
                title="Notifications"
                onClick={() => {
                  setShowNotifications(prev => !prev);
                  setShowMenu(false);
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
                  <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
                </svg>
                {unreadCount > 0 && (
                  <span style={{ position: "absolute", top: 6, right: 6, width: 8, height: 8, background: "var(--primary-learner)", borderRadius: "50%" }}></span>
                )}
              </button>

              {/* Notifications Dropdown */}
              {showNotifications && (
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 12px)",
                    right: -40,
                    width: 320,
                    background: "#FFFFFF",
                    border: "1px solid var(--border-light)",
                    borderRadius: "var(--radius-md)",
                    boxShadow: "var(--shadow-lg)",
                    zIndex: 250,
                    overflow: "hidden"
                  }}
                >
                  <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border-subtle)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontWeight: 700, fontSize: "0.9rem", color: "var(--text-primary)" }}>Notifications</span>
                    {unreadCount > 0 && (
                      <button
                        onClick={markAllNotificationsRead}
                        style={{ fontSize: "0.75rem", color: "var(--primary-learner)", fontWeight: 600 }}
                      >
                        Mark all as read
                      </button>
                    )}
                  </div>

                  <div style={{ maxHeight: 280, overflowY: "auto" }}>
                    {notifications.map(item => (
                      <div
                        key={item.id}
                        style={{
                          padding: "12px 16px",
                          borderBottom: "1px solid var(--border-subtle)",
                          background: item.unread ? "#F8FAFC" : "#FFFFFF",
                          cursor: "pointer",
                          transition: "background 0.2s"
                        }}
                        onClick={() => {
                          setNotifications(prev => prev.map(n => n.id === item.id ? { ...n, unread: false } : n));
                          setSelectedNotification(item);
                          setShowNotifications(false);
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                          <span style={{ fontWeight: 600, fontSize: "0.85rem", color: "var(--text-primary)" }}>{item.title}</span>
                          <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>{item.time}</span>
                        </div>
                        <p style={{ fontSize: "0.775rem", color: "var(--text-secondary)", lineHeight: 1.4 }}>{item.text}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* User Avatar Dropdown */}
            <div style={{ position: "relative" }}>
              <button
                id="nav-user-avatar"
                className="user-avatar-circle"
                style={{ width: 38, height: 38, fontSize: "0.875rem", cursor: "pointer", border: "none" }}
                onClick={() => {
                  setShowMenu(prev => !prev);
                  setShowNotifications(false);
                }}
              >
                {currentUser?.photoURL ? (
                  <img src={currentUser.photoURL} alt="Avatar" style={{ width: "100%", height: "100%", borderRadius: "50%", objectFit: "cover" }} />
                ) : (
                  initials
                )}
              </button>

              {showMenu && (
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 12px)",
                    right: 0,
                    width: 260,
                    background: "#FFFFFF",
                    border: "1px solid var(--border-light)",
                    borderRadius: "var(--radius-md)",
                    boxShadow: "var(--shadow-lg)",
                    padding: "12px 0",
                    zIndex: 250,
                  }}
                >
                  {/* Profile info */}
                  <div style={{ padding: "8px 16px 12px", borderBottom: "1px solid var(--border-subtle)" }}>
                    <div style={{ fontWeight: 800, fontSize: "0.95rem", color: "var(--text-primary)" }}>
                      {currentUser?.displayName || userProfile?.fullName || "Learner"}
                    </div>
                    <div style={{ fontSize: "0.775rem", color: "var(--text-muted)", marginTop: 2 }}>
                      {currentUser?.email || ""}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
                      <span className={`pill-badge ${userProfile?.role === "admin" ? "pill-solid-dark" : userProfile?.role === "tutor" || userProfile?.role === "instructor" ? "pill-tech" : "pill-success"}`} style={{ fontSize: "0.7rem", padding: "2px 8px" }}>
                        {userProfile?.role === "admin" ? "Admin" : userProfile?.role === "tutor" || userProfile?.role === "instructor" ? "Tutor" : "Student"}
                      </span>
                      {userProfile?.regNumber && (
                        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", fontWeight: 600 }}>
                          ID: {userProfile.regNumber}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Log Out */}
                  <button
                    onClick={handleLogout}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      padding: "10px 16px",
                      fontSize: "0.875rem",
                      color: "#DC2626",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      fontWeight: 600,
                    }}
                  >
                    <span>⎋</span> Log Out
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Link to="/auth" state={{ mode: "login" }} className="btn btn-ghost" id="nav-login-btn">
              Log in
            </Link>
            <Link to="/auth" state={{ mode: "signup" }} className="btn btn-solid-dark" id="nav-get-started-btn">
              Get Started
            </Link>
          </div>
        )}

        {/* ── Mobile Hamburger Menu Toggle Button (Only shown when visitor is NOT logged in) ── */}
        {!showAuthUser && (
          <button
            className="mobile-hamburger-btn"
            onClick={() => setShowMobileMenu(prev => !prev)}
            aria-label="Toggle navigation menu"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              {showMobileMenu ? (
                <>
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </>
              ) : (
                <>
                  <line x1="3" y1="12" x2="21" y2="12"></line>
                  <line x1="3" y1="6" x2="21" y2="6"></line>
                  <line x1="3" y1="18" x2="21" y2="18"></line>
                </>
              )}
            </svg>
          </button>
        )}
      </div>

      {/* ── Mobile Drawer ───────────────────────────────────────────── */}
      {showMobileMenu && (
        <div className="mobile-nav-drawer">
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Search Trigger for Mobile */}
            <button
              className="mobile-nav-link"
              style={{ textAlign: "left", background: "none", border: "none", display: "flex", alignItems: "center", gap: 10, color: "var(--primary-learner)", fontWeight: 600 }}
              onClick={() => {
                setShowMobileMenu(false);
                setShowSearchModal(true);
              }}
            >
              <span>🔍</span> Search Courses
            </button>

            {!isDashboard && (
              <>
                <Link
                  to="/"
                  className={`mobile-nav-link ${isActive("/") && activeSection === "courses" ? "active" : ""}`}
                  onClick={() => {
                    setShowMobileMenu(false);
                    setActiveSection("courses");
                    document.getElementById("courses-catalog-section")?.scrollIntoView({ behavior: "smooth" });
                  }}
                >
                  Courses
                </Link>
                <Link
                  to="/"
                  className={`mobile-nav-link ${isActive("/") && activeSection === "learning-paths" ? "active" : ""}`}
                  onClick={(e) => {
                    setShowMobileMenu(false);
                    setActiveSection("learning-paths");
                    if (location.pathname !== "/") {
                      navigate("/");
                      setTimeout(() => {
                        const el = document.getElementById("learning-paths-section");
                        if (el) el.scrollIntoView({ behavior: "smooth" });
                      }, 120);
                    } else {
                      e.preventDefault();
                      const el = document.getElementById("learning-paths-section");
                      if (el) el.scrollIntoView({ behavior: "smooth" });
                    }
                  }}
                >
                  Learning Paths
                </Link>
                <button
                  className="mobile-nav-link"
                  style={{ textAlign: "left", background: "none", border: "none" }}
                  onClick={() => {
                    setShowMobileMenu(false);
                    setShowResourcesModal(true);
                  }}
                >
                  Resources
                </button>
                <Link
                  to="/about"
                  className={`mobile-nav-link ${isActive("/about") ? "active" : ""}`}
                  onClick={() => setShowMobileMenu(false)}
                >
                  About
                </Link>
              </>
            )}

            <div style={{ borderTop: "1px solid var(--border-light)", paddingTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
              {showAuthUser ? (
                <>
                  {userProfile?.role === "admin" && (
                    <Link to="/admin" className="btn btn-solid-dark" onClick={() => setShowMobileMenu(false)}>
                      Admin Dashboard
                    </Link>
                  )}
                  <Link to="/become-instructor" className="btn btn-outline" onClick={() => setShowMobileMenu(false)}>
                    Teaching Portal
                  </Link>
                  <button onClick={handleLogout} className="btn btn-outline" style={{ color: "#DC2626" }}>
                    Log Out
                  </button>
                </>
              ) : (
                <>
                  <Link to="/auth" state={{ mode: "login" }} className="btn btn-outline" onClick={() => setShowMobileMenu(false)}>
                    Sign In
                  </Link>
                  <Link to="/auth" state={{ mode: "signup" }} className="btn btn-solid-dark" onClick={() => setShowMobileMenu(false)}>
                    Get Started Free &rarr;
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Resources Modal ─────────────────────────────────────────── */}
      {showResourcesModal && (
        <div className="modal-backdrop-overlay" onClick={() => setShowResourcesModal(false)}>
          <div className="modal-dialog-box" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div>
                <span className="pill-badge pill-tech" style={{ marginBottom: 6 }}>LEARNING ASSETS</span>
                <h3 style={{ fontSize: "1.4rem", fontWeight: 800 }}>Peleekings Resources</h3>
              </div>
              <button
                className="btn-ghost"
                onClick={() => setShowResourcesModal(false)}
                style={{ fontSize: "1.2rem", cursor: "pointer", border: "none" }}
              >
                ✕
              </button>
            </div>

            <p style={{ color: "var(--text-secondary)", fontSize: "0.925rem", marginBottom: 20 }}>
              Curated guides, downloadable cheatsheets, and community resources to accelerate your learning journey.
            </p>

            {resourceUploadSuccess && (
              <div style={{ background: "#ECFDF5", border: "1px solid #A7F3D0", color: "#065F46", padding: "10px 14px", borderRadius: "var(--radius-sm)", fontSize: "0.85rem", marginBottom: 16 }}>
                {resourceUploadSuccess}
              </div>
            )}

            {/* Admin & Tutor Upload Control */}
            {(userProfile?.role === "admin" || userProfile?.role === "tutor" || userProfile?.role === "instructor") && (
              <div style={{ marginBottom: 20 }}>
                <button
                  className="btn btn-solid-dark btn-sm"
                  onClick={() => setShowResourceUploadForm((prev) => !prev)}
                  style={{ display: "flex", alignItems: "center", gap: 6 }}
                >
                  <span>{showResourceUploadForm ? "✕ Close Upload Form" : "+ Upload New Resource"}</span>
                </button>

                {showResourceUploadForm && (
                  <form
                    onSubmit={handleUploadResource}
                    style={{
                      marginTop: 14,
                      padding: 16,
                      background: "#F8FAFC",
                      border: "1px solid var(--border-light)",
                      borderRadius: "var(--radius-sm)",
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: "0.9rem", marginBottom: 12, color: "var(--text-primary)" }}>
                      Upload Platform Resource (Reflects Across Platform)
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <div>
                        <label style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                          RESOURCE TITLE *
                        </label>
                        <input
                          type="text"
                          required
                          placeholder="e.g. 2025 AI Tools & Automation Cheatsheet"
                          value={resourceUploadData.title}
                          onChange={(e) => setResourceUploadData({ ...resourceUploadData, title: e.target.value })}
                          className="form-field-input"
                          style={{ padding: "8px 12px", fontSize: "0.875rem" }}
                        />
                      </div>

                      <div>
                        <label style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                          DESCRIPTION
                        </label>
                        <input
                          type="text"
                          placeholder="Brief summary of this resource"
                          value={resourceUploadData.description}
                          onChange={(e) => setResourceUploadData({ ...resourceUploadData, description: e.target.value })}
                          className="form-field-input"
                          style={{ padding: "8px 12px", fontSize: "0.875rem" }}
                        />
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                        <div>
                          <label style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                            CATEGORY
                          </label>
                          <select
                            value={resourceUploadData.category}
                            onChange={(e) => setResourceUploadData({ ...resourceUploadData, category: e.target.value })}
                            className="form-field-input"
                            style={{ padding: "8px 12px", fontSize: "0.875rem" }}
                          >
                            <option>Tech &amp; Digital Skills</option>
                            <option>Professional Skills</option>
                            <option>Creative &amp; Design</option>
                            <option>NYSC Guides</option>
                          </select>
                        </div>

                        <div>
                          <label style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                            CHOOSE FILE (PDF, ZIP, DOC, IMG)
                          </label>
                          <input
                            type="file"
                            onChange={(e) => setResourceUploadData({ ...resourceUploadData, file: e.target.files[0] || null })}
                            style={{ fontSize: "0.8rem", width: "100%" }}
                          />
                        </div>
                      </div>

                      <div>
                        <label style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                          OR EXTERNAL LINK (GOOGLE DRIVE, FIGMA, GITHUB)
                        </label>
                        <input
                          type="url"
                          placeholder="https://..."
                          value={resourceUploadData.externalUrl}
                          onChange={(e) => setResourceUploadData({ ...resourceUploadData, externalUrl: e.target.value })}
                          className="form-field-input"
                          style={{ padding: "8px 12px", fontSize: "0.875rem" }}
                        />
                      </div>

                      <button
                        type="submit"
                        disabled={isUploadingResource}
                        className="btn btn-solid-dark btn-sm"
                        style={{ marginTop: 6 }}
                      >
                        {isUploadingResource ? "Uploading..." : "Publish Resource →"}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 12, maxHeight: 360, overflowY: "auto" }}>
              {platformResources.map((res) => (
                <div
                  key={res.id}
                  style={{
                    padding: "14px 18px",
                    border: "1px solid var(--border-light)",
                    borderRadius: "var(--radius-sm)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    background: "#FFFFFF",
                  }}
                >
                  <div style={{ maxWidth: "72%" }}>
                    <div style={{ fontWeight: 700, fontSize: "0.925rem", color: "var(--text-primary)" }}>{res.title}</div>
                    <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 2 }}>{res.desc}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                      <span className="pill-badge pill-success">{res.type}</span>
                      {res.fileSize && (
                        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{res.fileSize}</span>
                      )}
                      {res.uploaderName && (
                        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                          • By {res.uploaderName}
                        </span>
                      )}
                    </div>
                  </div>
                  <a
                    href={res.fileUrl || "#"}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-outline btn-sm"
                    style={{ textDecoration: "none", flexShrink: 0 }}
                  >
                    Download ↓
                  </a>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 20, textAlign: "right" }}>
              <button className="btn btn-solid-dark" onClick={() => setShowResourcesModal(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Notification Detail Modal Dialog ──────────────────────── */}
      {selectedNotification && (
        <div className="modal-backdrop-overlay" onClick={() => setSelectedNotification(null)}>
          <div className="modal-dialog-box" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 40, height: 40, borderRadius: "50%", background: "var(--primary-learner-light)", color: "var(--primary-learner)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.2rem", flexShrink: 0 }}>
                  🔔
                </div>
                <div>
                  <h3 style={{ fontSize: "1.25rem", fontWeight: 800, color: "var(--text-primary)" }}>{selectedNotification.title}</h3>
                  <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{selectedNotification.time}</span>
                </div>
              </div>
              <button
                className="btn-ghost"
                onClick={() => setSelectedNotification(null)}
                style={{ fontSize: "1.2rem", cursor: "pointer", border: "none" }}
              >
                ✕
              </button>
            </div>

            <div style={{ padding: "16px 0", borderTop: "1px solid var(--border-subtle)", borderBottom: "1px solid var(--border-subtle)", margin: "8px 0 20px" }}>
              <p style={{ color: "var(--text-secondary)", fontSize: "0.95rem", lineHeight: 1.6 }}>
                {selectedNotification.fullMessage || selectedNotification.text}
              </p>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 12 }}>
              {selectedNotification.actionLink && (
                <button
                  className="btn btn-solid-dark btn-sm"
                  onClick={() => {
                    const link = selectedNotification.actionLink;
                    setSelectedNotification(null);
                    navigate(link);
                  }}
                >
                  View Details &rarr;
                </button>
              )}
              <button className="btn btn-outline btn-sm" onClick={() => setSelectedNotification(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Active Search Modal Dialog (Ctrl+K) ───────────────────── */}
      {showSearchModal && (
        <div className="modal-backdrop-overlay" onClick={() => setShowSearchModal(false)}>
          <div
            className="modal-dialog-box"
            style={{ maxWidth: 640, width: "92%", padding: "24px", maxHeight: "85vh", display: "flex", flexDirection: "column" }}
            onClick={e => e.stopPropagation()}
          >
            {/* Search Input Bar */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: "#F8FAFC", border: "1.5px solid var(--primary-learner)", borderRadius: "var(--radius-md)", marginBottom: 14 }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--primary-learner)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
              <input
                type="text"
                autoFocus
                placeholder="Search courses, skills, tools (e.g. AI, Figma, Video)..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                style={{ flex: 1, border: "none", background: "transparent", fontSize: "1rem", outline: "none", color: "var(--text-primary)" }}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: "1.1rem", padding: "0 4px" }}
                  title="Clear search"
                >
                  ✕
                </button>
              )}
              <kbd style={{ fontSize: "0.72rem", background: "#E2E8F0", padding: "2px 6px", borderRadius: 4, color: "var(--text-muted)", fontWeight: 600 }}>ESC</kbd>
            </div>

            {/* Quick Category Filter Chips */}
            <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 8, marginBottom: 12 }}>
              {["All", "Tech & Digital Skills", "Professional Skills"].map(cat => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setSearchCategory(cat)}
                  className={`btn btn-sm ${searchCategory === cat ? "btn-solid-dark" : "btn-outline"}`}
                  style={{ fontSize: "0.78rem", padding: "4px 12px", borderRadius: "99px", whiteSpace: "nowrap" }}
                >
                  {cat}
                </button>
              ))}
            </div>

            {/* Results List */}
            <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 10, paddingRight: 4, minHeight: 180 }}>
              {filteredSearchCourses.length > 0 ? (
                filteredSearchCourses.map(course => (
                  <div
                    key={course.id}
                    onClick={() => {
                      setShowSearchModal(false);
                      navigate(`/course/${course.id}`);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 14,
                      padding: "10px 14px",
                      border: "1px solid var(--border-light)",
                      borderRadius: "var(--radius-sm)",
                      cursor: "pointer",
                      transition: "background 0.15s, border-color 0.15s",
                      background: "#FFFFFF"
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.background = "#F8FAFC";
                      e.currentTarget.style.borderColor = "var(--primary-learner)";
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.background = "#FFFFFF";
                      e.currentTarget.style.borderColor = "var(--border-light)";
                    }}
                  >
                    <img
                      src={course.image}
                      alt={course.title}
                      style={{ width: 48, height: 48, borderRadius: 8, objectFit: "cover", flexShrink: 0 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                        <span className={`pill-badge ${course.badgeClass || "pill-tech"}`} style={{ fontSize: "0.65rem", padding: "1px 6px" }}>
                          {course.badge}
                        </span>
                        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>★ {course.rating} • {course.duration}</span>
                      </div>
                      <div style={{ fontWeight: 700, fontSize: "0.925rem", color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {course.title}
                      </div>
                      <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {course.description}
                      </div>
                    </div>
                    <span style={{ fontSize: "0.85rem", color: "var(--primary-learner)", fontWeight: 600, flexShrink: 0 }}>
                      View &rarr;
                    </span>
                  </div>
                ))
              ) : (
                <div style={{ padding: "36px 16px", textAlign: "center", color: "var(--text-muted)" }}>
                  <div style={{ fontSize: "2rem", marginBottom: 8 }}>🔍</div>
                  <div style={{ fontWeight: 600, fontSize: "1rem", color: "var(--text-primary)", marginBottom: 4 }}>
                    No courses found
                  </div>
                  <div style={{ fontSize: "0.85rem" }}>
                    No results for "{searchQuery}". Try searching for "AI", "Design", "Video", or "Broadcasting".
                  </div>
                </div>
              )}
            </div>

            {/* Footer with Hint and Close Button */}
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border-light)", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.8rem", color: "var(--text-muted)" }}>
              <span>Tip: Press <kbd style={{ background: "#E2E8F0", padding: "2px 5px", borderRadius: 3 }}>Ctrl</kbd> + <kbd style={{ background: "#E2E8F0", padding: "2px 5px", borderRadius: 3 }}>K</kbd> to open search anywhere</span>
              <button
                className="btn btn-outline btn-sm"
                onClick={() => setShowSearchModal(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
