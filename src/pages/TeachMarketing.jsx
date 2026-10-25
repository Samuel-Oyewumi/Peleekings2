import { useNavigate } from "react-router-dom";
import { GraduationCap, Users, BarChart3, Zap } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";

export default function TeachMarketing() {
  const { currentUser, userProfile } = useAuth();
  const navigate = useNavigate();

  const isTutor = userProfile?.role === "tutor" || userProfile?.role === "instructor" || userProfile?.role === "admin";

  function handleGetStarted() {
    if (isTutor) {
      navigate("/teach-portal");
    } else if (currentUser) {
      navigate("/teach-portal");
    } else {
      sessionStorage.setItem("pendingTutorApply", "true");
      navigate("/auth", { state: { mode: "signup", tab: "tutor" } });
    }
  }

  return (
    <div className="teach-marketing-page" style={{ minHeight: "90vh", background: "#FFFFFF" }}>
      {/* Hero Section */}
      <section style={{ padding: "48px 16px 40px", textAlign: "center", maxWidth: 960, margin: "0 auto" }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 16px",
            borderRadius: "99px",
            background: "#FDF2F4",
            color: "#3C181A",
            fontSize: "0.85rem",
            fontWeight: 700,
            marginBottom: 20,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
          }}
        >
          <GraduationCap size={16} aria-hidden="true" /> Teach on Peleekings
        </div>

        <h1
          style={{
            fontSize: "clamp(2rem, 6vw, 3.2rem)",
            fontWeight: 800,
            color: "#3C181A",
            lineHeight: 1.15,
            letterSpacing: "-0.03em",
            marginBottom: 20,
            textWrap: "balance",
          }}
        >
          Turn what you know <br />
          into an <span style={{ color: "#EC586E" }}>accredited course</span>.
        </h1>

        <p
          style={{
            fontSize: "1.2rem",
            color: "#64748B",
            lineHeight: 1.6,
            maxWidth: 680,
            margin: "0 auto 36px",
          }}
        >
          Teach thousands of ambitious NYSC corps members and professionals. We provide the curriculum platform, enrollment tools, and student grading dashboard.
        </p>

        <div style={{ display: "flex", justifyContent: "center", gap: 16 }}>
          <button
            onClick={handleGetStarted}
            className="btn btn-solid-dark btn-lg"
            style={{
              background: "#3C181A",
              color: "#FFFFFF",
              padding: "14px 36px",
              fontSize: "1rem",
              fontWeight: 700,
              borderRadius: "8px",
            }}
          >
            {isTutor ? "Open Teaching Portal →" : "Get started as a tutor →"}
          </button>
        </div>
      </section>

      {/* 3 Value Proposition Cards */}
      <section style={{ padding: "40px 20px 80px", maxWidth: 1140, margin: "0 auto" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
            gap: 20,
          }}
        >
          {/* Card 1 */}
          <div
            style={{
              background: "#FFFFFF",
              border: "1px solid #E5E5E5",
              borderRadius: "12px",
              padding: "32px 28px",
              boxShadow: "none",
            }}
          >
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: "10px",
                background: "#FDF2F4",
                color: "#EC586E",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 20,
              }}
            >
              <Users size={22} aria-hidden="true" />
            </div>
            <h3 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: 10, color: "#3C181A" }}>
              Reach real learners
            </h3>
            <p style={{ fontSize: "0.95rem", color: "#64748B", lineHeight: 1.6, margin: 0 }}>
              Connect directly with verified corps members and learners actively preparing for high-impact tech and professional careers.
            </p>
          </div>

          {/* Card 2 */}
          <div
            style={{
              background: "#FFFFFF",
              border: "1px solid #E5E5E5",
              borderRadius: "12px",
              padding: "32px 28px",
              boxShadow: "none",
            }}
          >
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: "10px",
                background: "#FFF4F0",
                color: "#ED7249",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 20,
              }}
            >
              <BarChart3 size={22} aria-hidden="true" />
            </div>
            <h3 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: 10, color: "#3C181A" }}>
              Your own dashboard
            </h3>
            <p style={{ fontSize: "0.95rem", color: "#64748B", lineHeight: 1.6, margin: 0 }}>
              Track student enrollment velocity, review assignment submissions, issue grades, and broadcast course announcements from a single portal.
            </p>
          </div>

          {/* Card 3 */}
          <div
            style={{
              background: "#FFFFFF",
              border: "1px solid #E5E5E5",
              borderRadius: "12px",
              padding: "32px 28px",
              boxShadow: "none",
            }}
          >
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: "10px",
                background: "#FEF9C3",
                color: "#3C181A",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 20,
              }}
            >
              <Zap size={22} aria-hidden="true" />
            </div>
            <h3 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: 10, color: "#3C181A" }}>
              Simple to get started
            </h3>
            <p style={{ fontSize: "0.95rem", color: "#64748B", lineHeight: 1.6, margin: 0 }}>
              Submit your course proposal in minutes. Our academic team reviews and activates your instructor account quickly so you can start teaching.
            </p>
          </div>
        </div>
      </section>

      {/* Bottom CTA Section */}
      <section
        style={{
          background: "#F8FAFC",
          borderTop: "1px solid #E5E5E5",
          padding: "64px 24px",
          textAlign: "center",
        }}
      >
        <h2 style={{ fontSize: "clamp(1.5rem, 4.5vw, 2rem)", fontWeight: 800, color: "#3C181A", marginBottom: 12 }}>
          Ready to inspire the next generation?
        </h2>
        <p style={{ fontSize: "1rem", color: "#64748B", maxWidth: 520, margin: "0 auto 28px" }}>
          Join Peleekings faculty today and deliver courses that make a lasting difference.
        </p>
        <button
          onClick={handleGetStarted}
          className="btn btn-solid-dark btn-lg"
          style={{
            background: "#3C181A",
            color: "#FFFFFF",
            padding: "14px 36px",
            fontSize: "1rem",
            fontWeight: 700,
            borderRadius: "8px",
          }}
        >
          {isTutor ? "Go to Teaching Portal →" : "Get started →"}
        </button>
      </section>
    </div>
  );
}
