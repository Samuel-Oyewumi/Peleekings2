import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";
import { getResources, uploadResource } from "../contexts/resourcesService";

export default function BecomeInstructor() {
  const { currentUser, userProfile } = useAuth();
  const navigate = useNavigate();

  // If user is already instructor/tutor or toggling to portal view:
  const isTutor = userProfile?.role === "instructor" || userProfile?.role === "tutor" || userProfile?.role === "admin";
  const [activeTab, setActiveTab] = useState(isTutor ? "dashboard" : "apply");

  // Application form state
  const [formData, setFormData] = useState({
    fullName: currentUser?.displayName || "Samuel Asuquo",
    courseTitle: "Applied Generative AI & Automation",
    category: "Tech & Digital Skills",
    courseDescription: "Practical guide to automating corporate workflows using LLMs, APIs, and modern toolchains.",
    learningOutcomes: "Students will build 4 end-to-end automated pipelines and earn an accredited industry certificate.",
    syllabus: "Module 1: Foundations\nModule 2: Tooling & APIs\nModule 3: Production Deployment",
  });

  const [applied, setApplied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Tutor Resources State
  const [tutorResources, setTutorResources] = useState([]);
  const [showResourceForm, setShowResourceForm] = useState(false);
  const [resourceData, setResourceData] = useState({
    title: "",
    description: "",
    category: "Tech & Digital Skills",
    courseId: "ai-essentials",
    externalUrl: "",
    file: null,
  });
  const [uploadingResource, setUploadingResource] = useState(false);
  const [resourceToast, setResourceToast] = useState("");

  useEffect(() => {
    getResources("all")
      .then((res) => {
        if (res) setTutorResources(res);
      })
      .catch((err) => console.warn(err));
  }, []);

  async function handleTutorUploadResource(e) {
    e.preventDefault();
    if (!resourceData.title.trim() || (!resourceData.file && !resourceData.externalUrl.trim())) {
      alert("Please provide a title and either a file or link.");
      return;
    }
    setUploadingResource(true);
    try {
      const created = await uploadResource({
        file: resourceData.file,
        title: resourceData.title,
        description: resourceData.description,
        category: resourceData.category,
        courseId: resourceData.courseId,
        externalUrl: resourceData.externalUrl,
        user: currentUser
          ? {
              uid: currentUser.uid,
              displayName: currentUser.displayName || userProfile?.fullName || "Tutor",
              role: userProfile?.role || "tutor",
            }
          : null,
      });
      setTutorResources((prev) => [created, ...prev]);
      setShowResourceForm(false);
      setResourceData({
        title: "",
        description: "",
        category: "Tech & Digital Skills",
        courseId: "ai-essentials",
        externalUrl: "",
        file: null,
      });
      setResourceToast("✓ Material uploaded successfully! It now reflects on the course page.");
      setTimeout(() => setResourceToast(""), 4000);
    } catch (err) {
      console.error(err);
      alert("Failed to upload resource.");
    } finally {
      setUploadingResource(false);
    }
  }

  async function handleApply(e) {
    e.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      if (!currentUser) {
        navigate("/auth", { state: { mode: "signup", pendingTutor: true } });
        return;
      }

      const appData = {
        applicantUid: currentUser.uid,
        fullName: formData.fullName,
        email: currentUser.email,
        courseTitle: formData.courseTitle,
        category: formData.category,
        courseDescription: formData.courseDescription,
        learningOutcomes: formData.learningOutcomes,
        syllabus: formData.syllabus,
        status: "pending",
        appliedAt: serverTimestamp(),
      };

      try {
        await addDoc(collection(db, "tutorApplications"), appData);
      } catch (fsErr) {
        console.warn("Notice: Firestore write for tutor application:", fsErr);
      }

      try {
        const existingApps = JSON.parse(localStorage.getItem("peleekings_pending_tutor_applications") || "[]");
        localStorage.setItem("peleekings_pending_tutor_applications", JSON.stringify([{ id: `app_${Date.now()}`, ...appData, submittedAt: new Date().toISOString() }, ...existingApps]));
      } catch {}

      setApplied(true);
    } catch (err) {
      console.error(err);
      setError("Failed to submit application. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ background: "#F8FAFC", minHeight: "calc(100vh - 68px)", padding: "40px 20px" }}>
      <div style={{ maxWidth: 1140, margin: "0 auto" }}>
        {/* Navigation tabs between Tutor Dashboard and Application */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32, flexWrap: "wrap", gap: 16 }}>
          <div>
            <div className="pill-badge" style={{ background: "#111827", color: "#FFFFFF", marginBottom: 8 }}>
              TUTOR PORTAL
            </div>
            <h1 style={{ fontSize: "2rem", fontWeight: 800, color: "#0F172A" }}>
              {activeTab === "dashboard" ? "Welcome back, Tutor 👋" : "Teach on Peleekings"}
            </h1>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.95rem" }}>
              {activeTab === "dashboard"
                ? "Manage your courses, track your learners, and inspect course analytics."
                : "Share your industry expertise and empower learners worldwide."}
            </p>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button
              className={`btn ${activeTab === "dashboard" ? "btn-solid-dark" : "btn-outline"}`}
              onClick={() => setActiveTab("dashboard")}
            >
              Tutor Dashboard
            </button>
            <button
              className={`btn ${activeTab === "apply" ? "btn-solid-dark" : "btn-outline"}`}
              onClick={() => setActiveTab("apply")}
            >
              Apply to Teach
            </button>
          </div>
        </div>

        {/* ── Tutor Dashboard View (Screens 7 & 8) ───────────────────── */}
        {activeTab === "dashboard" && (
          <div>
            {/* Stat Metric Cards */}
            <div className="stats-cards-deck">
              {[
                { label: "Your Courses", val: "3", sub: "2 published, 1 draft" },
                { label: "Total Learners", val: "124", sub: "+18 this month" },
                { label: "Avg. Completion", val: "78%", sub: "+5% vs platform avg" },
                { label: "Avg. Test Score", val: "82%", sub: "Top 10% tier" },
              ].map(stat => (
                <div key={stat.label} className="stat-metric-card">
                  <div style={{ fontSize: "0.8rem", fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)", letterSpacing: "0.05em" }}>
                    {stat.label}
                  </div>
                  <div style={{ fontSize: "2rem", fontWeight: 900, color: "var(--text-primary)", margin: "8px 0 4px", fontFamily: "Outfit, sans-serif" }}>
                    {stat.val}
                  </div>
                  <div style={{ fontSize: "0.775rem", color: "var(--text-secondary)" }}>
                    {stat.sub}
                  </div>
                </div>
              ))}
            </div>

            {/* Courses Management & Analytics Split */}
            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 24, marginBottom: 40 }}>
              {/* Courses List */}
              <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", padding: 24 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                  <h2 style={{ fontSize: "1.2rem", fontWeight: 800 }}>Your Courses</h2>
                  <button className="btn btn-solid-dark btn-sm">
                    + Add New Course
                  </button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {[
                    { title: "AI Essentials & Automation", students: 124, progress: 78, status: "Published" },
                    { title: "Graphic Design Fundamentals", students: 86, progress: 64, status: "Published" },
                    { title: "Corporate Workflow Design", students: 0, progress: 0, status: "Draft" },
                  ].map(c => (
                    <div
                      key={c.title}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "16px 18px",
                        borderRadius: "var(--radius-sm)",
                        border: "1px solid var(--border-light)",
                        background: "#F8FAFC",
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "var(--text-primary)" }}>
                          {c.title}
                        </div>
                        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 2 }}>
                          {c.students} active learners &bull; {c.progress}% completion
                        </div>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <span className={`pill-badge ${c.status === "Published" ? "pill-success" : "pill-tech"}`}>
                          {c.status}
                        </span>
                        <button className="btn btn-outline btn-sm">
                          Manage Course &rarr;
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Course Analytics Card (Screen 8) */}
              <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", padding: 24 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                  <h2 style={{ fontSize: "1.2rem", fontWeight: 800 }}>Course Analytics</h2>
                  <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Last 30 Days</span>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 24 }}>
                  <div style={{ padding: 12, background: "#F8FAFC", borderRadius: 8 }}>
                    <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Enrolled</div>
                    <div style={{ fontSize: "1.3rem", fontWeight: 800, color: "var(--text-primary)" }}>124</div>
                  </div>
                  <div style={{ padding: 12, background: "#F8FAFC", borderRadius: 8 }}>
                    <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Active</div>
                    <div style={{ fontSize: "1.3rem", fontWeight: 800, color: "var(--text-primary)" }}>97</div>
                  </div>
                  <div style={{ padding: 12, background: "#F8FAFC", borderRadius: 8 }}>
                    <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Completion Rate</div>
                    <div style={{ fontSize: "1.3rem", fontWeight: 800, color: "var(--primary-learner)" }}>78%</div>
                  </div>
                  <div style={{ padding: 12, background: "#F8FAFC", borderRadius: 8 }}>
                    <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Avg. Test Score</div>
                    <div style={{ fontSize: "1.3rem", fontWeight: 800, color: "var(--success-text)" }}>82%</div>
                  </div>
                </div>

                {/* Donut progress visual */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "20px 0" }}>
                  <div style={{ width: 130, height: 130, borderRadius: "50%", background: "conic-gradient(#5624D0 0% 78%, #E2E8F0 78% 100%)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <div style={{ width: 96, height: 96, borderRadius: "50%", background: "#FFFFFF", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                      <span style={{ fontSize: "1.4rem", fontWeight: 900, color: "var(--text-primary)" }}>78%</span>
                      <span style={{ fontSize: "0.68rem", color: "var(--text-muted)", textTransform: "uppercase" }}>Completed</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ── Tutor Course Resources Management Section ────────────── */}
            <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", padding: 28, marginBottom: 40 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
                <div>
                  <h2 style={{ fontSize: "1.25rem", fontWeight: 800 }}>Course Resources &amp; Downloads</h2>
                  <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>
                    Upload exercise files, cheatsheets, and lecture notes. These materials immediately reflect in the classroom for enrolled students.
                  </p>
                </div>
                <button
                  className="btn btn-solid-dark btn-sm"
                  onClick={() => setShowResourceForm((prev) => !prev)}
                >
                  {showResourceForm ? "✕ Close Form" : "+ Upload New Material"}
                </button>
              </div>

              {resourceToast && (
                <div style={{ background: "#ECFDF5", border: "1px solid #A7F3D0", color: "#065F46", padding: "10px 16px", borderRadius: "var(--radius-sm)", fontSize: "0.85rem", marginBottom: 18 }}>
                  {resourceToast}
                </div>
              )}

              {showResourceForm && (
                <form
                  onSubmit={handleTutorUploadResource}
                  style={{
                    background: "#F8FAFC",
                    border: "1px solid var(--border-light)",
                    borderRadius: "var(--radius-sm)",
                    padding: 20,
                    marginBottom: 24,
                  }}
                >
                  <h3 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: 14 }}>
                    Add Learning Material
                  </h3>

                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div>
                      <label style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                        MATERIAL TITLE *
                      </label>
                      <input
                        type="text"
                        required
                        placeholder="e.g. Module 2 Hands-on Exercise Files"
                        value={resourceData.title}
                        onChange={(e) => setResourceData({ ...resourceData, title: e.target.value })}
                        className="form-field-input"
                      />
                    </div>

                    <div>
                      <label style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                        DESCRIPTION
                      </label>
                      <input
                        type="text"
                        placeholder="What is included in this download?"
                        value={resourceData.description}
                        onChange={(e) => setResourceData({ ...resourceData, description: e.target.value })}
                        className="form-field-input"
                      />
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <div>
                        <label style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                          TARGET COURSE
                        </label>
                        <select
                          value={resourceData.courseId}
                          onChange={(e) => setResourceData({ ...resourceData, courseId: e.target.value })}
                          className="form-field-input"
                        >
                          <option value="ai-essentials">AI Essentials &amp; Automation</option>
                          <option value="computer-basics">Introduction to Computer</option>
                          <option value="photography">Photography Fundamentals</option>
                          <option value="platform">Platform-Wide Resource</option>
                        </select>
                      </div>

                      <div>
                        <label style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                          ATTACH FILE (PDF, ZIP, DOC, IMG)
                        </label>
                        <input
                          type="file"
                          onChange={(e) => setResourceData({ ...resourceData, file: e.target.files[0] || null })}
                          style={{ fontSize: "0.85rem", width: "100%", marginTop: 4 }}
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
                        value={resourceData.externalUrl}
                        onChange={(e) => setResourceData({ ...resourceData, externalUrl: e.target.value })}
                        className="form-field-input"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={uploadingResource}
                      className="btn btn-solid-dark btn-sm"
                      style={{ alignSelf: "flex-start", marginTop: 4 }}
                    >
                      {uploadingResource ? "Uploading..." : "Publish Material →"}
                    </button>
                  </div>
                </form>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {tutorResources.length === 0 ? (
                  <div style={{ textAlign: "center", color: "var(--text-muted)", padding: 20 }}>
                    No course resources uploaded yet. Click "+ Upload New Material" to add your first resource.
                  </div>
                ) : (
                  tutorResources.map((res) => (
                    <div
                      key={res.id}
                      style={{
                        padding: "14px 18px",
                        border: "1px solid var(--border-light)",
                        borderRadius: "var(--radius-sm)",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        background: "#F8FAFC",
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "var(--text-primary)" }}>
                          {res.title}
                        </div>
                        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 2 }}>
                          {res.desc || res.description}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                          <span className="pill-badge pill-tech">{res.type}</span>
                          {res.fileSize && (
                            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{res.fileSize}</span>
                          )}
                          <span className="pill-badge pill-solid-dark" style={{ fontSize: "0.7rem" }}>
                            {res.courseId === "platform" ? "Platform-wide" : res.courseId}
                          </span>
                        </div>
                      </div>

                      <a
                        href={res.fileUrl || "#"}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-outline btn-sm"
                        style={{ textDecoration: "none" }}
                      >
                        Download &darr;
                      </a>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Tutor Application Form View (Spec Stage 5) ─────────────── */}
        {activeTab === "apply" && (
          <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "var(--radius-lg)", padding: 40, maxWidth: 720, margin: "0 auto" }}>
            {applied ? (
              <div style={{ textAlign: "center", padding: "30px 0" }}>
                <div style={{ width: 64, height: 64, borderRadius: "50%", background: "var(--success-bg)", color: "var(--success-text)", fontSize: "2rem", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
                  ✓
                </div>
                <h2 style={{ fontSize: "1.6rem", fontWeight: 800, marginBottom: 8 }}>
                  Your Application is Under Review!
                </h2>
                <p style={{ color: "var(--text-secondary)", fontSize: "0.95rem", maxWidth: 460, margin: "0 auto 24px" }}>
                  Thank you for applying to teach on Peleekings. Our admin team will review your syllabus and get back to you within 48 hours.
                </p>
                <button className="btn btn-solid-dark btn-lg" onClick={() => setActiveTab("dashboard")}>
                  Return to Portal &rarr;
                </button>
              </div>
            ) : (
              <>
                <h2 style={{ fontSize: "1.5rem", fontWeight: 800, marginBottom: 8 }}>
                  Apply to Become an Instructor
                </h2>
                <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", marginBottom: 28 }}>
                  Submit your proposed course outline. Approved tutors gain access to our curriculum studio, live student progress tracking, and monetized cohorts.
                </p>

                {error && (
                  <div style={{ background: "#FEE2E2", color: "#B91C1C", padding: "10px 14px", borderRadius: "var(--radius-sm)", fontSize: "0.85rem", marginBottom: 18 }}>
                    {error}
                  </div>
                )}

                <form onSubmit={handleApply}>
                  <div className="form-field-group">
                    <label className="form-field-label">Full Name / Instructor Name</label>
                    <input
                      type="text"
                      required
                      className="form-field-input"
                      value={formData.fullName}
                      onChange={(e) => setFormData({ ...formData, fullName: e.target.value })}
                    />
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 12 }}>
                    <div className="form-field-group">
                      <label className="form-field-label">Proposed Course Title</label>
                      <input
                        type="text"
                        required
                        className="form-field-input"
                        value={formData.courseTitle}
                        onChange={(e) => setFormData({ ...formData, courseTitle: e.target.value })}
                      />
                    </div>
                    <div className="form-field-group">
                      <label className="form-field-label">Primary Category</label>
                      <select
                        className="form-field-input"
                        value={formData.category}
                        onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                      >
                        <option>Tech &amp; Digital Skills</option>
                        <option>Professional Skills</option>
                        <option>Creative &amp; Design</option>
                      </select>
                    </div>
                  </div>

                  <div className="form-field-group">
                    <label className="form-field-label">Course Description</label>
                    <textarea
                      rows={3}
                      required
                      className="form-field-input"
                      value={formData.courseDescription}
                      onChange={(e) => setFormData({ ...formData, courseDescription: e.target.value })}
                    />
                  </div>

                  <div className="form-field-group">
                    <label className="form-field-label">Key Learning Outcomes</label>
                    <textarea
                      rows={2}
                      required
                      className="form-field-input"
                      value={formData.learningOutcomes}
                      onChange={(e) => setFormData({ ...formData, learningOutcomes: e.target.value })}
                    />
                  </div>

                  <div className="form-field-group">
                    <label className="form-field-label">Proposed Syllabus &amp; Modules</label>
                    <textarea
                      rows={4}
                      required
                      className="form-field-input"
                      value={formData.syllabus}
                      onChange={(e) => setFormData({ ...formData, syllabus: e.target.value })}
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="btn btn-solid-dark btn-lg"
                    style={{ width: "100%", marginTop: 12 }}
                  >
                    {submitting ? "Submitting Application..." : "Submit Application →"}
                  </button>
                </form>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
