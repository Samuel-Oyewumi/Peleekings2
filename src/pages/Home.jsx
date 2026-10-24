import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { getUserActivity } from "../contexts/userActivity";
import { COURSES_CATALOG } from "../data/courses";
export { COURSES_CATALOG };

export default function Home() {
  const { currentUser } = useAuth();
  const navigate = useNavigate();
  const [activeFilter, setActiveFilter] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [showPreviewMockup, setShowPreviewMockup] = useState(true);
  const [showHowItWorksModal, setShowHowItWorksModal] = useState(false);
  const [userActivity, setUserActivity] = useState(() => getUserActivity(currentUser?.uid));

  // Redirect authenticated users away from the landing page
  useEffect(() => {
    if (currentUser) {
      navigate("/dashboard", { replace: true });
    }
  }, [currentUser, navigate]);

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

  // Don't render anything while redirecting
  if (currentUser) return null;

  const activeCourse = userActivity?.enrolledCourses?.[0] || {
    id: "ai-essentials",
    title: "AI Essentials & Automation",
    progress: 64,
    currentModule: "Module 4 of 10",
    image: "https://images.unsplash.com/photo-1677442136019-21780ecad995?w=500&auto=format&fit=crop&q=80"
  };

  const filteredCourses = COURSES_CATALOG.filter(course => {
    const matchesFilter = activeFilter === "All" || course.category === activeFilter;
    const matchesSearch =
      course.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      course.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      course.badge.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  return (
    <div className="app-container">
      {/* ── Hero Section (Screen 1) ─────────────────────────────────── */}
      <section className="landing-hero">
        <div className={`hero-content-grid ${!currentUser ? "hero-grid-visitor" : ""}`}>
          {/* Left Hero Column */}
          <div>
            <h1 className="hero-headline">
              Learn practical skills.<br />Build your future.
            </h1>
            <p className="hero-subtext">
              Professional courses designed to help you develop relevant, practical skills through online learning and hands-on training.
            </p>
            <div className="hero-cta-row">
              <button
                className="btn btn-solid-dark btn-lg"
                id="hero-explore-btn"
                onClick={() => {
                  const catalog = document.getElementById("courses-catalog-section");
                  if (catalog) catalog.scrollIntoView({ behavior: "smooth" });
                }}
              >
                Explore Courses &rarr;
              </button>
              <button
                className="btn btn-outline btn-lg"
                id="hero-how-it-works-btn"
                onClick={() => setShowHowItWorksModal(true)}
              >
                How it works
              </button>
            </div>

            {/* Stage 10: Two Large Side-by-Side Role Cards */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 28, maxWidth: 560 }}>
              <Link
                to="/auth"
                state={{ tab: "student", mode: "signup" }}
                style={{
                  background: "#FFFFFF",
                  border: "2px solid #5624D0",
                  borderRadius: "12px",
                  padding: "18px",
                  textDecoration: "none",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  transition: "transform 0.2s ease, box-shadow 0.2s ease",
                }}
              >
                <div>
                  <div style={{ fontSize: "1.4rem", marginBottom: 8 }}>🎓</div>
                  <div style={{ fontWeight: 800, fontSize: "1.05rem", color: "#5624D0", marginBottom: 4 }}>
                    I'm a Student
                  </div>
                  <div style={{ fontSize: "0.825rem", color: "#64748B", lineHeight: 1.4 }}>
                    Browse courses and start learning today.
                  </div>
                </div>
                <div style={{ fontSize: "0.825rem", fontWeight: 700, color: "#5624D0", marginTop: 12 }}>
                  Start Learning &rarr;
                </div>
              </Link>

              <Link
                to="/teach"
                style={{
                  background: "#FFFFFF",
                  border: "2px solid #1C1D1F",
                  borderRadius: "12px",
                  padding: "18px",
                  textDecoration: "none",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  transition: "transform 0.2s ease, box-shadow 0.2s ease",
                }}
              >
                <div>
                  <div style={{ fontSize: "1.4rem", marginBottom: 8 }}>💼</div>
                  <div style={{ fontWeight: 800, fontSize: "1.05rem", color: "#1C1D1F", marginBottom: 4 }}>
                    I'm a Tutor
                  </div>
                  <div style={{ fontSize: "0.825rem", color: "#64748B", lineHeight: 1.4 }}>
                    Apply to teach your own course.
                  </div>
                </div>
                <div style={{ fontSize: "0.825rem", fontWeight: 700, color: "#1C1D1F", marginTop: 12 }}>
                  Teach on Peleekings &rarr;
                </div>
              </Link>
            </div>
          </div>

          {/* Right Hero Column: Floating Dashboard Preview Card (Only visible when logged in) */}
          {currentUser && showPreviewMockup && (
            <div className="hero-floating-mockup">
              <div className="mockup-inner-header">
                <div>
                  <div style={{ fontWeight: 700, fontSize: "1.1rem", color: "var(--text-primary)" }}>
                    Good morning, {currentUser.displayName?.split(" ")[0] || "Learner"} &#128075;
                  </div>
                  <div style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                    Ready to continue learning?
                  </div>
                </div>
                <button
                  className="btn-ghost"
                  style={{ fontSize: "1rem", color: "var(--text-muted)", cursor: "pointer", width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%" }}
                  onClick={() => setShowPreviewMockup(false)}
                  title="Dismiss preview"
                  aria-label="Dismiss preview"
                >
                  &#10005;
                </button>
              </div>

              <div style={{ fontSize: "0.775rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", marginBottom: 10 }}>
                Continue Learning
              </div>

              <div className="mockup-continue-card">
                <div className="mockup-course-thumb">
                  {activeCourse.title.slice(0, 2).toUpperCase()}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "var(--text-primary)", marginBottom: 2 }}>
                    {activeCourse.title}
                  </div>
                  <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 8 }}>
                    {activeCourse.currentModule || "In Progress"}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ flex: 1, height: 6, background: "#E2E8F0", borderRadius: 99, overflow: "hidden" }}>
                      <div style={{ width: `${activeCourse.progress || 0}%`, height: "100%", background: "var(--primary-learner)", borderRadius: 99 }} />
                    </div>
                    <span style={{ fontSize: "0.775rem", fontWeight: 700, color: "var(--text-secondary)" }}>
                      {activeCourse.progress || 0}%
                    </span>
                  </div>
                </div>
                <button
                  className="btn btn-solid-dark btn-sm"
                  onClick={() => navigate(`/course/${activeCourse.id}`)}
                >
                  Continue &rarr;
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── Category Overview ("Explore what you can learn") ─────────── */}
      <section className="category-overview-section" id="learning-paths-section" style={{ scrollMarginTop: "90px" }}>
        <div className="section-title-row">
          <div>
            <h2 style={{ fontSize: "1.75rem", fontWeight: 800, marginBottom: 4 }}>
              Explore what you can learn
            </h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.95rem" }}>
              Gain in-demand skills with our carefully curated courses.
            </p>
          </div>
          <button
            className="btn btn-ghost"
            style={{ fontWeight: 600, color: "var(--primary-learner)" }}
            onClick={() => {
              setActiveFilter("All");
              document.getElementById("courses-catalog-section")?.scrollIntoView({ behavior: "smooth" });
            }}
          >
            View all courses &rarr;
          </button>
        </div>

        <div className="skills-deck-grid">
          {/* Card 1: Tech & Digital Skills */}
          <div className="skill-category-box">
            <div className="skill-box-header">
              <div className="skill-category-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                  <line x1="8" y1="21" x2="16" y2="21"></line>
                  <line x1="12" y1="17" x2="12" y2="21"></line>
                </svg>
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: "1.1rem" }}>Tech &amp; Digital Skills</div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>8 courses available</div>
              </div>
            </div>
            <div className="skill-tags-list">
              <div className="skill-tag-item">Computer &amp; Basic Computing</div>
              <div className="skill-tag-item">Sound Production</div>
              <div className="skill-tag-item">AI Essentials / AI Automation</div>
              <div className="skill-tag-item">Graphic Design</div>
              <div className="skill-tag-item">Photography</div>
              <div className="skill-tag-item">Social Media Management</div>
              <div className="skill-tag-item">Videography &amp; Video Editing</div>
              <div className="skill-tag-item">Livestreaming</div>
            </div>
          </div>

          {/* Card 2: Professional Skills */}
          <div className="skill-category-box">
            <div className="skill-box-header">
              <div className="skill-category-icon" style={{ background: "#EFF6FF", color: "#1D4ED8" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                </svg>
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: "1.1rem" }}>Professional Skills</div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>2 courses available</div>
              </div>
            </div>
            <div className="skill-tags-list">
              <div className="skill-tag-item">Broadcasting &amp; Media</div>
              <div className="skill-tag-item">Project Management &amp; Agile</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Course Catalog Grid (Screen 2) ───────────────────────────── */}
      <section className="catalog-section" id="courses-catalog-section">
        <div className="catalog-header-bar">
          <div>
            <h2 style={{ fontSize: "1.85rem", fontWeight: 800, marginBottom: 4 }}>
              Explore Courses
            </h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.95rem" }}>
              Find the right course to match your career goals.
            </p>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            {/* Filter Pills */}
            <div className="filter-pills-row">
              {["All", "Tech & Digital Skills", "Professional Skills"].map(category => (
                <button
                  key={category}
                  className={`filter-pill-btn ${activeFilter === category ? "active" : ""}`}
                  onClick={() => setActiveFilter(category)}
                >
                  {category}
                </button>
              ))}
            </div>

            {/* Search Input */}
            <div className="search-input-field" style={{ position: "relative" }}>
              <span>&#128269;</span>
              <input
                id="catalog-search-input"
                type="text"
                placeholder="Search courses, skills or instructors..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  style={{
                    position: "absolute",
                    right: 12,
                    top: "50%",
                    transform: "translateY(-50%)",
                    background: "none",
                    border: "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                    padding: 4
                  }}
                  title="Clear search"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Courses Grid */}
        <div className="courses-card-grid">
          {filteredCourses.map(course => (
            <div key={course.id} className="course-card-item">
              <div className="course-card-thumb-wrap">
                <img
                  src={course.image}
                  alt={course.title}
                  loading="lazy"
                  decoding="async"
                  onError={(e) => {
                    e.target.style.display = 'none';
                    e.target.nextSibling.style.display = 'flex';
                  }}
                />
                <div className="course-card-thumb-placeholder" style={{ display: 'none' }}>
                  {course.badge}
                </div>
              </div>

              <div className="course-card-body">
                <div className="course-card-meta-top">
                  <span className={`pill-badge ${course.badgeClass}`}>
                    {course.badge}
                  </span>
                  <div className="star-rating-box">
                    <span>★</span>
                    {course.rating} ({course.reviewsCount})
                  </div>
                </div>

                <h3 className="course-card-title">
                  {course.title}
                </h3>

                <div className="course-card-specs">
                  {course.level} &bull; {course.duration} &bull; {course.modulesCount} Modules
                </div>

                <div className="course-card-footer">
                  <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-primary)" }}>
                    {course.students.toLocaleString()} enrolled
                  </span>
                  <Link
                    to={`/course/${course.id}`}
                    className="btn btn-outline btn-sm"
                    style={{ fontWeight: 600 }}
                  >
                    View Course &rarr;
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── About Us Section (Landing Page Feature) ───────────────── */}
      <section className="landing-about-section" id="about-section">
        <div className="landing-about-inner">
          <div className="landing-about-header">
            <span className="pill-badge pill-tech">ABOUT PELEEKINGS</span>
            <h2 style={{ fontSize: "2rem", fontWeight: 800, margin: "12px 0 8px" }}>
              Empowerment &amp; Celebration Platform
            </h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "1.05rem", maxWidth: 760, margin: "0 auto", lineHeight: 1.6 }}>
              We are an empowerment and celebration platform dedicated to helping individuals and organizations celebrate meaningful milestones while preparing for the opportunities ahead.
            </p>
          </div>

          <div className="landing-about-grid">
            <div className="landing-about-card">
              <div className="landing-about-card-badge">🎯 Our Mission</div>
              <p style={{ color: "var(--text-secondary)", fontSize: "0.95rem", lineHeight: 1.6, marginTop: 8 }}>
                Equipping Corps Members and young people with practical, monetizable skills that create pathways to financial independence, career growth, and meaningful opportunities.
              </p>
            </div>

            <div className="landing-about-card" style={{ background: "linear-gradient(135deg, rgba(37,99,235,0.05) 0%, rgba(37,99,235,0.12) 100%)", border: "1px solid rgba(37,99,235,0.2)" }}>
              <div style={{ fontSize: "2.2rem", fontWeight: 900, color: "var(--primary-learner)", lineHeight: 1 }}>20+</div>
              <div style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--text-primary)", margin: "4px 0 8px" }}>Corps Members Trained</div>
              <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", lineHeight: 1.5 }}>
                Successfully trained in digital and professional skills, opening doors to client connections and career advancement.
              </p>
            </div>

            <div className="landing-about-card">
              <div className="landing-about-card-badge">✨ Core Philosophy</div>
              <p style={{ color: "var(--text-secondary)", fontSize: "0.95rem", lineHeight: 1.6, fontStyle: "italic", marginTop: 8 }}>
                "Your growth deserves to be celebrated. Your skills deserve to be valued. Your next season deserves preparation."
              </p>
            </div>
          </div>

          <div style={{ textAlign: "center", marginTop: 32 }}>
            <Link to="/about" className="btn btn-solid-dark btn-lg" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              Learn More About Us &rarr;
            </Link>
          </div>
        </div>
      </section>

      {/* ── Footer ─────────────────────────────────────────────────── */}
      <footer style={{ background: "#FFFFFF", borderTop: "1px solid var(--border-light)", padding: "32px 40px", marginTop: "auto" }}>
        <div style={{ maxWidth: 1280, margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16 }}>
          <div className="brand-wrapper" style={{ fontSize: "1.1rem" }}>
            <div className="brand-logo-icon" style={{ width: 26, height: 26, fontSize: "0.85rem" }}>P</div>
            <span>Peleekings</span>
          </div>
          <div style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
            &copy; {new Date().getFullYear()} Peleekings Inc. Learn &bull; Practice &bull; Prove &bull; Progress
          </div>
        </div>
      </footer>

      {/* ── How It Works Modal Dialog ───────────────────────────────── */}
      {showHowItWorksModal && (
        <div className="modal-backdrop-overlay" onClick={() => setShowHowItWorksModal(false)}>
          <div className="modal-dialog-box" onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <div>
                <span className="pill-badge pill-tech" style={{ marginBottom: 6 }}>HOW IT WORKS</span>
                <h3 style={{ fontSize: "1.45rem", fontWeight: 800 }}>Mastering Skills on Peleekings</h3>
              </div>
              <button
                className="btn-ghost"
                onClick={() => setShowHowItWorksModal(false)}
                style={{ fontSize: "1.2rem", cursor: "pointer" }}
              >
                ✕
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 20, margin: "20px 0 28px" }}>
              {[
                { step: "01", title: "Select Your Learning Experience", desc: "Choose between 100% self-paced Online Classes or hands-on Instructor-Led Workshops with physical studio sessions." },
                { step: "02", title: "Complete Structured Modular Lessons", desc: "Follow bite-sized video curriculum, download lecture notes, take unit quizzes, and build real portfolio projects." },
                { step: "03", title: "Verify Credentials & Advance", desc: "Pass assessments, receive your official verified Certificate of Completion, and leverage your NYSC code for career opportunities." },
              ].map(item => (
                <div key={item.step} style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                  <div style={{ width: 42, height: 42, borderRadius: "50%", background: "#F1F5F9", color: "var(--primary-learner)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: "1rem", flexShrink: 0 }}>
                    {item.step}
                  </div>
                  <div>
                    <h4 style={{ fontSize: "1.05rem", fontWeight: 700, marginBottom: 4 }}>{item.title}</h4>
                    <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 12 }}>
              <button
                className="btn btn-solid-dark"
                onClick={() => {
                  setShowHowItWorksModal(false);
                  document.getElementById("courses-catalog-section")?.scrollIntoView({ behavior: "smooth" });
                }}
              >
                Explore Courses Now &rarr;
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
