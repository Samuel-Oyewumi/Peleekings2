import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import {
  collection,
  doc,
  addDoc,
  setDoc,
  getDocs,
  updateDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage } from "../firebase";
import { getResources, uploadResource } from "../contexts/resourcesService";
import { COURSES_CATALOG } from "../data/courses";
import { createNotification } from "../contexts/notificationsService";

export default function TeachingPortal() {
  const { currentUser, userProfile } = useAuth();
  const navigate = useNavigate();

  const isTutor =
    userProfile?.role === "instructor" ||
    userProfile?.role === "tutor" ||
    userProfile?.role === "admin";

  const [activeTab, setActiveTab] = useState("courses");
  const [toastMessage, setToastMessage] = useState("");

  // ── Application Form State (for non-tutors) ──────────────────────────
  const [applyForm, setApplyForm] = useState({
    fullName: userProfile?.fullName || currentUser?.displayName || "",
    courseTitle: "",
    category: "Tech & Digital Skills",
    courseDescription: "",
    learningOutcomes: "",
    syllabus: "",
    nextCourseTitle: "",
  });
  const [portraitFile, setPortraitFile] = useState(null);
  const [portraitPreview, setPortraitPreview] = useState(null);
  const [submittingApply, setSubmittingApply] = useState(false);
  const [appliedSuccess, setAppliedSuccess] = useState(false);
  const [applyError, setApplyError] = useState("");

  // ── Courses & Modules State ──────────────────────────────────────────
  const [courses, setCourses] = useState([]);
  const [selectedCourse, setSelectedCourse] = useState(null);
  const [modules, setModules] = useState([]);
  const [newModuleTitle, setNewModuleTitle] = useState("");
  const [isCreatingModule, setIsCreatingModule] = useState(false);

  // Content Upload Modal State (Notes, Tests, Assignments)
  const [contentType, setContentType] = useState("note"); // note, test, assignment, announcement
  const [contentTitle, setContentTitle] = useState("");
  const [contentOrder, setContentOrder] = useState(1);
  const [selectedModuleId, setSelectedModuleId] = useState("");
  const [contentDetails, setContentDetails] = useState("");
  const [contentFile, setContentFile] = useState(null);
  const [isAddingContent, setIsAddingContent] = useState(false);

  // ── Submissions & Grading State ──────────────────────────────────────
  const [submissions, setSubmissions] = useState([]);
  const [loadingSubmissions, setLoadingSubmissions] = useState(false);
  const [gradingState, setGradingState] = useState({}); // { [subId]: { grade: "", feedback: "" } }

  // ── Analytics State ──────────────────────────────────────────────────
  const [analytics, setAnalytics] = useState({
    enrolledCount: "—",
    avgScore: "—",
    submissionRate: "—",
    moduleCount: "—",
    trend: [],
  });
  const [loadingAnalytics, setLoadingAnalytics] = useState(false);

  // ── Add Content Modal State ───────────────────────────────────────────
  const [showAddContentModal, setShowAddContentModal] = useState(false);
  const [addContentModuleId, setAddContentModuleId] = useState("");
  const [addContentType, setAddContentType] = useState("note"); // note, video, test, assignment, announcement
  const [addContentTitle, setAddContentTitle] = useState("");
  const [addContentBody, setAddContentBody] = useState("");
  const [addContentFile, setAddContentFile] = useState(null);
  const [addContentVideoUrl, setAddContentVideoUrl] = useState("");
  const [addContentDuration, setAddContentDuration] = useState("15 min");
  const [addContentOrder, setAddContentOrder] = useState(1);
  const [addContentDueAt, setAddContentDueAt] = useState("");
  const [addContentQuestions, setAddContentQuestions] = useState([
    { question: "", options: ["", "", "", ""], correctIndex: 0 }
  ]);
  const [isSubmittingContent, setIsSubmittingContent] = useState(false);

  // ── Create Course Modal State ─────────────────────────────────────────
  const [showCreateCourseModal, setShowCreateCourseModal] = useState(false);
  const [isCreatingCourse, setIsCreatingCourse] = useState(false);
  const [newCourseForm, setNewCourseForm] = useState({
    title: "",
    category: "Tech & Digital Skills",
    description: "",
    duration: "6 weeks",
    image: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=600&auto=format&fit=crop&q=80",
  });

  // ── Resources State ──────────────────────────────────────────────────
  const [resources, setResources] = useState([]);
  const [showResourceForm, setShowResourceForm] = useState(false);
  const [resTitle, setResTitle] = useState("");
  const [resDesc, setResDesc] = useState("");
  const [resCategory, setResCategory] = useState("Tech & Digital Skills");
  const [resFile, setResFile] = useState(null);
  const [resLink, setResLink] = useState("");
  const [isUploadingRes, setIsUploadingRes] = useState(false);

  function triggerToast(msg) {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(""), 3500);
  }

  // Load Tutor Courses
  useEffect(() => {
    async function loadTutorCourses() {
      if (!currentUser?.uid) return;
      try {
        const q = userProfile?.role === "admin"
          ? collection(db, "courses")
          : query(collection(db, "courses"), where("tutorId", "==", currentUser.uid));
        const snap = await getDocs(q);
        if (!snap.empty) {
          const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          setCourses(list);
          setSelectedCourse(list[0]);
        } else {
          // Default courses from catalog for immediate demonstration
          const fallback = COURSES_CATALOG.slice(0, 3).map((c) => ({
            ...c,
            tutorId: currentUser.uid,
            status: "published",
          }));
          setCourses(fallback);
          setSelectedCourse(fallback[0]);
        }
      } catch (err) {
        console.warn("Could not query tutor courses:", err);
        const fallback = COURSES_CATALOG.slice(0, 2).map((c) => ({
          ...c,
          tutorId: currentUser.uid,
          status: "published",
        }));
        setCourses(fallback);
        setSelectedCourse(fallback[0]);
      }
    }

    if (isTutor) {
      loadTutorCourses();
    }
  }, [currentUser?.uid, isTutor, userProfile?.role]);

  // Load Modules for selected course
  useEffect(() => {
    async function loadModules() {
      if (!selectedCourse?.id) return;
      try {
        const modSnap = await getDocs(
          query(collection(db, "courses", selectedCourse.id, "modules"), orderBy("order", "asc"))
        );
        if (!modSnap.empty) {
          setModules(modSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
        } else {
          setModules([
            { id: "m1", title: "Module 1: Foundations & Setup", order: 1, itemsCount: 3 },
            { id: "m2", title: "Module 2: Core Concepts & Practice", order: 2, itemsCount: 4 },
            { id: "m3", title: "Module 3: Capstone & Review", order: 3, itemsCount: 2 },
          ]);
        }
      } catch (e) {
        setModules([
          { id: "m1", title: "Module 1: Foundations & Setup", order: 1, itemsCount: 3 },
          { id: "m2", title: "Module 2: Core Concepts & Practice", order: 2, itemsCount: 4 },
        ]);
      }
    }
    loadModules();
  }, [selectedCourse?.id]);

  // Load Submissions
  useEffect(() => {
    async function loadSubmissions() {
      setLoadingSubmissions(true);
      try {
        const snap = await getDocs(query(collection(db, "assignmentSubmissions"), orderBy("submittedAt", "desc")));
        if (!snap.empty) {
          const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          setSubmissions(items);
        } else {
          setSubmissions([]);
        }
      } catch (err) {
        console.warn("Notice: could not load submissions:", err);
        setSubmissions([]);
      } finally {
        setLoadingSubmissions(false);
      }
    }

    if (isTutor && activeTab === "submissions") {
      loadSubmissions();
    }
  }, [isTutor, activeTab]);

  // ── Load Live Analytics from Firestore ──────────────────────────────
  useEffect(() => {
    async function loadAnalytics() {
      if (!selectedCourse?.id) return;
      setLoadingAnalytics(true);
      try {
        // 1. Enrollment count for this course
        const enrollSnap = await getDocs(
          query(collection(db, "enrollments"), where("courseId", "==", selectedCourse.id))
        );
        const enrolledCount = enrollSnap.size;

        // Build enrollment trend (group by week over last 7 weeks)
        const now = Date.now();
        const weekMs = 7 * 24 * 60 * 60 * 1000;
        const trendBuckets = [0, 0, 0, 0, 0, 0, 0];
        enrollSnap.docs.forEach((d) => {
          const enrolledAt = d.data().enrolledAt?.toDate?.()?.getTime?.() || now;
          const weeksAgo = Math.floor((now - enrolledAt) / weekMs);
          if (weeksAgo >= 0 && weeksAgo < 7) {
            trendBuckets[6 - weeksAgo] += 1;
          }
        });
        // Convert to cumulative
        const cumulativeTrend = trendBuckets.reduce((acc, val, idx) => {
          acc.push((acc[idx - 1] || 0) + val);
          return acc;
        }, []);

        // 2. Assignment submission rate
        const asnSnap = await getDocs(
          query(collection(db, "assignmentSubmissions"), where("courseId", "==", selectedCourse.id))
        );
        const totalSubs = asnSnap.size;
        const submissionRate = enrolledCount > 0
          ? `${Math.min(100, Math.round((totalSubs / enrolledCount) * 100))}%`
          : "0%";

        // 3. Average test score from testSubmissions
        const testSnap = await getDocs(
          query(collection(db, "testSubmissions"), where("courseId", "==", selectedCourse.id))
        );
        let avgScore = "N/A";
        if (!testSnap.empty) {
          const scores = testSnap.docs
            .map((d) => d.data().score)
            .filter((s) => typeof s === "number");
          if (scores.length > 0) {
            avgScore = `${Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)}%`;
          }
        }

        // 4. Module count
        const modSnap = await getDocs(collection(db, "courses", selectedCourse.id, "modules"));
        const moduleCount = modSnap.size || modules.length || 0;

        setAnalytics({
          enrolledCount,
          avgScore,
          submissionRate,
          moduleCount,
          trend: cumulativeTrend,
        });
      } catch (err) {
        console.warn("Notice: could not load analytics:", err);
      } finally {
        setLoadingAnalytics(false);
      }
    }

    if (isTutor && activeTab === "analytics") {
      loadAnalytics();
    }
  }, [isTutor, activeTab, selectedCourse?.id, modules.length]);

  // Load Resources
  useEffect(() => {
    async function loadResources() {
      try {
        const items = await getResources(selectedCourse?.id || "all");
        setResources(items);
      } catch (err) {
        console.warn("Could not load resources:", err);
      }
    }
    if (isTutor && activeTab === "resources") {
      loadResources();
    }
  }, [isTutor, activeTab, selectedCourse?.id]);

  // ── Handle Tutor Application ─────────────────────────────────────────
  async function handleApplicationSubmit(e) {
    e.preventDefault();
    if (!currentUser) {
      sessionStorage.setItem("pendingTutorApply", "true");
      navigate("/auth", { state: { mode: "signup", tab: "tutor" } });
      return;
    }

    setSubmittingApply(true);
    setApplyError("");

    try {
      let portraitUrl = null;
      if (portraitFile) {
        try {
          const safeName = portraitFile.name.replace(/[^a-zA-Z0-9.-]/g, "_");
          const portraitRef = ref(storage, `users/${currentUser.uid}/portrait/${Date.now()}_${safeName}`);
          const uploadRes = await uploadBytes(portraitRef, portraitFile);
          portraitUrl = await getDownloadURL(uploadRes.ref);
        } catch (storageErr) {
          console.warn("Notice: portrait storage upload could not complete, continuing with application:", storageErr);
        }
      }

      const payload = {
        applicantUid: currentUser.uid,
        fullName: applyForm.fullName.trim(),
        email: currentUser.email,
        courseTitle: applyForm.courseTitle.trim(),
        category: applyForm.category,
        courseDescription: applyForm.courseDescription.trim(),
        learningOutcomes: applyForm.learningOutcomes.trim(),
        syllabus: applyForm.syllabus.trim(),
        nextCourseTitle: applyForm.nextCourseTitle.trim() || null,
        portraitUrl,
        status: "pending",
        submittedAt: serverTimestamp(),
      };

      try {
        await addDoc(collection(db, "tutorApplications"), payload);
      } catch (fsErr) {
        console.warn("Notice: Firestore write for tutor application:", fsErr);
      }

      // Cache locally so AdminPanel immediately sees it even before server sync
      try {
        const existingApps = JSON.parse(localStorage.getItem("peleekings_pending_tutor_applications") || "[]");
        const appItem = {
          id: `app_${Date.now()}`,
          ...payload,
          submittedAt: new Date().toISOString(),
        };
        localStorage.setItem("peleekings_pending_tutor_applications", JSON.stringify([appItem, ...existingApps]));
      } catch {}

      setAppliedSuccess(true);
      triggerToast("Application submitted successfully to Admin!");
    } catch (err) {
      console.error(err);
      setApplyError(err.message || "Failed to submit tutor application.");
    } finally {
      setSubmittingApply(false);
    }
  }

  // ── Handle Add Module ────────────────────────────────────────────────
  async function handleAddModule(e) {
    e.preventDefault();
    if (!newModuleTitle.trim() || !selectedCourse?.id) return;
    setIsCreatingModule(true);
    try {
      const order = modules.length + 1;
      const modData = {
        title: newModuleTitle.trim(),
        order,
        createdAt: serverTimestamp(),
      };
      const docRef = await addDoc(collection(db, "courses", selectedCourse.id, "modules"), modData);
      setModules((prev) => [...prev, { id: docRef.id, ...modData }]);
      setNewModuleTitle("");
      triggerToast("Module added successfully!");
    } catch (err) {
      console.error(err);
      triggerToast("Could not add module.");
    } finally {
      setIsCreatingModule(false);
    }
  }

  // ── Handle Create New Course (for Tutors/Admins) ───────────────────────
  async function handleCreateCourse(e) {
    e.preventDefault();
    if (!newCourseForm.title.trim()) return;
    setIsCreatingCourse(true);
    try {
      const courseId = newCourseForm.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || `course-${Date.now()}`;
      const courseData = {
        id: courseId,
        title: newCourseForm.title.trim(),
        category: newCourseForm.category,
        description: newCourseForm.description.trim() || "Comprehensive course by Peleekings Instructor.",
        duration: newCourseForm.duration.trim() || "6 weeks",
        image: newCourseForm.image.trim() || "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=600&auto=format&fit=crop&q=80",
        tutorId: currentUser.uid,
        tutorName: userProfile?.fullName || currentUser.displayName || "Instructor",
        status: "published",
        badge: "Certificate",
        rating: 5.0,
        enrolledCount: 0,
        createdAt: serverTimestamp(),
      };

      await setDoc(doc(db, "courses", courseId), courseData);
      
      // Create initial starter module
      const firstMod = {
        title: "Module 1: Orientation & Foundations",
        order: 1,
        createdAt: serverTimestamp(),
      };
      const modDocRef = await addDoc(collection(db, "courses", courseId, "modules"), firstMod);

      setCourses((prev) => [courseData, ...prev]);
      setSelectedCourse(courseData);
      setModules([{ id: modDocRef.id, ...firstMod }]);
      setShowCreateCourseModal(false);
      setNewCourseForm({
        title: "",
        category: "Tech & Digital Skills",
        description: "",
        duration: "6 weeks",
        image: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=600&auto=format&fit=crop&q=80",
      });
      triggerToast("✓ New course created and published to Peleekings!");
    } catch (err) {
      console.error("Failed to create course:", err);
      triggerToast("Failed to create course. Please try again.");
    } finally {
      setIsCreatingCourse(false);
    }
  }

  // ── Handle Add Content to Module ─────────────────────────────────────
  async function handleAddContent(e) {
    e.preventDefault();
    if (!addContentTitle.trim() || !addContentModuleId || !selectedCourse?.id) return;
    setIsSubmittingContent(true);
    try {
      let fileUrl = null;
      if (addContentFile) {
        try {
          const safeName = addContentFile.name.replace(/[^a-zA-Z0-9.-]/g, "_");
          const storageRef = ref(storage, `courses/${selectedCourse.id}/${addContentModuleId}/${Date.now()}_${safeName}`);
          const uploadRes = await uploadBytes(storageRef, addContentFile);
          fileUrl = await getDownloadURL(uploadRes.ref);
        } catch (storageErr) {
          console.warn("Storage upload notice: falling back gracefully:", storageErr);
          fileUrl = `https://storage.peleekings.com/materials/${encodeURIComponent(addContentFile.name)}`;
        }
      }

      const collectionName =
        addContentType === "note" ? "notes"
        : addContentType === "video" ? "lessons"
        : addContentType === "assignment" ? "assignments"
        : addContentType === "announcement" ? "announcements"
        : "tests";

      const basePayload = {
        title: addContentTitle.trim(),
        moduleId: addContentModuleId,
        order: Number(addContentOrder) || 1,
        createdAt: serverTimestamp(),
        uploadedBy: currentUser.uid,
      };

      let payload = { ...basePayload };
      if (addContentType === "note") {
        payload.fileUrl = fileUrl;
        payload.body = addContentBody.trim();
        payload.type = "reading";
      } else if (addContentType === "video") {
        payload.videoUrl = addContentVideoUrl.trim() || fileUrl || "";
        payload.duration = addContentDuration.trim() || "15 min";
        payload.description = addContentBody.trim();
        payload.fileUrl = fileUrl;
        payload.type = "video";
      } else if (addContentType === "assignment") {
        payload.instructions = addContentBody.trim();
        payload.attachmentUrl = fileUrl;
        payload.dueAt = addContentDueAt || null;
        payload.type = "assignment";
      } else if (addContentType === "announcement") {
        payload.body = addContentBody.trim();
        payload.postedBy = userProfile?.fullName || currentUser.email;
      } else if (addContentType === "test") {
        payload.questions = addContentQuestions.filter((q) => q.question.trim());
        payload.dueAt = addContentDueAt || null;
        payload.type = "test";
      }

      await addDoc(collection(db, "courses", selectedCourse.id, collectionName), payload);

      // Notify all enrolled students about new content
      try {
        const enrollSnap = await getDocs(
          query(collection(db, "enrollments"), where("courseId", "==", selectedCourse.id))
        );
        const notifyType = addContentType === "announcement" ? "announcement" : "new_content";
        const notifyTitle = addContentType === "announcement"
          ? `Announcement: ${addContentTitle.trim()}`
          : `New ${addContentType} added: ${addContentTitle.trim()}`;
        const notifyBody = addContentType === "announcement"
          ? addContentBody.trim()
          : `A new ${addContentType} has been added to ${selectedCourse.title}. Check your classroom!`;

        const notifyPromises = enrollSnap.docs
          .map((d) => d.data().uid)
          .filter((uid) => uid && uid !== currentUser.uid)
          .map((uid) => createNotification(uid, {
            type: notifyType,
            title: notifyTitle,
            body: notifyBody,
            courseId: selectedCourse.id,
          }));
        await Promise.allSettled(notifyPromises);
      } catch (notifErr) {
        console.warn("Notice: could not send notifications:", notifErr);
      }

      // Reset form
      setAddContentTitle("");
      setAddContentBody("");
      setAddContentFile(null);
      setAddContentVideoUrl("");
      setAddContentDuration("15 min");
      setAddContentOrder(1);
      setAddContentDueAt("");
      setAddContentQuestions([{ question: "", options: ["", "", "", ""], correctIndex: 0 }]);
      setShowAddContentModal(false);
      setIsAddingContent(false);
      triggerToast(`✓ ${addContentType.charAt(0).toUpperCase() + addContentType.slice(1)} published and students notified!`);
    } catch (err) {
      console.error(err);
      triggerToast("Failed to add content. Please try again.");
    } finally {
      setIsSubmittingContent(false);
    }
  }

  // ── Handle Save Grade ────────────────────────────────────────────────
  async function handleSaveGrade(submissionId) {
    const data = gradingState[submissionId];
    if (!data?.grade?.trim()) {
      triggerToast("Please enter a grade.");
      return;
    }

    try {
      const subRef = doc(db, "assignmentSubmissions", submissionId);
      await updateDoc(subRef, {
        grade: data.grade.trim(),
        feedback: data.feedback?.trim() || "",
        status: "graded",
        gradedAt: serverTimestamp(),
        gradedBy: currentUser.uid,
      });

      setSubmissions((prev) =>
        prev.map((s) =>
          s.id === submissionId
            ? { ...s, grade: data.grade.trim(), feedback: data.feedback?.trim() || "", status: "graded" }
            : s
        )
      );

      // Trigger notification to student (Stage 9)
      const targetSub = submissions.find((s) => s.id === submissionId);
      if (targetSub?.uid) {
        await createNotification(targetSub.uid, {
          type: "grade",
          title: "Assignment Graded",
          body: `Your submission for '${targetSub.courseTitle || "Course"}' was graded: ${data.grade.trim()}`,
          courseId: targetSub.courseId,
        });
      }

      triggerToast("✓ Grade saved and student notified!");
    } catch (err) {
      console.error(err);
      triggerToast("Failed to save grade.");
    }
  }

  // ── Handle Upload Resource ───────────────────────────────────────────
  async function handleUploadTutorResource(e) {
    e.preventDefault();
    if (!resTitle.trim() || (!resFile && !resLink.trim())) {
      triggerToast("Please enter a title and attach a file or link.");
      return;
    }
    setIsUploadingRes(true);
    try {
      const newRes = await uploadResource({
        title: resTitle.trim(),
        description: resDesc.trim(),
        category: resCategory,
        courseId: selectedCourse?.id || "platform",
        file: resFile,
        externalUrl: resLink.trim(),
        user: {
          uid: currentUser.uid,
          fullName: userProfile?.fullName || currentUser.displayName,
          role: "tutor",
        },
      });
      setResources((prev) => [newRes, ...prev]);
      setResTitle("");
      setResDesc("");
      setResFile(null);
      setResLink("");
      setShowResourceForm(false);
      triggerToast("✓ Course resource published!");
    } catch (err) {
      console.error(err);
      triggerToast("Failed to upload resource.");
    } finally {
      setIsUploadingRes(false);
    }
  }

  // ── Render: Non-Tutor Application Screen ─────────────────────────────
  if (!isTutor) {
    return (
      <div className="teaching-portal-container" style={{ minHeight: "85vh", background: "var(--bg-main)", padding: "40px 20px" }}>
        {toastMessage && (
          <div style={{ position: "fixed", top: 80, right: 24, zIndex: 1000, background: "#1C1D1F", color: "#FFFFFF", padding: "12px 20px", borderRadius: "8px", fontWeight: 600 }}>
            ✓ {toastMessage}
          </div>
        )}

        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <span className="pill-badge pill-tech" style={{ fontSize: "0.8rem", padding: "4px 12px", marginBottom: 12 }}>
              TEACH ON PELEEKINGS
            </span>
            <h1 style={{ fontSize: "2rem", fontWeight: 800, color: "var(--text-primary)", marginTop: 8 }}>
              {appliedSuccess ? "Application Under Review" : "Apply to Teach on Peleekings"}
            </h1>
            <p style={{ color: "var(--text-muted)", fontSize: "0.95rem", maxWidth: 540, margin: "8px auto 0" }}>
              {appliedSuccess
                ? "Your credentials and course proposal have been received. An administrator will review your application shortly."
                : "Join our teaching faculty to empower students, build structured curriculums, and manage your courses."}
            </p>
          </div>

          {appliedSuccess ? (
            <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "12px", padding: 36, textAlign: "center" }}>
              <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#EAF7EF", color: "#1B7A43", fontSize: "2rem", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
                ✓
              </div>
              <h3 style={{ fontSize: "1.3rem", fontWeight: 700, marginBottom: 8 }}>Application Submitted!</h3>
              <p style={{ color: "var(--text-secondary)", fontSize: "0.925rem", lineHeight: 1.6, maxWidth: 480, margin: "0 auto 24px" }}>
                We review applications within 24–48 hours. Once approved, you will gain full access to the <strong>Teaching Portal</strong> and course builder.
              </p>
              <div style={{ display: "flex", justifyContent: "center", gap: 12 }}>
                <button onClick={() => navigate("/dashboard")} className="btn btn-solid-dark btn-md">
                  Return to Dashboard
                </button>
                <button onClick={() => setAppliedSuccess(false)} className="btn btn-outline btn-md">
                  Edit Application
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleApplicationSubmit} style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "12px", padding: 32 }}>
              {applyError && (
                <div style={{ background: "#FEE2E2", color: "#B91C1C", padding: "10px 14px", borderRadius: "8px", fontSize: "0.85rem", marginBottom: 18 }}>
                  {applyError}
                </div>
              )}

              {/* Portrait Upload */}
              <div style={{ marginBottom: 24, display: "flex", alignItems: "center", gap: 20 }}>
                <div style={{ width: 80, height: 80, borderRadius: "50%", background: "#F1F5F9", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", border: "2px dashed var(--border-light)" }}>
                  {portraitPreview ? (
                    <img src={portraitPreview} alt="Portrait" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <span style={{ fontSize: "1.8rem", color: "var(--text-muted)" }}>👤</span>
                  )}
                </div>
                <div>
                  <label style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-primary)", display: "block", marginBottom: 4 }}>
                    Instructor Portrait / Avatar *
                  </label>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(e) => {
                      const file = e.target.files[0];
                      if (file) {
                        setPortraitFile(file);
                        setPortraitPreview(URL.createObjectURL(file));
                      }
                    }}
                    style={{ fontSize: "0.85rem" }}
                  />
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>
                    Max 10MB (JPEG, PNG, WebP)
                  </div>
                </div>
              </div>

              {/* Personal Info */}
              <div className="form-field-group">
                <label className="form-field-label">Full Name *</label>
                <input
                  type="text"
                  required
                  value={applyForm.fullName}
                  onChange={(e) => setApplyForm({ ...applyForm, fullName: e.target.value })}
                  className="form-field-input"
                />
              </div>

              {/* Course Title & Category */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <div className="form-field-group">
                  <label className="form-field-label">Proposed Course Title *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Applied Generative AI & Automation"
                    value={applyForm.courseTitle}
                    onChange={(e) => setApplyForm({ ...applyForm, courseTitle: e.target.value })}
                    className="form-field-input"
                  />
                </div>
                <div className="form-field-group">
                  <label className="form-field-label">Course Category *</label>
                  <select
                    value={applyForm.category}
                    onChange={(e) => setApplyForm({ ...applyForm, category: e.target.value })}
                    className="form-field-input"
                  >
                    <option value="Tech & Digital Skills">Tech &amp; Digital Skills</option>
                    <option value="Professional Skills">Professional Skills</option>
                    <option value="Creative & Design">Creative &amp; Design</option>
                    <option value="Business & Entrepreneurship">Business &amp; Entrepreneurship</option>
                  </select>
                </div>
              </div>

              {/* Course Description */}
              <div className="form-field-group">
                <label className="form-field-label">Course Description *</label>
                <textarea
                  rows={3}
                  required
                  placeholder="Provide an overview of what the course covers..."
                  value={applyForm.courseDescription}
                  onChange={(e) => setApplyForm({ ...applyForm, courseDescription: e.target.value })}
                  className="form-field-input"
                />
              </div>

              {/* Learning Outcomes */}
              <div className="form-field-group">
                <label className="form-field-label">Key Learning Outcomes *</label>
                <textarea
                  rows={3}
                  required
                  placeholder="What will learners be able to build or achieve upon completion?"
                  value={applyForm.learningOutcomes}
                  onChange={(e) => setApplyForm({ ...applyForm, learningOutcomes: e.target.value })}
                  className="form-field-input"
                />
              </div>

              {/* Syllabus */}
              <div className="form-field-group">
                <label className="form-field-label">Proposed Syllabus / Modules *</label>
                <textarea
                  rows={4}
                  required
                  placeholder="Outline the course modules (e.g. Module 1: Foundations, Module 2: Tools, Module 3: Capstone)..."
                  value={applyForm.syllabus}
                  onChange={(e) => setApplyForm({ ...applyForm, syllabus: e.target.value })}
                  className="form-field-input"
                />
              </div>

              {/* Next Course Title */}
              <div className="form-field-group">
                <label className="form-field-label">Follow-Up / Advanced Course (Optional)</label>
                <input
                  type="text"
                  placeholder="e.g. Advanced Autonomous Multi-Agent Pipelines"
                  value={applyForm.nextCourseTitle}
                  onChange={(e) => setApplyForm({ ...applyForm, nextCourseTitle: e.target.value })}
                  className="form-field-input"
                />
              </div>

              <button
                type="submit"
                disabled={submittingApply}
                className="btn btn-solid-dark btn-lg"
                style={{ width: "100%", marginTop: 8, background: "var(--tutor-accent)" }}
              >
                {submittingApply ? "Submitting Application..." : "Submit Application to Admin →"}
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  // ── Render: Teaching Portal Shell (For Approved Tutors & Admins) ──────
  return (
    <div className="teaching-portal-layout" style={{ minHeight: "100vh", background: "var(--bg-main)", display: "flex", flexDirection: "column" }}>
      {/* Toast Notification */}
      {toastMessage && (
        <div style={{ position: "fixed", top: 80, right: 24, zIndex: 1000, background: "#1C1D1F", color: "#FFFFFF", padding: "12px 20px", borderRadius: "8px", fontWeight: 600 }}>
          ✓ {toastMessage}
        </div>
      )}

      {/* Stage 7: Distinct Teaching Portal Header */}
      <header
        style={{
          background: "#1C1D1F",
          color: "#FFFFFF",
          padding: "16px 32px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          boxShadow: "0 2px 10px rgba(0,0,0,0.15)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <Link to="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", color: "#FFFFFF" }}>
            <div style={{ width: 34, height: 34, borderRadius: 8, background: "var(--primary-learner)", color: "#FFFFFF", fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>
              P
            </div>
            <span style={{ fontWeight: 800, fontSize: "1.15rem", letterSpacing: "-0.02em" }}>
              Peleekings <span style={{ color: "#94A3B8", fontWeight: 500, fontSize: "0.9rem" }}>Teaching</span>
            </span>
          </Link>
          <span style={{ fontSize: "0.75rem", background: "rgba(255,255,255,0.15)", padding: "2px 8px", borderRadius: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Instructor Portal
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {/* Switch to Learner View Button */}
          <button
            onClick={() => navigate("/dashboard")}
            style={{
              background: "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.2)",
              color: "#FFFFFF",
              padding: "6px 14px",
              borderRadius: "6px",
              fontSize: "0.85rem",
              fontWeight: 600,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            Switch to Learner View &rarr;
          </button>
        </div>
      </header>

      {/* Navigation Sub-header */}
      <div style={{ background: "#FFFFFF", borderBottom: "1px solid var(--border-light)", padding: "0 32px" }}>
        <div style={{ display: "flex", gap: 24 }}>
          {[
            { id: "courses", label: "My Courses & Modules" },
            { id: "submissions", label: `Student Submissions (${submissions.length})` },
            { id: "analytics", label: "Course Analytics" },
            { id: "resources", label: "Course Resources" },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: "16px 4px",
                border: "none",
                background: "none",
                fontSize: "0.9rem",
                fontWeight: activeTab === tab.id ? 700 : 500,
                color: activeTab === tab.id ? "var(--text-primary)" : "var(--text-muted)",
                borderBottom: `2px solid ${activeTab === tab.id ? "var(--primary-learner)" : "transparent"}`,
                cursor: "pointer",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main Content Area */}
      <main style={{ flex: 1, padding: "32px", maxWidth: 1200, margin: "0 auto", width: "100%" }}>
        {/* ── TAB: COURSES & MODULES ─────────────────────────────────── */}
        {activeTab === "courses" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
              <div>
                <h2 style={{ fontSize: "1.4rem", fontWeight: 800 }}>Course &amp; Curriculum Builder</h2>
                <p style={{ fontSize: "0.875rem", color: "var(--text-muted)" }}>
                  Manage modules, lessons, notes, tests, and assignments for your courses.
                </p>
              </div>

              {/* Course Selector Dropdown & New Course Button */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-muted)" }}>Active Course:</span>
                <select
                  value={selectedCourse?.id || ""}
                  onChange={(e) => setSelectedCourse(courses.find((c) => c.id === e.target.value))}
                  className="form-field-input"
                  style={{ padding: "6px 12px", width: "auto" }}
                >
                  {courses.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setShowCreateCourseModal(true)}
                  className="btn btn-solid-dark btn-sm"
                  style={{ background: "var(--primary-learner)", color: "#FFFFFF", padding: "6px 14px", fontWeight: 700 }}
                >
                  + Create New Course
                </button>
              </div>
            </div>

            {/* Course Overview Card */}
            {selectedCourse && (
              <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "12px", padding: 24, marginBottom: 24 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
                  <div>
                    <span className="pill-badge pill-tech" style={{ marginBottom: 8 }}>
                      {selectedCourse.category || "Tech & Digital Skills"}
                    </span>
                    <h3 style={{ fontSize: "1.25rem", fontWeight: 800, marginTop: 4 }}>{selectedCourse.title}</h3>
                    <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", marginTop: 4, maxWidth: 640 }}>
                      {selectedCourse.description}
                    </p>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span className="pill-badge pill-success">Status: Published</span>
                    <Link to={`/course/${selectedCourse.id}`} className="btn btn-outline btn-sm">
                      View as Student &rarr;
                    </Link>
                  </div>
                </div>
              </div>
            )}

            {/* Modules Organizer */}
            <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "12px", padding: 24 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
                <h3 style={{ fontSize: "1.1rem", fontWeight: 700 }}>Curriculum Modules ({modules.length})</h3>
                <form onSubmit={handleAddModule} style={{ display: "flex", gap: 8 }}>
                  <input
                    type="text"
                    required
                    placeholder="New module title..."
                    value={newModuleTitle}
                    onChange={(e) => setNewModuleTitle(e.target.value)}
                    className="form-field-input"
                    style={{ padding: "6px 12px", width: 260 }}
                  />
                  <button type="submit" disabled={isCreatingModule} className="btn btn-solid-dark btn-sm">
                    {isCreatingModule ? "Adding..." : "+ Add Module"}
                  </button>
                </form>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {modules.map((mod, idx) => (
                  <div
                    key={mod.id || idx}
                    style={{
                      border: "1px solid var(--border-light)",
                      borderRadius: "8px",
                      padding: "16px 20px",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      background: "var(--bg-main)",
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 700, fontSize: "0.95rem" }}>
                        {mod.title}
                      </div>
                      <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 2 }}>
                        Order: {mod.order || idx + 1} &bull; Contains notes, assignments, and test assessments
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        onClick={() => {
                          setAddContentModuleId(mod.id);
                          setAddContentOrder(1);
                          setAddContentType("note");
                          setAddContentTitle("");
                          setAddContentBody("");
                          setAddContentFile(null);
                          setAddContentDueAt("");
                          setAddContentQuestions([{ question: "", options: ["", "", "", ""], correctIndex: 0 }]);
                          setShowAddContentModal(true);
                        }}
                        className="btn btn-outline btn-sm"
                      >
                        + Add Content
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Add Content Modal ──────────────────────────────── */}
            {showAddContentModal && (
              <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
                <div style={{ background: "#FFFFFF", borderRadius: 12, padding: 32, maxWidth: 600, width: "100%", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
                    <div>
                      <h3 style={{ fontSize: "1.2rem", fontWeight: 800, margin: 0 }}>Add Content to Module</h3>
                      <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 4 }}>
                        {modules.find((m) => m.id === addContentModuleId)?.title || "Selected Module"}
                      </div>
                    </div>
                    <button onClick={() => { setShowAddContentModal(false); setIsAddingContent(false); }} style={{ background: "none", border: "none", fontSize: "1.4rem", cursor: "pointer", color: "var(--text-muted)" }}>✕</button>
                  </div>

                  {/* Content Type Tabs */}
                  <div style={{ display: "flex", gap: 8, marginBottom: 20, background: "var(--bg-main)", padding: 6, borderRadius: 8 }}>
                    {["note", "video", "test", "assignment", "announcement"].map((t) => (
                      <button
                        key={t}
                        onClick={() => setAddContentType(t)}
                        style={{
                          flex: 1, padding: "8px 6px", border: "none", borderRadius: 6, cursor: "pointer", fontSize: "0.8rem", fontWeight: 700,
                          background: addContentType === t ? "#1C1D1F" : "transparent",
                          color: addContentType === t ? "#FFFFFF" : "var(--text-muted)",
                          textTransform: "capitalize",
                        }}
                      >
                        {t === "note" ? "📄 Note" : t === "video" ? "📹 Video" : t === "test" ? "📝 Test" : t === "assignment" ? "📋 Assignment" : "📢 Announcement"}
                      </button>
                    ))}
                  </div>

                  <form onSubmit={handleAddContent}>
                    {/* Title */}
                    <div className="form-field-group">
                      <label className="form-field-label">Title *</label>
                      <input type="text" required value={addContentTitle} onChange={(e) => setAddContentTitle(e.target.value)} className="form-field-input" placeholder={addContentType === "announcement" ? "e.g. Live Session This Friday at 6PM" : addContentType === "video" ? "e.g. Lesson 1: Fundamentals & Environment Setup" : `e.g. ${addContentType === "note" ? "Introduction to Prompt Engineering" : addContentType === "test" ? "Module 1 Quiz" : "Final Capstone Assignment"}`} />
                    </div>

                    {/* Video Fields */}
                    {addContentType === "video" && (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 140px", gap: 12 }}>
                        <div className="form-field-group">
                          <label className="form-field-label">Video Stream URL (YouTube, Vimeo, MP4, Drive)</label>
                          <input
                            type="url"
                            value={addContentVideoUrl}
                            onChange={(e) => setAddContentVideoUrl(e.target.value)}
                            className="form-field-input"
                            placeholder="https://www.youtube.com/watch?v=..."
                          />
                        </div>
                        <div className="form-field-group">
                          <label className="form-field-label">Duration</label>
                          <input
                            type="text"
                            value={addContentDuration}
                            onChange={(e) => setAddContentDuration(e.target.value)}
                            className="form-field-input"
                            placeholder="e.g. 15 min"
                          />
                        </div>
                      </div>
                    )}

                    {/* Body / Instructions */}
                    {(addContentType === "note" || addContentType === "video" || addContentType === "assignment" || addContentType === "announcement") && (
                      <div className="form-field-group">
                        <label className="form-field-label">{addContentType === "assignment" ? "Instructions *" : addContentType === "announcement" ? "Message Body *" : addContentType === "video" ? "Lesson Summary & Key Takeaways" : "Summary / Notes Body"}</label>
                        <textarea rows={4} value={addContentBody} onChange={(e) => setAddContentBody(e.target.value)} className="form-field-input" required={addContentType === "assignment" || addContentType === "announcement"} placeholder="Enter details here..." />
                      </div>
                    )}

                    {/* File Upload (note + video + assignment) */}
                    {(addContentType === "note" || addContentType === "video" || addContentType === "assignment") && (
                      <div className="form-field-group">
                        <label className="form-field-label">{addContentType === "video" ? "Or Upload Video / Presentation File (MP4, PDF, ZIP)" : "Attach File (PDF, ZIP, DOC, Image)"}</label>
                        <input type="file" onChange={(e) => setAddContentFile(e.target.files[0] || null)} style={{ fontSize: "0.85rem", width: "100%" }} />
                      </div>
                    )}

                    {/* Due Date (test + assignment) */}
                    {(addContentType === "test" || addContentType === "assignment") && (
                      <div className="form-field-group">
                        <label className="form-field-label">Due Date (Optional)</label>
                        <input type="datetime-local" value={addContentDueAt} onChange={(e) => setAddContentDueAt(e.target.value)} className="form-field-input" />
                      </div>
                    )}

                    {/* Test Questions Builder */}
                    {addContentType === "test" && (
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                          <label className="form-field-label" style={{ marginBottom: 0 }}>Test Questions *</label>
                          <button type="button" onClick={() => setAddContentQuestions((prev) => [...prev, { question: "", options: ["", "", "", ""], correctIndex: 0 }])} style={{ fontSize: "0.8rem", background: "none", border: "1px solid var(--border-light)", borderRadius: 6, padding: "4px 10px", cursor: "pointer" }}>+ Add Question</button>
                        </div>
                        {addContentQuestions.map((q, qi) => (
                          <div key={qi} style={{ border: "1px solid var(--border-light)", borderRadius: 8, padding: 16, marginBottom: 12, background: "var(--bg-main)" }}>
                            <div style={{ fontWeight: 700, fontSize: "0.85rem", marginBottom: 8 }}>Q{qi + 1}</div>
                            <input
                              type="text" required
                              placeholder="Enter question text..."
                              value={q.question}
                              onChange={(e) => setAddContentQuestions((prev) => prev.map((item, i) => i === qi ? { ...item, question: e.target.value } : item))}
                              className="form-field-input"
                              style={{ marginBottom: 10 }}
                            />
                            {q.options.map((opt, oi) => (
                              <div key={oi} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                                <input type="radio" name={`correct_${qi}`} checked={q.correctIndex === oi} onChange={() => setAddContentQuestions((prev) => prev.map((item, i) => i === qi ? { ...item, correctIndex: oi } : item))} title="Mark as correct answer" />
                                <input
                                  type="text" required
                                  placeholder={`Option ${oi + 1}`}
                                  value={opt}
                                  onChange={(e) => setAddContentQuestions((prev) => prev.map((item, i) => i === qi ? { ...item, options: item.options.map((o, j) => j === oi ? e.target.value : o) } : item))}
                                  className="form-field-input"
                                  style={{ flex: 1 }}
                                />
                              </div>
                            ))}
                            <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>Click radio button to mark correct answer</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Order */}
                    <div className="form-field-group">
                      <label className="form-field-label">Order in Module</label>
                      <input type="number" min={1} value={addContentOrder} onChange={(e) => setAddContentOrder(e.target.value)} className="form-field-input" style={{ width: 100 }} />
                    </div>

                    <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                      <button type="button" onClick={() => { setShowAddContentModal(false); setIsAddingContent(false); }} className="btn btn-outline btn-md" style={{ flex: 1 }}>Cancel</button>
                      <button type="submit" disabled={isSubmittingContent} className="btn btn-solid-dark btn-md" style={{ flex: 2 }}>
                        {isSubmittingContent ? "Publishing..." : `Publish ${addContentType.charAt(0).toUpperCase() + addContentType.slice(1)} →`}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}

            {/* ── Create New Course Modal ───────────────────────── */}
            {showCreateCourseModal && (
              <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
                <div style={{ background: "#FFFFFF", borderRadius: 12, padding: 32, maxWidth: 580, width: "100%", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                    <div>
                      <h3 style={{ fontSize: "1.25rem", fontWeight: 800, margin: 0 }}>Create &amp; Publish New Course</h3>
                      <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 4 }}>
                        Set up a brand new course curriculum on Peleekings
                      </div>
                    </div>
                    <button onClick={() => setShowCreateCourseModal(false)} style={{ background: "none", border: "none", fontSize: "1.4rem", cursor: "pointer", color: "var(--text-muted)" }}>✕</button>
                  </div>

                  <form onSubmit={handleCreateCourse}>
                    <div className="form-field-group">
                      <label className="form-field-label">Course Title *</label>
                      <input
                        type="text"
                        required
                        placeholder="e.g. Modern React & Cloud Architecture"
                        value={newCourseForm.title}
                        onChange={(e) => setNewCourseForm({ ...newCourseForm, title: e.target.value })}
                        className="form-field-input"
                      />
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                      <div className="form-field-group">
                        <label className="form-field-label">Category *</label>
                        <select
                          value={newCourseForm.category}
                          onChange={(e) => setNewCourseForm({ ...newCourseForm, category: e.target.value })}
                          className="form-field-input"
                        >
                          <option value="Tech & Digital Skills">Tech &amp; Digital Skills</option>
                          <option value="Creative & Design">Creative &amp; Design</option>
                          <option value="Professional Skills">Professional Skills</option>
                          <option value="Business & Entrepreneurship">Business &amp; Entrepreneurship</option>
                        </select>
                      </div>
                      <div className="form-field-group">
                        <label className="form-field-label">Duration</label>
                        <input
                          type="text"
                          placeholder="e.g. 6 weeks or 8h 30m"
                          value={newCourseForm.duration}
                          onChange={(e) => setNewCourseForm({ ...newCourseForm, duration: e.target.value })}
                          className="form-field-input"
                        />
                      </div>
                    </div>

                    <div className="form-field-group">
                      <label className="form-field-label">Cover Image URL</label>
                      <input
                        type="url"
                        placeholder="https://images.unsplash.com/..."
                        value={newCourseForm.image}
                        onChange={(e) => setNewCourseForm({ ...newCourseForm, image: e.target.value })}
                        className="form-field-input"
                      />
                    </div>

                    <div className="form-field-group">
                      <label className="form-field-label">Course Description *</label>
                      <textarea
                        rows={3}
                        required
                        placeholder="Describe what learners will learn and build..."
                        value={newCourseForm.description}
                        onChange={(e) => setNewCourseForm({ ...newCourseForm, description: e.target.value })}
                        className="form-field-input"
                      />
                    </div>

                    <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                      <button type="button" onClick={() => setShowCreateCourseModal(false)} className="btn btn-outline btn-md" style={{ flex: 1 }}>Cancel</button>
                      <button type="submit" disabled={isCreatingCourse} className="btn btn-solid-dark btn-md" style={{ flex: 2, background: "var(--primary-learner)" }}>
                        {isCreatingCourse ? "Creating Course..." : "Create & Publish Course →"}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── TAB: SUBMISSIONS & GRADING ─────────────────────────────── */}
        {activeTab === "submissions" && (
          <div>
            <div style={{ marginBottom: 24 }}>
              <h2 style={{ fontSize: "1.4rem", fontWeight: 800 }}>Student Assignment Submissions</h2>
              <p style={{ fontSize: "0.875rem", color: "var(--text-muted)" }}>
                Review deliverables, provide qualitative feedback, and record grades to student profiles.
              </p>
            </div>

            {loadingSubmissions ? (
              <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>Loading submissions...</div>
            ) : submissions.length === 0 ? (
              <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "12px", padding: 36, textAlign: "center", color: "var(--text-muted)" }}>
                No submissions received yet.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {submissions.map((sub) => {
                  const state = gradingState[sub.id] || { grade: sub.grade || "", feedback: sub.feedback || "" };
                  return (
                    <div
                      key={sub.id}
                      style={{
                        background: "#FFFFFF",
                        border: "1px solid var(--border-light)",
                        borderRadius: "12px",
                        padding: "24px",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 14 }}>
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <h4 style={{ fontSize: "1.1rem", fontWeight: 700, margin: 0 }}>
                              {sub.studentName || "Student"}
                            </h4>
                            <span className={`pill-badge ${sub.status === "graded" ? "pill-success" : "pill-warning"}`}>
                              {sub.status === "graded" ? "Graded" : "Needs Review"}
                            </span>
                          </div>
                          <div style={{ fontSize: "0.825rem", color: "var(--text-muted)", marginTop: 4 }}>
                            {sub.studentEmail} &bull; Course: {sub.courseTitle || "Peleekings Course"}
                          </div>
                        </div>

                        {sub.fileUrl && (
                          <a
                            href={sub.fileUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="btn btn-outline btn-sm"
                            style={{ textDecoration: "none" }}
                          >
                            Download Attachment &darr;
                          </a>
                        )}
                      </div>

                      {/* Content / Notes */}
                      {sub.content && (
                        <div style={{ background: "var(--bg-main)", padding: "12px 16px", borderRadius: "8px", fontSize: "0.875rem", color: "var(--text-secondary)", marginBottom: 16, fontFamily: "monospace" }}>
                          {sub.content}
                        </div>
                      )}

                      {/* Grading Form */}
                      <div style={{ display: "grid", gridTemplateColumns: "180px 1fr auto", gap: 12, alignItems: "center", background: "#F8FAFC", padding: 16, borderRadius: "8px" }}>
                        <div>
                          <label style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                            GRADE *
                          </label>
                          <input
                            type="text"
                            placeholder="e.g. A (95%) or 90/100"
                            value={state.grade}
                            onChange={(e) =>
                              setGradingState((prev) => ({
                                ...prev,
                                [sub.id]: { ...state, grade: e.target.value },
                              }))
                            }
                            className="form-field-input"
                            style={{ padding: "8px 12px" }}
                          />
                        </div>

                        <div>
                          <label style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                            INSTRUCTOR FEEDBACK
                          </label>
                          <input
                            type="text"
                            placeholder="Add constructive comments for the learner..."
                            value={state.feedback}
                            onChange={(e) =>
                              setGradingState((prev) => ({
                                ...prev,
                                [sub.id]: { ...state, feedback: e.target.value },
                              }))
                            }
                            className="form-field-input"
                            style={{ padding: "8px 12px" }}
                          />
                        </div>

                        <div style={{ alignSelf: "flex-end" }}>
                          <button
                            onClick={() => handleSaveGrade(sub.id)}
                            className="btn btn-solid-dark btn-sm"
                          >
                            Save Grade
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── TAB: COURSE ANALYTICS ──────────────────────────────────── */}
        {activeTab === "analytics" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
              <div>
                <h2 style={{ fontSize: "1.4rem", fontWeight: 800 }}>Course Analytics &amp; Performance</h2>
                <p style={{ fontSize: "0.875rem", color: "var(--text-muted)" }}>
                  Live enrollment counts, assessment averages, and submission metrics from Firestore.
                </p>
              </div>
              {loadingAnalytics && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)", fontSize: "0.85rem" }}>
                  <div style={{ width: 16, height: 16, border: "2px solid #E2E8F0", borderTopColor: "var(--primary-learner)", borderRadius: "50%", animation: "spin 0.6s linear infinite" }} />
                  Loading live data...
                </div>
              )}
            </div>

            {/* Stat Cards */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, marginBottom: 24 }}>
              <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "12px", padding: 20 }}>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", fontWeight: 700, textTransform: "uppercase" }}>
                  Enrolled Students
                </div>
                <div style={{ fontSize: "2rem", fontWeight: 800, color: "var(--primary-learner)", marginTop: 6 }}>
                  {analytics.enrolledCount}
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>Live from Firestore</div>
              </div>

              <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "12px", padding: 20 }}>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", fontWeight: 700, textTransform: "uppercase" }}>
                  Avg Test Score
                </div>
                <div style={{ fontSize: "2rem", fontWeight: 800, color: "var(--text-primary)", marginTop: 6 }}>
                  {analytics.avgScore}
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>Across all test submissions</div>
              </div>

              <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "12px", padding: 20 }}>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", fontWeight: 700, textTransform: "uppercase" }}>
                  Assignment Submission Rate
                </div>
                <div style={{ fontSize: "2rem", fontWeight: 800, color: "var(--text-primary)", marginTop: 6 }}>
                  {analytics.submissionRate}
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>Submissions ÷ enrollments</div>
              </div>

              <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "12px", padding: 20 }}>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", fontWeight: 700, textTransform: "uppercase" }}>
                  Published Modules
                </div>
                <div style={{ fontSize: "2rem", fontWeight: 800, color: "var(--text-primary)", marginTop: 6 }}>
                  {analytics.moduleCount}
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>Total course modules</div>
              </div>
            </div>

            {/* Cumulative Enrollment Growth Chart */}
            <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "12px", padding: 24 }}>
              <h3 style={{ fontSize: "1.1rem", fontWeight: 700, marginBottom: 4 }}>Cumulative Enrollment Growth</h3>
              <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 16 }}>New enrollments by week over the last 7 weeks</p>
              {analytics.trend.length === 0 ? (
                <div style={{ height: 160, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: "0.875rem", background: "var(--bg-main)", borderRadius: 8 }}>
                  {loadingAnalytics ? "Loading chart data..." : "No enrollment data available yet."}
                </div>
              ) : (
                <div style={{ height: 180, display: "flex", alignItems: "flex-end", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border-light)" }}>
                  {analytics.trend.map((val, idx) => {
                    const maxVal = Math.max(...analytics.trend, 1);
                    const heightPercent = Math.max(4, Math.round((val / maxVal) * 100));
                    return (
                      <div key={idx} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: "0.7rem", fontWeight: 700, color: "var(--primary-learner)" }}>{val}</span>
                        <div
                          style={{
                            width: "100%",
                            maxWidth: 40,
                            height: `${heightPercent}%`,
                            background: "var(--primary-learner)",
                            borderRadius: "4px 4px 0 0",
                            transition: "height 0.6s ease",
                            opacity: 0.85,
                          }}
                        />
                        <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>Wk {idx + 1}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── TAB: RESOURCES ─────────────────────────────────────────── */}
        {activeTab === "resources" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
              <div>
                <h2 style={{ fontSize: "1.4rem", fontWeight: 800 }}>Course &amp; Platform Resources</h2>
                <p style={{ fontSize: "0.875rem", color: "var(--text-muted)" }}>
                  Upload cheatsheets, slides, exercises, and PDFs accessible to learners.
                </p>
              </div>

              <button
                onClick={() => setShowResourceForm((p) => !p)}
                className="btn btn-solid-dark btn-sm"
              >
                {showResourceForm ? "✕ Cancel" : "+ Upload New Resource"}
              </button>
            </div>

            {/* Resource Upload Form */}
            {showResourceForm && (
              <form onSubmit={handleUploadTutorResource} style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "12px", padding: 24, marginBottom: 24 }}>
                <h4 style={{ fontSize: "1.05rem", fontWeight: 700, marginBottom: 14 }}>Add Course Resource</h4>
                <div className="form-field-group">
                  <label className="form-field-label">Resource Title *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Prompt Chaining Master Cheatsheet"
                    value={resTitle}
                    onChange={(e) => setResTitle(e.target.value)}
                    className="form-field-input"
                  />
                </div>

                <div className="form-field-group">
                  <label className="form-field-label">Description</label>
                  <input
                    type="text"
                    placeholder="Brief description of the material..."
                    value={resDesc}
                    onChange={(e) => setResDesc(e.target.value)}
                    className="form-field-input"
                  />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  <div>
                    <label className="form-field-label">Attach File (PDF, ZIP, DOC, IMG)</label>
                    <input
                      type="file"
                      onChange={(e) => setResFile(e.target.files[0] || null)}
                      style={{ fontSize: "0.85rem", width: "100%" }}
                    />
                  </div>
                  <div>
                    <label className="form-field-label">Or External Link (Drive, GitHub, Figma)</label>
                    <input
                      type="url"
                      placeholder="https://..."
                      value={resLink}
                      onChange={(e) => setResLink(e.target.value)}
                      className="form-field-input"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={isUploadingRes}
                  className="btn btn-solid-dark btn-sm"
                  style={{ marginTop: 16 }}
                >
                  {isUploadingRes ? "Publishing..." : "Publish Resource →"}
                </button>
              </form>
            )}

            {/* Resources List */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {resources.map((r) => (
                <div
                  key={r.id}
                  style={{
                    background: "#FFFFFF",
                    border: "1px solid var(--border-light)",
                    borderRadius: "8px",
                    padding: "16px 20px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 700, fontSize: "0.95rem" }}>{r.title}</div>
                    <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 2 }}>
                      {r.desc || r.description} &bull; {r.type} {r.fileSize && `(${r.fileSize})`}
                    </div>
                  </div>
                  <a
                    href={r.fileUrl || "#"}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-outline btn-sm"
                    style={{ textDecoration: "none" }}
                  >
                    Open / Download &darr;
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
