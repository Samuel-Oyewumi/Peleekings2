import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { submitUserMilestone } from "../contexts/userActivity";

export default function About() {
  const { currentUser, userProfile } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, []);

  const [showMilestoneModal, setShowMilestoneModal] = useState(false);
  const [milestoneType, setMilestoneType] = useState("Passing Out Parade (POP)");
  const [fullName, setFullName] = useState(userProfile?.fullName || currentUser?.displayName || "");
  const [details, setDetails] = useState("");
  const [celebrationDate, setCelebrationDate] = useState(new Date().toISOString().split("T")[0]);
  const [submitted, setSubmitted] = useState(false);

  async function handleMilestoneSubmit(e) {
    e.preventDefault();
    if (!fullName.trim() || !details.trim()) return;

    await submitUserMilestone(currentUser?.uid || "guest", {
      fullName: fullName.trim(),
      milestoneType,
      details: details.trim(),
      celebrationDate,
      email: currentUser?.email || userProfile?.email || "visitor"
    });

    setSubmitted(true);
    setTimeout(() => {
      setSubmitted(false);
      setShowMilestoneModal(false);
      setDetails("");
    }, 2500);
  }

  return (
    <div className="about-page-container">
      {/* ── Hero Banner ────────────────────────────────────────────── */}
      <section className="about-hero-section">
        <div className="about-hero-inner">
          <div className="about-badge-pill">
            <span className="badge-dot"></span>
            EMPOWERMENT &amp; CELEBRATION PLATFORM
          </div>
          <h1 className="about-hero-title">
            About Us
          </h1>
          <p className="about-hero-lead">
            We are an empowerment and celebration platform dedicated to helping individuals and organizations celebrate meaningful milestones while preparing for the opportunities ahead.
          </p>
        </div>
      </section>

      {/* ── Mission & Impact Cards ─────────────────────────────────── */}
      <section className="about-content-section">
        <div className="about-content-grid">
          {/* Mission Card */}
          <div className="about-card about-mission-card">
            <div className="about-card-icon-wrap" style={{ background: "rgba(59, 130, 246, 0.1)", color: "var(--primary-learner)" }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
            </div>
            <h2 className="about-card-heading">Our Mission</h2>
            <p className="about-card-text">
              Our mission is to equip Corps Members and young people with practical, monetizable skills that can create pathways to financial independence, career growth, and meaningful opportunities.
            </p>
            <p className="about-card-text" style={{ marginTop: 12 }}>
              Through our training programmes, we help participants develop valuable digital and professional skills while connecting them with clients and employers who recognize and value their expertise.
            </p>
          </div>

          {/* Impact Metric & Track Record Card */}
          <div className="about-card about-impact-card">
            <div className="impact-stat-bubble">
              <span className="impact-number">20+</span>
              <span className="impact-label">Corps Members Trained</span>
            </div>
            <h2 className="about-card-heading" style={{ marginTop: 20 }}>Proven Track Record</h2>
            <p className="about-card-text">
              Having successfully trained over 20 Corps Members in digital skills and other areas of personal and professional development, we continue to create opportunities for young people to learn, grow, and position themselves for the next season of their lives.
            </p>
            <div className="impact-tags-row">
              <span className="impact-tag">Digital Skills</span>
              <span className="impact-tag">Career Acceleration</span>
              <span className="impact-tag">Personal Development</span>
              <span className="impact-tag">Client Connections</span>
            </div>
          </div>
        </div>

        {/* ── Core Philosophy Pillars ───────────────────────────────── */}
        <div className="about-philosophy-banner">
          <div className="philosophy-header">
            <h3 className="philosophy-title">Our Core Philosophy</h3>
            <p className="philosophy-subtitle">
              Whether you are looking to acquire a new skill, advance your career, connect with opportunities, or celebrate an important milestone, we are here to help you make it meaningful.
            </p>
          </div>

          <div className="philosophy-pillars-grid">
            <div className="philosophy-pillar-card">
              <div className="pillar-icon">🎉</div>
              <h4>Celebrate Growth</h4>
              <p>Your growth deserves to be celebrated.</p>
            </div>
            <div className="philosophy-pillar-card">
              <div className="pillar-icon">💎</div>
              <h4>Value Skills</h4>
              <p>Your skills deserve to be valued.</p>
            </div>
            <div className="philosophy-pillar-card">
              <div className="philosophy-icon">🚀</div>
              <h4>Prepare for Next Season</h4>
              <p>Your next season deserves preparation.</p>
            </div>
          </div>
        </div>

        {/* ── Dual Call to Action ───────────────────────────────────── */}
        <div className="about-cta-section">
          <div className="about-cta-card">
            <div className="cta-content">
              <h3 className="cta-headline">Take Your Next Step Today</h3>
              <p className="cta-subhead">
                Click the button below to enroll in a course or celebrate a milestone with us.
              </p>
              <div className="about-btn-row">
                <button
                  id="about-enroll-btn"
                  className="btn btn-solid-dark btn-lg"
                  onClick={() => {
                    navigate("/");
                    setTimeout(() => {
                      const el = document.getElementById("courses-catalog-section");
                      if (el) el.scrollIntoView({ behavior: "smooth" });
                    }, 100);
                  }}
                >
                  Enroll in a Course &rarr;
                </button>
                <button
                  id="about-celebrate-btn"
                  className="btn btn-outline btn-lg"
                  onClick={() => setShowMilestoneModal(true)}
                >
                  Celebrate a Milestone with Us 🎉
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Milestone Celebration Modal ─────────────────────────────── */}
      {showMilestoneModal && (
        <div className="modal-backdrop-overlay" onClick={() => setShowMilestoneModal(false)}>
          <div className="modal-dialog-box milestone-modal-box" onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div>
                <span className="pill-badge pill-tech" style={{ marginBottom: 6 }}>CELEBRATE WITH US</span>
                <h3 style={{ fontSize: "1.45rem", fontWeight: 800 }}>Share Your Milestone 🎉</h3>
              </div>
              <button
                className="btn-ghost"
                onClick={() => setShowMilestoneModal(false)}
                style={{ fontSize: "1.2rem", cursor: "pointer", border: "none" }}
              >
                ✕
              </button>
            </div>

            {submitted ? (
              <div style={{ padding: "32px 16px", textAlign: "center" }}>
                <div style={{ fontSize: "3rem", marginBottom: 12 }}>🎊</div>
                <h4 style={{ fontSize: "1.25rem", fontWeight: 800, color: "var(--primary-learner)", marginBottom: 8 }}>
                  Milestone Received!
                </h4>
                <p style={{ color: "var(--text-secondary)", fontSize: "0.95rem" }}>
                  Congratulations, {fullName}! Your milestone has been logged. Our team is honored to celebrate your growth with you.
                </p>
              </div>
            ) : (
              <form onSubmit={handleMilestoneSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 }}>
                    Your Full Name
                  </label>
                  <input
                    type="text"
                    required
                    value={fullName}
                    onChange={e => setFullName(e.target.value)}
                    placeholder="e.g. Samuel Asuquo / Blessing Udo"
                    style={{
                      width: "100%",
                      padding: "10px 14px",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--border-light)",
                      fontSize: "0.95rem",
                      background: "#F8FAFC"
                    }}
                  />
                </div>

                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 }}>
                    Milestone Category
                  </label>
                  <select
                    value={milestoneType}
                    onChange={e => setMilestoneType(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "10px 14px",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--border-light)",
                      fontSize: "0.95rem",
                      background: "#F8FAFC"
                    }}
                  >
                    <option value="Passing Out Parade (POP)">Passing Out Parade (POP)</option>
                    <option value="Skill Certification / Course Graduation">Skill Certification / Course Graduation</option>
                    <option value="First Client / Monetization Milestone">First Client / Monetization Milestone</option>
                    <option value="New Job / Promotion">New Job / Promotion</option>
                    <option value="Personal / Organization Milestone">Personal / Organization Milestone</option>
                  </select>
                </div>

                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 }}>
                    Tell us about your milestone
                  </label>
                  <textarea
                    required
                    rows="3"
                    value={details}
                    onChange={e => setDetails(e.target.value)}
                    placeholder="Tell us what you accomplished, what skill empowered you, or how Peleekings helped you prepare..."
                    style={{
                      width: "100%",
                      padding: "10px 14px",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--border-light)",
                      fontSize: "0.95rem",
                      background: "#F8FAFC",
                      resize: "vertical"
                    }}
                  />
                </div>

                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 }}>
                    Date of Celebration
                  </label>
                  <input
                    type="date"
                    value={celebrationDate}
                    onChange={e => setCelebrationDate(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "10px 14px",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--border-light)",
                      fontSize: "0.95rem",
                      background: "#F8FAFC"
                    }}
                  />
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => setShowMilestoneModal(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn btn-solid-dark"
                  >
                    Submit Milestone &rarr;
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

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
    </div>
  );
}
