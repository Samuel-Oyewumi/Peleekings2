import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { collection, addDoc, getDocs, query, where, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";
import { getResources, uploadResource, deleteResource } from "../contexts/resourcesService";

export default function BecomeInstructor() {
  const { currentUser, userProfile, isTutor: hasTutorClaim, isAdmin } = useAuth();
  const navigate = useNavigate();

  // Verified tutor or administrator status
  const isTutor = Boolean(hasTutorClaim || isAdmin);
  const [activeTab, setActiveTab] = useState(isTutor ? "dashboard" : "apply");

  useEffect(() => {
    if (!isTutor && activeTab === "dashboard") {
      setActiveTab("apply");
    }
  }, [isTutor, activeTab]);

  // Application form state
  const [formData, setFormData] = useState({
    fullName: currentUser?.displayName || userProfile?.fullName || "",
    courseTitle: "",
    category: "Tech & Digital Skills",
    courseDescription: "",
    learningOutcomes: "",
    syllabus: "",
  });

  useEffect(() => {
    const defaultName = currentUser?.displayName || userProfile?.fullName || "";
    if (defaultName && !formData.fullName) {
      setFormData((prev) => ({ ...prev, fullName: defaultName }));
    }
  }, [currentUser?.displayName, userProfile?.fullName, formData.fullName]);

  const [applied, setApplied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Live Tutor Courses & Analytics State
  const [tutorCourses, setTutorCourses] = useState([]);
  const [loadingCourses, setLoadingCourses] = useState(false);
  const [tutorStats, setTutorStats] = useState({
    totalCourses: 0,
    publishedCourses: 0,
    draftCourses: 0,
    totalEnrolled: 0,
    activeLearners: 0,
    avgCompletion: 0,
  });

  // Tutor Resources State
  const [tutorResources, setTutorResources] = useState([]);
  const [showResourceForm, setShowResourceForm] = useState(false);
  const [resourceData, setResourceData] = useState({
    title: "",
    description: "",
    category: "Tech & Digital Skills",
    courseId: "",
    externalUrl: "",
    file: null,
  });
  const [uploadingResource, setUploadingResource] = useState(false);
  const [deletingResourceId, setDeletingResourceId] = useState(null);
  const [resourceToast, setResourceToast] = useState("");

  useEffect(() => {
    if (!isTutor || !currentUser?.uid) return;
    let isMounted = true;

    async function loadLiveTutorData() {
      setLoadingCourses(true);
      try {
        let coursesList = [];
        if (isAdmin) {
          const snap = await getDocs(collection(db, "courses"));
          coursesList = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        } else {
          const [primarySnap, tutorUidSnap, instructorSnap, assignedSnap] = await Promise.all([
            getDocs(query(collection(db, "courses"), where("tutorId", "==", currentUser.uid))).catch(() => ({ docs: [] })),
            getDocs(query(collection(db, "courses"), where("tutorUid", "==", currentUser.uid))).catch(() => ({ docs: [] })),
            getDocs(query(collection(db, "courses"), where("instructorId", "==", currentUser.uid))).catch(() => ({ docs: [] })),
            getDocs(query(collection(db, "courses"), where("assignedTutors", "array-contains", currentUser.uid))).catch(() => ({ docs: [] })),
          ]);
          const merged = new Map();
          [primarySnap, tutorUidSnap, instructorSnap, assignedSnap].forEach((snap) => {
            (snap.docs || []).forEach((d) => merged.set(d.id, { id: d.id, ...d.data() }));
          });
          coursesList = Array.from(merged.values());
        }

        coursesList = coursesList.filter(
          (c) => c.status !== "deleting" && c.deletionState !== "deleting"
        );

        let allEnrollments = [];
        await Promise.all(
          coursesList.map(async (course) => {
            try {
              const enrSnap = await getDocs(
                query(collection(db, "enrollments"), where("courseId", "==", course.id))
              );
              const courseEnrs = enrSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
              allEnrollments.push(...courseEnrs);
            } catch {
              // Ignore per-course enrollment read errors
            }
          })
        );

        const enrichedCourses = coursesList.map((c) => {
          const cEnrs = allEnrollments.filter(
            (e) => e.courseId === c.id && ["active", "approved"].includes(e.status)
          );
          const avgProg =
            cEnrs.length > 0
              ? Math.round(
                  cEnrs.reduce((acc, item) => acc + (Number(item.progressPercent) || 0), 0) /
                    cEnrs.length
                )
              : 0;
          return {
            ...c,
            studentsCount: cEnrs.length,
            avgProgress: avgProg,
          };
        });

        const activeEnrs = allEnrollments.filter((e) =>
          ["active", "approved"].includes(e.status)
        );
        const overallCompletion =
          activeEnrs.length > 0
            ? Math.round(
                activeEnrs.reduce((acc, item) => acc + (Number(item.progressPercent) || 0), 0) /
                  activeEnrs.length
              )
            : 0;
        const publishedCount = enrichedCourses.filter((c) => c.status === "published").length;
        const draftCount = enrichedCourses.length - publishedCount;

        if (isMounted) {
          setTutorCourses(enrichedCourses);
          setTutorStats({
            totalCourses: enrichedCourses.length,
            publishedCourses: publishedCount,
            draftCourses: draftCount,
            totalEnrolled: allEnrollments.length,
            activeLearners: activeEnrs.length,
            avgCompletion: overallCompletion,
          });
          if (enrichedCourses.length > 0) {
            setResourceData((prev) => ({
              ...prev,
              courseId: prev.courseId || enrichedCourses[0].id,
            }));
          }
        }
      } catch (err) {
        console.warn("Could not load live tutor overview data:", err);
      } finally {
        if (isMounted) setLoadingCourses(false);
      }
    }

    loadLiveTutorData();
    return () => {
      isMounted = false;
    };
  }, [isTutor, isAdmin, currentUser?.uid]);

  useEffect(() => {
    if (!isTutor) return;
    getResources("all")
      .then((res) => {
        if (res) setTutorResources(res);
      })
      .catch((err) => console.warn(err));
  }, [isTutor]);

  async function handleTutorUploadResource(e) {
    e.preventDefault();
    if (!resourceData.title.trim() || (!resourceData.file && !resourceData.externalUrl.trim())) {
      setResourceToast("Please provide a title and either a file or link.");
      setTimeout(() => setResourceToast(""), 4000);
      return;
    }
    if (!resourceData.courseId) {
      setResourceToast("Please select a target course first.");
      setTimeout(() => setResourceToast(""), 4000);
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
              role: isAdmin ? "admin" : hasTutorClaim ? "tutor" : "student",
            }
          : null,
      });
      setTutorResources((prev) => [created, ...prev]);
      setShowResourceForm(false);
      setResourceData({
        title: "",
        description: "",
        category: "Tech & Digital Skills",
        courseId: tutorCourses[0]?.id || "",
        externalUrl: "",
        file: null,
      });
      setResourceToast("✓ Material uploaded successfully! It now reflects on the course page.");
      setTimeout(() => setResourceToast(""), 4000);
    } catch (err) {
      console.error(err);
      setResourceToast(err.message || "Could not upload resource. Please try again.");
      setTimeout(() => setResourceToast(""), 4000);
    } finally {
      setUploadingResource(false);
    }
  }

  async function handleDeleteTutorResource(resItem) {
    if (!resItem?.id) return;
    setDeletingResourceId(resItem.id);
    try {
      await deleteResource(resItem.id, resItem.fileUrl, resItem.storagePath);
      setTutorResources((prev) => prev.filter((r) => r.id !== resItem.id));
      setResourceToast(`✓ Deleted "${resItem.title}".`);
      setTimeout(() => setResourceToast(""), 4000);
    } catch (err) {
      console.error("Failed to delete resource:", err);
      setResourceToast("Failed to delete resource: " + (err.message || "Permission denied"));
      setTimeout(() => setResourceToast(""), 4000);
    } finally {
      setDeletingResourceId(null);
    }
  }

  async function handleApply(e) {
    e.preventDefault();
    if (!currentUser) {
      sessionStorage.setItem("pendingTutorApply", "true");
      navigate("/auth", { state: { mode: "signup", tab: "tutor", pendingTutor: true } });
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      const appData = {
        applicantUid: currentUser.uid,
        fullName: formData.fullName.trim(),
        email: currentUser.email,
        courseTitle: formData.courseTitle.trim(),
        category: formData.category,
        courseDescription: formData.courseDescription.trim(),
        learningOutcomes: formData.learningOutcomes.trim(),
        syllabus: formData.syllabus.trim(),
        status: "pending",
        appliedAt: serverTimestamp(),
      };

      await addDoc(collection(db, "tutorApplications"), appData);
      setApplied(true);
    } catch (err) {
      console.error("Tutor application submission error:", err);
      setError(err.message || "Failed to submit application. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ background: "#F8FAFC", minHeight: "calc(100vh - 68px)", padding: "28px 16px" }}>
      <div style={{ maxWidth: 1140, margin: "0 auto" }}>
        {/* Navigation tabs between Tutor Dashboard and Application */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28, flexWrap: "wrap", gap: 16 }}>
          <div>
            <div className="pill-badge" style={{ background: "#3C181A", color: "#FFFFFF", marginBottom: 8 }}>
              TUTOR PORTAL
            </div>
            <h1 style={{ fontSize: "clamp(1.5rem, 4.5vw, 2rem)", fontWeight: 800, color: "#3C181A" }}>
              {activeTab === "dashboard" && isTutor ? "Welcome back, Tutor 👋" : "Teach on Peleekings"}
            </h1>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.92rem" }}>
              {activeTab === "dashboard" && isTutor
                ? "Manage your assigned courses, track your learners, and inspect live course analytics."
                : "Share your industry expertise and empower learners worldwide."}
            </p>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {isTutor && (
              <>
                <button
                  type="button"
                  className={`btn ${activeTab === "dashboard" ? "btn-solid-dark" : "btn-outline"}`}
                  onClick={() => setActiveTab("dashboard")}
                >
                  Tutor Overview
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => navigate("/teach-portal")}
                >
                  Curriculum Studio &rarr;
                </button>
              </>
            )}
            <button
              type="button"
              className={`btn ${activeTab === "apply" ? "btn-solid-dark" : "btn-outline"}`}
              onClick={() => setActiveTab("apply")}
            >
              Apply to Teach
            </button>
          </div>
        </div>

        {/* ── Tutor Dashboard View (Verified Tutors & Admins Only) ───── */}
        {activeTab === "dashboard" && isTutor && (
          <div>
            {/* Stat Metric Cards */}
            <div className="stats-cards-deck">
              {[
                {
                  label: "Your Courses",
                  val: String(tutorStats.totalCourses),
                  sub: `${tutorStats.publishedCourses} published, ${tutorStats.draftCourses} draft`,
                },
                {
                  label: "Active Learners",
                  val: String(tutorStats.activeLearners),
                  sub: `${tutorStats.totalEnrolled} total enrollment record(s)`,
                },
                {
                  label: "Avg. Completion",
                  val: `${tutorStats.avgCompletion}%`,
                  sub: "Across active enrollments",
                },
                {
                  label: "Course Resources",
                  val: String(tutorResources.length),
                  sub: "Published learning materials",
                },
              ].map((stat) => (
                <div key={stat.label} className="stat-metric-card">
                  <div style={{ fontSize: "0.8rem", fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)", letterSpacing: "0.05em" }}>
                    {stat.label}
                  </div>
                  <div style={{ fontSize: "2rem", fontWeight: 900, color: "var(--text-primary)", margin: "8px 0 4px", fontFamily: "Montserrat, sans-serif" }}>
                    {stat.val}
                  </div>
                  <div style={{ fontSize: "0.775rem", color: "var(--text-secondary)" }}>
                    {stat.sub}
                  </div>
                </div>
              ))}
            </div>

            {/* Courses Management & Analytics Split */}
            <div className="tutor-courses-split">
              {/* Courses List */}
              <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", padding: "20px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
                  <h2 style={{ fontSize: "1.2rem", fontWeight: 800 }}>Your Courses</h2>
                  <button
                    type="button"
                    onClick={() => navigate("/teach-portal")}
                    className="btn btn-solid-dark btn-sm"
                  >
                    Open Curriculum Studio &rarr;
                  </button>
                </div>

                {loadingCourses ? (
                  <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)" }}>
                    Loading your assigned courses...
                  </div>
                ) : tutorCourses.length === 0 ? (
                  <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)", background: "#F8FAFC", borderRadius: 8 }}>
                    No courses are currently assigned to your instructor account. Open the Curriculum Studio to create or manage courses.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    {tutorCourses.map((c) => (
                      <div
                        key={c.id}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          flexWrap: "wrap",
                          gap: 12,
                          padding: "16px",
                          borderRadius: "var(--radius-sm)",
                          border: "1px solid var(--border-light)",
                          background: "#F8FAFC",
                        }}
                      >
                        <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "var(--text-primary)" }}>
                            {c.title}
                          </div>
                          <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 2 }}>
                            {c.studentsCount || 0} active learners &bull; {c.avgProgress || 0}% completion
                          </div>
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                          <span className={`pill-badge ${c.status === "published" ? "pill-success" : "pill-tech"}`}>
                            {c.status === "published" ? "Published" : "Draft"}
                          </span>
                          <button
                            type="button"
                            onClick={() => navigate("/teach-portal")}
                            className="btn btn-outline btn-sm"
                          >
                            Manage Course &rarr;
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Course Analytics Card */}
              <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", padding: "20px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                  <h2 style={{ fontSize: "1.2rem", fontWeight: 800 }}>Course Analytics</h2>
                  <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Live Summary</span>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 24 }}>
                  <div style={{ padding: 12, background: "#F8FAFC", borderRadius: 8 }}>
                    <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Total Enrollments</div>
                    <div style={{ fontSize: "1.3rem", fontWeight: 800, color: "var(--text-primary)" }}>
                      {tutorStats.totalEnrolled}
                    </div>
                  </div>
                  <div style={{ padding: 12, background: "#F8FAFC", borderRadius: 8 }}>
                    <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Active Learners</div>
                    <div style={{ fontSize: "1.3rem", fontWeight: 800, color: "var(--text-primary)" }}>
                      {tutorStats.activeLearners}
                    </div>
                  </div>
                  <div style={{ padding: 12, background: "#F8FAFC", borderRadius: 8 }}>
                    <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Completion Rate</div>
                    <div style={{ fontSize: "1.3rem", fontWeight: 800, color: "var(--primary-learner)" }}>
                      {tutorStats.avgCompletion}%
                    </div>
                  </div>
                  <div style={{ padding: 12, background: "#F8FAFC", borderRadius: 8 }}>
                    <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Published Courses</div>
                    <div style={{ fontSize: "1.3rem", fontWeight: 800, color: "var(--success-text)" }}>
                      {tutorStats.publishedCourses}
                    </div>
                  </div>
                </div>

                {/* Donut progress visual */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "16px 0" }}>
                  <div
                    style={{
                      width: 130,
                      height: 130,
                      borderRadius: "50%",
                      background: `conic-gradient(#EC586E 0% ${tutorStats.avgCompletion}%, #E2E8F0 ${tutorStats.avgCompletion}% 100%)`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <div style={{ width: 96, height: 96, borderRadius: "50%", background: "#FFFFFF", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                      <span style={{ fontSize: "1.4rem", fontWeight: 900, color: "var(--text-primary)" }}>
                        {tutorStats.avgCompletion}%
                      </span>
                      <span style={{ fontSize: "0.68rem", color: "var(--text-muted)", textTransform: "uppercase" }}>
                        Completed
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ── Tutor Course Resources Management Section ────────────── */}
            <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", padding: "20px", marginBottom: 40 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
                <div>
                  <h2 style={{ fontSize: "1.2rem", fontWeight: 800 }}>Course Resources &amp; Downloads</h2>
                  <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>
                    Upload exercise files, cheatsheets, and lecture notes. These materials immediately reflect in the classroom for enrolled students.
                  </p>
                </div>
                <button
                  type="button"
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
                    padding: 18,
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

                    <div className="form-grid-2col">
                      <div>
                        <label style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                          TARGET COURSE
                        </label>
                        <select
                          value={resourceData.courseId}
                          onChange={(e) => setResourceData({ ...resourceData, courseId: e.target.value })}
                          className="form-field-input"
                          required
                        >
                          <option value="">-- Select Target Course --</option>
                          {tutorCourses.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.title}
                            </option>
                          ))}
                          {isAdmin && <option value="platform">Platform-Wide Resource</option>}
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
                    No course resources uploaded yet. Click &ldquo;+ Upload New Material&rdquo; to add your first resource.
                  </div>
                ) : (
                  tutorResources.map((res) => (
                    <div
                      key={res.id}
                      style={{
                        padding: "14px 16px",
                        border: "1px solid var(--border-light)",
                        borderRadius: "var(--radius-sm)",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        flexWrap: "wrap",
                        gap: 12,
                        background: "#F8FAFC",
                      }}
                    >
                      <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "var(--text-primary)" }}>
                          {res.title}
                        </div>
                        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 2 }}>
                          {res.desc || res.description}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                          <span className="pill-badge pill-tech">{res.type}</span>
                          {res.fileSize && (
                            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{res.fileSize}</span>
                          )}
                          <span className="pill-badge pill-solid-dark" style={{ fontSize: "0.7rem" }}>
                            {res.courseId === "platform" ? "Platform-wide" : res.courseId}
                          </span>
                        </div>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <a
                          href={res.fileUrl || "#"}
                          target="_blank"
                          rel="noreferrer"
                          className="btn btn-outline btn-sm"
                          style={{ textDecoration: "none" }}
                        >
                          Download &darr;
                        </a>
                        {(isAdmin || tutorCourses.some((c) => c.id === res.courseId)) && (
                          <button
                            type="button"
                            disabled={deletingResourceId === res.id}
                            onClick={() => handleDeleteTutorResource(res)}
                            className="btn btn-outline btn-sm"
                            style={{ color: "#B91C1C", borderColor: "#FECACA" }}
                          >
                            {deletingResourceId === res.id ? "Deleting..." : "Delete"}
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Tutor Application Form View (Spec Stage 5) ─────────────── */}
        {activeTab === "apply" && (
          <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "var(--radius-lg)", padding: "28px 20px", maxWidth: 720, margin: "0 auto" }}>
            {applied ? (
              <div style={{ textAlign: "center", padding: "24px 0" }}>
                <div style={{ width: 64, height: 64, borderRadius: "50%", background: "var(--success-bg)", color: "var(--success-text)", fontSize: "2rem", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
                  ✓
                </div>
                <h2 style={{ fontSize: "1.5rem", fontWeight: 800, marginBottom: 8 }}>
                  Your Application is Under Review!
                </h2>
                <p style={{ color: "var(--text-secondary)", fontSize: "0.95rem", maxWidth: 460, margin: "0 auto 24px" }}>
                  Thank you for applying to teach on Peleekings. Your application has been submitted to the Admin team for review and approval.
                </p>
                <div style={{ display: "flex", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="btn btn-solid-dark btn-lg"
                    onClick={() => {
                      navigate("/dashboard");
                    }}
                  >
                    Return to Dashboard &rarr;
                  </button>
                  {isTutor && (
                    <button type="button" className="btn btn-outline btn-lg" onClick={() => setActiveTab("dashboard")}>
                      View Tutor Overview
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                <h2 style={{ fontSize: "1.4rem", fontWeight: 800, marginBottom: 8 }}>
                  Apply to Become an Instructor
                </h2>
                <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", marginBottom: 24 }}>
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
                      placeholder="Enter your full name"
                      className="form-field-input"
                      value={formData.fullName}
                      onChange={(e) => setFormData({ ...formData, fullName: e.target.value })}
                    />
                  </div>

                  <div className="form-grid-2col">
                    <div className="form-field-group">
                      <label className="form-field-label">Proposed Course Title</label>
                      <input
                        type="text"
                        required
                        placeholder="e.g. Applied Generative AI & Automation"
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
                      placeholder="Describe what learners will achieve in this course..."
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
                      placeholder="Key skills and projects learners will complete..."
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
                      placeholder={"Module 1: Foundations\nModule 2: Practical Workflows\nModule 3: Capstone Project"}
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
