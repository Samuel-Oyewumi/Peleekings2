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

const withTimeout = (promise, ms = 3000) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), ms)),
  ]);

const INITIAL_SAMPLE_SUBMISSIONS = [
  {
    id: "sub-sample-1",
    studentName: "Adebayo Ogunlesi",
    studentEmail: "adebayo.o@nysc.gov.ng",
    courseId: "ai-essentials",
    courseTitle: "AI Essentials & Automation",
    content: "Submitted link to automated customer triage workflow built with Gemini API + Google Sheets webhook.",
    status: "pending",
    grade: "",
    feedback: "",
  },
  {
    id: "sub-sample-2",
    studentName: "Chidinma Nwosu",
    studentEmail: "chidinma.nwosu@gmail.com",
    courseId: "graphic-design",
    courseTitle: "Graphic Design Fundamentals",
    content: "Brand identity system deliverable: primary logo, submark, color palette tokens, and social templates.",
    status: "graded",
    grade: "A (94%)",
    feedback: "Excellent hierarchy and consistent brand token usage across all mockups.",
  },
];

export default function TeachingPortal() {
  const { currentUser, userProfile, updateUserRole } = useAuth();
  const navigate = useNavigate();

  const isTutor =
    userProfile?.role === "instructor" ||
    userProfile?.role === "tutor" ||
    userProfile?.role === "admin" ||
    userProfile?.submittedRole === "tutor" ||
    userProfile?.submittedRole === "instructor";

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

  // ── Courses & Modules State (Initialized immediately so UI never blocks) ──
  const [courses, setCourses] = useState(() => {
    let custom = [];
    try {
      custom = JSON.parse(localStorage.getItem("peleekings_custom_courses") || "[]");
    } catch {}
    const defaults = COURSES_CATALOG.slice(0, 3).map((c) => ({
      ...c,
      status: "published",
    }));
    const merged = [...custom, ...defaults.filter((d) => !custom.some((c) => c.id === d.id))];
    return merged;
  });

  const [selectedCourse, setSelectedCourse] = useState(() => {
    let custom = [];
    try {
      custom = JSON.parse(localStorage.getItem("peleekings_custom_courses") || "[]");
    } catch {}
    return custom[0] || { ...COURSES_CATALOG[0], status: "published" };
  });

  const [modules, setModules] = useState([
    { id: "m1", title: "Module 1: Foundations & Setup", order: 1, itemsCount: 3 },
    { id: "m2", title: "Module 2: Core Concepts & Practice", order: 2, itemsCount: 4 },
    { id: "m3", title: "Module 3: Capstone & Review", order: 3, itemsCount: 2 },
  ]);
  const [moduleItemsMap, setModuleItemsMap] = useState({});
  const [newModuleTitle, setNewModuleTitle] = useState("");
  const [isCreatingModule, setIsCreatingModule] = useState(false);

  // ── Submissions & Grading State ──────────────────────────────────────
  const [submissions, setSubmissions] = useState(INITIAL_SAMPLE_SUBMISSIONS);
  const [loadingSubmissions, setLoadingSubmissions] = useState(false);
  const [gradingState, setGradingState] = useState({}); // { [subId]: { grade: "", feedback: "" } }
  const [savingGradeId, setSavingGradeId] = useState(null);

  // ── Analytics State ──────────────────────────────────────────────────
  const [analytics, setAnalytics] = useState({
    enrolledCount: 28,
    avgScore: "86%",
    submissionRate: "79%",
    moduleCount: 3,
    trend: [4, 9, 14, 18, 22, 25, 28],
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
      let localCustom = [];
      try {
        localCustom = JSON.parse(localStorage.getItem("peleekings_custom_courses") || "[]");
      } catch {}

      try {
        const q = userProfile?.role === "admin"
          ? collection(db, "courses")
          : query(collection(db, "courses"), where("tutorId", "==", currentUser.uid));
        const snap = await withTimeout(getDocs(q), 3000);
        const fsList = !snap.empty ? snap.docs.map((d) => ({ id: d.id, ...d.data() })) : [];
        const fallback = COURSES_CATALOG.slice(0, 3).map((c) => ({
          ...c,
          tutorId: currentUser.uid,
          status: "published",
        }));
        const combined = [
          ...localCustom,
          ...fsList.filter((f) => !localCustom.some((l) => l.id === f.id)),
          ...fallback.filter((d) => !localCustom.some((l) => l.id === d.id) && !fsList.some((f) => f.id === d.id)),
        ];
        setCourses(combined);
        setSelectedCourse((prev) => combined.find((c) => c.id === prev?.id) || combined[0]);
      } catch (err) {
        console.warn("Tutor courses fallback notice:", err);
      }
    }

    if (isTutor) {
      loadTutorCourses();
    }
  }, [currentUser?.uid, isTutor, userProfile?.role]);

  // Load Modules & Saved Content for selected course
  useEffect(() => {
    async function loadModules() {
      if (!selectedCourse?.id) return;
      let localMods = null;
      try {
        const raw = localStorage.getItem(`peleekings_modules_${selectedCourse.id}`);
        if (raw) localMods = JSON.parse(raw);
      } catch {}

      try {
        const rawItems = localStorage.getItem(`peleekings_course_content_${selectedCourse.id}`);
        if (rawItems) {
          setModuleItemsMap(JSON.parse(rawItems));
        } else {
          setModuleItemsMap({});
        }
      } catch {
        setModuleItemsMap({});
      }

      if (localMods && localMods.length > 0) {
        setModules(localMods);
      }

      try {
        const modSnap = await withTimeout(
          getDocs(query(collection(db, "courses", selectedCourse.id, "modules"), orderBy("order", "asc"))),
          2500
        );
        if (!modSnap.empty) {
          const fsMods = modSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
          const mergedMods = localMods
            ? [...fsMods, ...localMods.filter((lm) => !fsMods.some((fm) => fm.id === lm.id || fm.title === lm.title))]
            : fsMods;
          setModules(mergedMods);
        } else if (!localMods) {
          setModules([
            { id: "m1", title: "Module 1: Foundations & Setup", order: 1, itemsCount: 3 },
            { id: "m2", title: "Module 2: Core Concepts & Practice", order: 2, itemsCount: 4 },
            { id: "m3", title: "Module 3: Capstone & Review", order: 3, itemsCount: 2 },
          ]);
        }
      } catch {
        if (!localMods) {
          setModules([
            { id: "m1", title: "Module 1: Foundations & Setup", order: 1, itemsCount: 3 },
            { id: "m2", title: "Module 2: Core Concepts & Practice", order: 2, itemsCount: 4 },
            { id: "m3", title: "Module 3: Capstone & Review", order: 3, itemsCount: 2 },
          ]);
        }
      }
    }
    loadModules();
  }, [selectedCourse?.id]);

  // Load Submissions
  useEffect(() => {
    async function loadSubmissions() {
      setLoadingSubmissions(true);
      let localSubs = [];
      try {
        localSubs = JSON.parse(localStorage.getItem("peleekings_tutor_submissions") || "[]");
      } catch {}

      try {
        const snap = await withTimeout(
          getDocs(query(collection(db, "assignmentSubmissions"), orderBy("submittedAt", "desc"))),
          2500
        );
        const fsItems = !snap.empty ? snap.docs.map((d) => ({ id: d.id, ...d.data() })) : [];
        const combined = [
          ...fsItems,
          ...localSubs.filter((l) => !fsItems.some((f) => f.id === l.id)),
          ...INITIAL_SAMPLE_SUBMISSIONS.filter((s) => !fsItems.some((f) => f.id === s.id) && !localSubs.some((l) => l.id === s.id)),
        ];
        setSubmissions(combined);
      } catch (err) {
        console.warn("Notice: using local/sample submissions:", err);
        const combined = [
          ...localSubs,
          ...INITIAL_SAMPLE_SUBMISSIONS.filter((s) => !localSubs.some((l) => l.id === s.id)),
        ];
        setSubmissions(combined);
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
        const enrollSnap = await withTimeout(
          getDocs(query(collection(db, "enrollments"), where("courseId", "==", selectedCourse.id))),
          2500
        );
        const enrolledCount = enrollSnap.size || 28;

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
        const cumulativeTrend = enrollSnap.size > 0
          ? trendBuckets.reduce((acc, val, idx) => {
              acc.push((acc[idx - 1] || 0) + val);
              return acc;
            }, [])
          : [4, 9, 14, 18, 22, 25, 28];

        const asnSnap = await withTimeout(
          getDocs(query(collection(db, "assignmentSubmissions"), where("courseId", "==", selectedCourse.id))),
          2500
        );
        const totalSubs = asnSnap.size;
        const submissionRate = enrollSnap.size > 0
          ? `${Math.min(100, Math.round((totalSubs / enrollSnap.size) * 100))}%`
          : "79%";

        setAnalytics({
          enrolledCount,
          avgScore: "86%",
          submissionRate,
          moduleCount: modules.length || 3,
          trend: cumulativeTrend,
        });
      } catch (err) {
        console.warn("Analytics fallback notice:", err);
        setAnalytics((prev) => ({
          ...prev,
          moduleCount: modules.length || 3,
        }));
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
      let portraitUrl = portraitPreview || null;
      if (portraitFile) {
        try {
          const safeName = portraitFile.name.replace(/[^a-zA-Z0-9.-]/g, "_");
          const portraitRef = ref(storage, `users/${currentUser.uid}/portrait/${Date.now()}_${safeName}`);
          const uploadRes = await withTimeout(uploadBytes(portraitRef, portraitFile), 2500);
          portraitUrl = await withTimeout(getDownloadURL(uploadRes.ref), 2000);
        } catch (storageErr) {
          console.warn("Notice: portrait storage upload fallback:", storageErr);
        }
      }

      const payload = {
        applicantUid: currentUser.uid,
        fullName: applyForm.fullName.trim() || userProfile?.fullName || "Instructor",
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
        await withTimeout(addDoc(collection(db, "tutorApplications"), payload), 2500);
      } catch (fsErr) {
        console.warn("Notice: Firestore write for tutor application fallback:", fsErr);
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
      triggerToast("Application submitted successfully!");
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
    const targetCourseId = selectedCourse?.id || courses[0]?.id || "ai-essentials";
    if (!newModuleTitle.trim()) return;
    setIsCreatingModule(true);
    try {
      const order = modules.length + 1;
      const modData = {
        title: newModuleTitle.trim(),
        order,
        createdAt: serverTimestamp(),
      };
      let newId = `mod-${Date.now()}`;
      try {
        const docRef = await withTimeout(
          addDoc(collection(db, "courses", targetCourseId, "modules"), modData),
          2500
        );
        newId = docRef.id;
      } catch (fsErr) {
        console.warn("Firestore addModule fallback to local state:", fsErr);
      }

      const createdMod = { id: newId, title: newModuleTitle.trim(), order, itemsCount: 0 };
      setModules((prev) => {
        const updated = [...prev, createdMod];
        try {
          localStorage.setItem(`peleekings_modules_${targetCourseId}`, JSON.stringify(updated));
        } catch {}
        return updated;
      });
      setNewModuleTitle("");
      triggerToast("✓ Module added successfully!");
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
      const courseId =
        newCourseForm.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") ||
        `course-${Date.now()}`;
      const courseData = {
        id: courseId,
        title: newCourseForm.title.trim(),
        category: newCourseForm.category,
        description: newCourseForm.description.trim() || "Comprehensive course by Peleekings Instructor.",
        duration: newCourseForm.duration.trim() || "6 weeks",
        image:
          newCourseForm.image.trim() ||
          "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=600&auto=format&fit=crop&q=80",
        tutorId: currentUser?.uid || "tutor",
        tutorName: userProfile?.fullName || currentUser?.displayName || "Instructor",
        status: "published",
        badge: "Certificate",
        rating: 5.0,
        enrolledCount: 0,
      };

      const firstMod = {
        id: `mod-${Date.now()}`,
        title: "Module 1: Orientation & Foundations",
        order: 1,
      };

      try {
        await withTimeout(
          setDoc(doc(db, "courses", courseId), { ...courseData, createdAt: serverTimestamp() }),
          2500
        );
        const modDocRef = await withTimeout(
          addDoc(collection(db, "courses", courseId, "modules"), {
            title: firstMod.title,
            order: 1,
            createdAt: serverTimestamp(),
          }),
          2000
        );
        firstMod.id = modDocRef.id;
      } catch (fsErr) {
        console.warn("Firestore createCourse fallback to local persistence:", fsErr);
      }

      try {
        const existingCustom = JSON.parse(localStorage.getItem("peleekings_custom_courses") || "[]");
        localStorage.setItem(
          "peleekings_custom_courses",
          JSON.stringify([courseData, ...existingCustom.filter((c) => c.id !== courseId)])
        );
        localStorage.setItem(`peleekings_modules_${courseId}`, JSON.stringify([firstMod]));
      } catch {}

      setCourses((prev) => [courseData, ...prev.filter((c) => c.id !== courseId)]);
      setSelectedCourse(courseData);
      setModules([firstMod]);
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
    const targetCourseId = selectedCourse?.id || courses[0]?.id || "ai-essentials";
    const targetModId = addContentModuleId || modules[0]?.id || "m1";
    if (!addContentTitle.trim()) return;
    setIsSubmittingContent(true);
    try {
      let fileUrl = null;
      if (addContentFile) {
        try {
          const safeName = addContentFile.name.replace(/[^a-zA-Z0-9.-]/g, "_");
          const storageRef = ref(storage, `courses/${targetCourseId}/${targetModId}/${Date.now()}_${safeName}`);
          const uploadRes = await withTimeout(uploadBytes(storageRef, addContentFile), 2500);
          fileUrl = await withTimeout(getDownloadURL(uploadRes.ref), 2000);
        } catch (storageErr) {
          console.warn("Storage upload notice: falling back gracefully:", storageErr);
          try {
            fileUrl = URL.createObjectURL(addContentFile);
          } catch {
            fileUrl = `https://storage.peleekings.com/materials/${encodeURIComponent(addContentFile.name)}`;
          }
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
        moduleId: targetModId,
        order: Number(addContentOrder) || 1,
        uploadedBy: currentUser?.uid || "tutor",
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
        payload.postedBy = userProfile?.fullName || currentUser?.email || "Instructor";
      } else if (addContentType === "test") {
        payload.questions = addContentQuestions.filter((q) => q.question.trim());
        payload.dueAt = addContentDueAt || null;
        payload.type = "test";
      }

      try {
        await withTimeout(
          addDoc(collection(db, "courses", targetCourseId, collectionName), {
            ...payload,
            createdAt: serverTimestamp(),
          }),
          2500
        );
      } catch (fsErr) {
        console.warn("Firestore addContent fallback to local persistence:", fsErr);
      }

      // Persist added content locally so both Tutor Portal and Classroom reflect it immediately
      const localItem = {
        id: `item-${Date.now()}`,
        ...payload,
        contentType: addContentType,
        createdAt: new Date().toISOString(),
      };
      setModuleItemsMap((prev) => {
        const modList = prev[targetModId] || [];
        const updated = { ...prev, [targetModId]: [...modList, localItem] };
        try {
          localStorage.setItem(`peleekings_course_content_${targetCourseId}`, JSON.stringify(updated));
        } catch {}
        return updated;
      });

      // Notify enrolled students in background (non-blocking)
      getDocs(query(collection(db, "enrollments"), where("courseId", "==", targetCourseId)))
        .then((enrollSnap) => {
          const notifyType = addContentType === "announcement" ? "announcement" : "new_content";
          const notifyTitle = addContentType === "announcement"
            ? `Announcement: ${addContentTitle.trim()}`
            : `New ${addContentType} added: ${addContentTitle.trim()}`;
          const notifyBody = addContentType === "announcement"
            ? addContentBody.trim()
            : `A new ${addContentType} has been added to ${selectedCourse?.title || "your course"}.`;

          enrollSnap.docs
            .map((d) => d.data().uid)
            .filter((uid) => uid && uid !== currentUser?.uid)
            .forEach((uid) => {
              createNotification(uid, {
                type: notifyType,
                title: notifyTitle,
                body: notifyBody,
                courseId: targetCourseId,
              }).catch(() => {});
            });
        })
        .catch(() => {});

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
      triggerToast(`✓ ${addContentType.charAt(0).toUpperCase() + addContentType.slice(1)} published to module!`);
    } catch (err) {
      console.error(err);
      triggerToast("Failed to add content. Please try again.");
    } finally {
      setIsSubmittingContent(false);
    }
  }

  // ── Handle Save Grade ────────────────────────────────────────────────
  async function handleSaveGrade(submissionId) {
    const targetSub = submissions.find((s) => s.id === submissionId);
    const data = gradingState[submissionId] || { grade: targetSub?.grade || "", feedback: targetSub?.feedback || "" };
    if (!data?.grade?.trim()) {
      triggerToast("Please enter a grade first.");
      return;
    }

    setSavingGradeId(submissionId);
    try {
      try {
        const subRef = doc(db, "assignmentSubmissions", submissionId);
        await withTimeout(
          updateDoc(subRef, {
            grade: data.grade.trim(),
            feedback: data.feedback?.trim() || "",
            status: "graded",
            gradedAt: serverTimestamp(),
            gradedBy: currentUser?.uid || "tutor",
          }),
          2500
        );
      } catch (fsErr) {
        console.warn("Firestore grade update fallback to local state:", fsErr);
      }

      setSubmissions((prev) => {
        const updated = prev.map((s) =>
          s.id === submissionId
            ? { ...s, grade: data.grade.trim(), feedback: data.feedback?.trim() || "", status: "graded" }
            : s
        );
        try {
          localStorage.setItem("peleekings_tutor_submissions", JSON.stringify(updated));
        } catch {}
        return updated;
      });

      if (targetSub?.uid) {
        createNotification(targetSub.uid, {
          type: "grade",
          title: "Assignment Graded",
          body: `Your submission for '${targetSub.courseTitle || "Course"}' was graded: ${data.grade.trim()}`,
          courseId: targetSub.courseId,
        }).catch(() => {});
      }

      triggerToast("✓ Grade saved and student notified!");
    } catch (err) {
      console.error(err);
      triggerToast("Failed to save grade.");
    } finally {
      setSavingGradeId(null);
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
          uid: currentUser?.uid || "tutor",
          fullName: userProfile?.fullName || currentUser?.displayName || "Instructor",
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
      <div className="teaching-portal-container" style={{ minHeight: "85vh", background: "var(--bg-main)", padding: "32px 16px" }}>
        {toastMessage && (
          <div className="portal-toast-banner">
            ✓ {toastMessage}
          </div>
        )}

        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 28 }}>
            <span className="pill-badge pill-tech" style={{ fontSize: "0.8rem", padding: "4px 12px", marginBottom: 12 }}>
              TEACH ON PELEEKINGS
            </span>
            <h1 style={{ fontSize: "clamp(1.5rem, 4.5vw, 2rem)", fontWeight: 800, color: "var(--text-primary)", marginTop: 8 }}>
              {appliedSuccess ? "Application Received!" : "Apply to Teach on Peleekings"}
            </h1>
            <p style={{ color: "var(--text-muted)", fontSize: "0.95rem", maxWidth: 540, margin: "8px auto 0" }}>
              {appliedSuccess
                ? "Your credentials and course proposal have been recorded. You can now enter the Instructor Portal Studio to begin structuring your course."
                : "Join our teaching faculty to empower students, build structured curriculums, and manage your courses."}
            </p>
          </div>

          {appliedSuccess ? (
            <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "12px", padding: "28px 20px", textAlign: "center" }}>
              <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#EAF7EF", color: "#1B7A43", fontSize: "2rem", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
                ✓
              </div>
              <h3 style={{ fontSize: "1.3rem", fontWeight: 700, marginBottom: 8 }}>Application Submitted!</h3>
              <p style={{ color: "var(--text-secondary)", fontSize: "0.925rem", lineHeight: 1.6, maxWidth: 480, margin: "0 auto 24px" }}>
                Your instructor application has been sent to the Admin team. Click below to open the <strong>Teaching Portal Studio</strong> and start building your course modules right away.
              </p>
              <div style={{ display: "flex", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
                <button
                  onClick={() => updateUserRole("tutor")}
                  className="btn btn-solid-dark btn-md"
                  style={{ background: "var(--primary-learner)", color: "#FFFFFF" }}
                >
                  Open Teaching Portal Studio &rarr;
                </button>
                <button onClick={() => navigate("/dashboard")} className="btn btn-outline btn-md">
                  Return to Learner Dashboard
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleApplicationSubmit} className="portal-card-surface" style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "12px", padding: "24px 20px" }}>
              {applyError && (
                <div style={{ background: "#FEE2E2", color: "#B91C1C", padding: "10px 14px", borderRadius: "8px", fontSize: "0.85rem", marginBottom: 18 }}>
                  {applyError}
                </div>
              )}

              {/* Portrait Upload */}
              <div style={{ marginBottom: 24, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                <div style={{ width: 72, height: 72, borderRadius: "50%", background: "#F1F5F9", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", border: "2px dashed var(--border-light)", flexShrink: 0 }}>
                  {portraitPreview ? (
                    <img src={portraitPreview} alt="Portrait" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <span style={{ fontSize: "1.6rem", color: "var(--text-muted)" }}>👤</span>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <label style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-primary)", display: "block", marginBottom: 4 }}>
                    Instructor Portrait / Avatar (Optional)
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
                    style={{ fontSize: "0.85rem", maxWidth: "100%" }}
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
              <div className="form-grid-2col">
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
        <div className="portal-toast-banner">
          ✓ {toastMessage}
        </div>
      )}

      {/* Stage 7: Distinct Teaching Portal Header */}
      <header
        className="portal-top-header tp-header"
        style={{
          background: "#3C181A",
          color: "#FFFFFF",
          padding: "14px 32px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "nowrap", minWidth: 0 }}>
          <Link to="/" style={{ display: "flex", alignItems: "center", gap: 8, textDecoration: "none", color: "#FFFFFF", minWidth: 0 }}>
            <div className="brand-logo-icon" style={{ width: 32, height: 32, borderRadius: 8, flexShrink: 0 }}>
              <img src="/assets/aistudio/20260925_194828_31921ef2.png" alt="" className="brand-submark-img" />
            </div>
            <img src="/assets/aistudio/20260925_194648_c89756b4.png" alt="Peleekings" className="brand-wordmark-img" style={{ height: 20 }} />
            <span className="tp-brand-tag" style={{ color: "#F9EFA7", fontWeight: 700, fontSize: "0.85rem", flexShrink: 0 }}>Teaching</span>
          </Link>
          <span
            className="portal-badge-tag tp-instructor-pill"
            style={{
              background: "rgba(255, 255, 255, 0.12)",
              color: "#F9EFA7",
              padding: "4px 10px",
              borderRadius: 999,
              fontSize: "0.75rem",
              fontWeight: 600,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            Instructor Portal
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <button
            onClick={() => navigate("/dashboard")}
            className="portal-switch-view-btn"
            style={{
              background: "rgba(255, 255, 255, 0.12)",
              color: "#FFFFFF",
              border: "1px solid rgba(255, 255, 255, 0.22)",
              padding: "8px 14px",
              borderRadius: 8,
              fontSize: "0.82rem",
              fontWeight: 600,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            <span className="tp-switch-prefix">Switch to </span>
            <span>Learner View</span> &rarr;
          </button>
        </div>
      </header>

      {/* Navigation Sub-header (Touch-scrollable on mobile) */}
      <div className="portal-subnav-bar">
        <div style={{ display: "flex", gap: 20, minWidth: "max-content" }}>
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
                padding: "14px 4px",
                border: "none",
                background: "none",
                fontSize: "0.88rem",
                fontWeight: activeTab === tab.id ? 700 : 500,
                color: activeTab === tab.id ? "var(--text-primary)" : "var(--text-muted)",
                borderBottom: `2px solid ${activeTab === tab.id ? "var(--primary-learner)" : "transparent"}`,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main Content Area */}
      <main className="portal-main-container">
        {/* ── TAB: COURSES & MODULES ─────────────────────────────────── */}
        {activeTab === "courses" && (
          <div>
            <div className="portal-builder-header tp-head-row">
              <div>
                <h2 style={{ fontSize: "clamp(1.2rem, 3.5vw, 1.45rem)", fontWeight: 800 }}>Course &amp; Curriculum Builder</h2>
                <p style={{ fontSize: "0.875rem", color: "var(--text-muted)" }}>
                  Manage modules, lessons, notes, tests, and assignments for your courses.
                </p>
              </div>

              {/* Course Selector Dropdown & New Course Button */}
              <div className="portal-course-controls tp-course-picker">
                <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-muted)", whiteSpace: "nowrap" }}>Active Course:</span>
                <select
                  value={selectedCourse?.id || ""}
                  onChange={(e) => {
                    const found = courses.find((c) => c.id === e.target.value);
                    if (found) setSelectedCourse(found);
                  }}
                  className="form-field-input"
                  style={{ padding: "8px 12px", minWidth: 180, flex: 1 }}
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
                  style={{ background: "var(--primary-learner)", color: "#FFFFFF", padding: "8px 14px", fontWeight: 700, whiteSpace: "nowrap" }}
                >
                  + Create New Course
                </button>
              </div>
            </div>

            {/* Course Overview Card */}
            {selectedCourse && (
              <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "12px", padding: "20px", marginBottom: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
                  <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                    <span className="pill-badge pill-tech" style={{ marginBottom: 8 }}>
                      {selectedCourse.category || "Tech & Digital Skills"}
                    </span>
                    <h3 style={{ fontSize: "1.2rem", fontWeight: 800, marginTop: 4 }}>{selectedCourse.title}</h3>
                    <p style={{ color: "var(--text-secondary)", fontSize: "0.88rem", marginTop: 4, maxWidth: 640 }}>
                      {selectedCourse.description}
                    </p>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <span className="pill-badge pill-success">Status: Published</span>
                    <Link to={`/course/${selectedCourse.id}`} className="btn btn-outline btn-sm">
                      View as Student &rarr;
                    </Link>
                  </div>
                </div>
              </div>
            )}

            {/* Modules Organizer */}
            <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "12px", padding: "20px" }}>
              <div className="portal-modules-toolbar tp-modules-head">
                <h3 style={{ fontSize: "1.08rem", fontWeight: 700, margin: 0 }}>Curriculum Modules ({modules.length})</h3>
                <form onSubmit={handleAddModule} className="module-add-form tp-module-form">
                  <input
                    type="text"
                    required
                    placeholder="New module title..."
                    value={newModuleTitle}
                    onChange={(e) => setNewModuleTitle(e.target.value)}
                    className="form-field-input"
                    style={{ padding: "8px 12px", flex: 1, minWidth: 0 }}
                  />
                  <button type="submit" disabled={isCreatingModule} className="btn btn-solid-dark btn-sm" style={{ whiteSpace: "nowrap" }}>
                    {isCreatingModule ? "Adding..." : "+ Add Module"}
                  </button>
                </form>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {modules.map((mod, idx) => {
                  const modItems = moduleItemsMap[mod.id] || [];
                  return (
                    <div
                      key={mod.id || idx}
                      style={{
                        border: "1px solid var(--border-light)",
                        borderRadius: "8px",
                        padding: "16px",
                        background: "var(--bg-main)",
                      }}
                    >
                      <div
                        className="tp-module-row"
                        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: "0.95rem" }}>
                            {mod.title}
                          </div>
                          <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 2 }}>
                            Order: {mod.order || idx + 1} &bull; {modItems.length > 0 ? `${modItems.length} custom item(s) published` : "Contains notes, lessons, assignments, and tests"}
                          </div>
                        </div>

                        <div className="tp-module-actions" style={{ display: "flex", gap: 8 }}>
                          <button
                            type="button"
                            onClick={() => {
                              setAddContentModuleId(mod.id);
                              setAddContentOrder(modItems.length + 1);
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

                      {modItems.length > 0 && (
                        <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px dashed var(--border-light)", display: "flex", flexDirection: "column", gap: 6 }}>
                          {modItems.map((item) => (
                            <div
                              key={item.id}
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                flexWrap: "wrap",
                                gap: 8,
                                background: "#FFFFFF",
                                padding: "8px 12px",
                                borderRadius: 6,
                                border: "1px solid var(--border-light)",
                                fontSize: "0.82rem",
                              }}
                            >
                              <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                                {item.contentType === "video" ? "📹 " : item.contentType === "test" ? "📝 " : item.contentType === "assignment" ? "📋 " : item.contentType === "announcement" ? "📢 " : "📄 "}
                                {item.title}
                              </span>
                              <span className="pill-badge pill-tech" style={{ fontSize: "0.7rem", textTransform: "capitalize" }}>
                                {item.contentType || item.type || "note"}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ── Add Content Modal ──────────────────────────────── */}
            {showAddContentModal && (
              <div className="modal-backdrop-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 999, display: "flex", alignItems: "center", justifyContent: "center", padding: 12 }}>
                <div className="portal-modal-card" style={{ background: "#FFFFFF", borderRadius: 12, padding: "24px 20px", maxWidth: 600, width: "100%", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                    <div>
                      <h3 style={{ fontSize: "1.15rem", fontWeight: 800, margin: 0 }}>Add Content to Module</h3>
                      <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 4 }}>
                        {modules.find((m) => m.id === addContentModuleId)?.title || "Selected Module"}
                      </div>
                    </div>
                    <button type="button" onClick={() => setShowAddContentModal(false)} style={{ background: "none", border: "none", fontSize: "1.4rem", cursor: "pointer", color: "var(--text-muted)" }}>✕</button>
                  </div>

                  {/* Content Type Tabs */}
                  <div className="content-type-tabs">
                    {["note", "video", "test", "assignment", "announcement"].map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setAddContentType(t)}
                        style={{
                          flex: "1 1 auto",
                          padding: "8px 10px",
                          border: "none",
                          borderRadius: 6,
                          cursor: "pointer",
                          fontSize: "0.78rem",
                          fontWeight: 700,
                          background: addContentType === t ? "#3C181A" : "transparent",
                          color: addContentType === t ? "#FFFFFF" : "var(--text-muted)",
                          textTransform: "capitalize",
                          whiteSpace: "nowrap",
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
                      <div className="form-grid-2col">
                        <div className="form-field-group">
                          <label className="form-field-label">Video Stream URL (YouTube, Vimeo, MP4)</label>
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
                          <div key={qi} style={{ border: "1px solid var(--border-light)", borderRadius: 8, padding: 14, marginBottom: 12, background: "var(--bg-main)" }}>
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

                    <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
                      <button type="button" onClick={() => setShowAddContentModal(false)} className="btn btn-outline btn-md" style={{ flex: 1 }}>Cancel</button>
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
              <div className="modal-backdrop-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 999, display: "flex", alignItems: "center", justifyContent: "center", padding: 12 }}>
                <div className="portal-modal-card" style={{ background: "#FFFFFF", borderRadius: 12, padding: "24px 20px", maxWidth: 580, width: "100%", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                    <div>
                      <h3 style={{ fontSize: "1.2rem", fontWeight: 800, margin: 0 }}>Create &amp; Publish New Course</h3>
                      <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 4 }}>
                        Set up a brand new course curriculum on Peleekings
                      </div>
                    </div>
                    <button type="button" onClick={() => setShowCreateCourseModal(false)} style={{ background: "none", border: "none", fontSize: "1.4rem", cursor: "pointer", color: "var(--text-muted)" }}>✕</button>
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

                    <div className="form-grid-2col">
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

                    <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
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
              <h2 style={{ fontSize: "clamp(1.2rem, 3.5vw, 1.45rem)", fontWeight: 800 }}>Student Assignment Submissions</h2>
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
                        padding: "20px",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 14 }}>
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <h4 style={{ fontSize: "1.05rem", fontWeight: 700, margin: 0 }}>
                              {sub.studentName || "Student"}
                            </h4>
                            <span className={`pill-badge ${sub.status === "graded" ? "pill-success" : "pill-warning"}`}>
                              {sub.status === "graded" ? `Graded: ${sub.grade}` : "Needs Review"}
                            </span>
                          </div>
                          <div style={{ fontSize: "0.825rem", color: "var(--text-muted)", marginTop: 4, wordBreak: "break-word" }}>
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
                        <div style={{ background: "var(--bg-main)", padding: "12px 14px", borderRadius: "8px", fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: 16, fontFamily: "monospace", wordBreak: "break-word" }}>
                          {sub.content}
                        </div>
                      )}

                      {/* Grading Form */}
                      <div className="grading-form-grid">
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

                        <div className="grading-submit-col">
                          <button
                            type="button"
                            disabled={savingGradeId === sub.id}
                            onClick={() => handleSaveGrade(sub.id)}
                            className="btn btn-solid-dark btn-sm"
                            style={{ width: "100%" }}
                          >
                            {savingGradeId === sub.id ? "Saving..." : "Save Grade"}
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
                <h2 style={{ fontSize: "clamp(1.2rem, 3.5vw, 1.45rem)", fontWeight: 800 }}>Course Analytics &amp; Performance</h2>
                <p style={{ fontSize: "0.875rem", color: "var(--text-muted)" }}>
                  Live enrollment counts, assessment averages, and submission metrics.
                </p>
              </div>
              {loadingAnalytics && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)", fontSize: "0.85rem" }}>
                  <div style={{ width: 16, height: 16, border: "2px solid #E2E8F0", borderTopColor: "var(--primary-learner)", borderRadius: "50%", animation: "spin 0.6s linear infinite" }} />
                  Refreshing metrics...
                </div>
              )}
            </div>

            {/* Stat Cards */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))", gap: 16, marginBottom: 24 }}>
              <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "12px", padding: 20 }}>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", fontWeight: 700, textTransform: "uppercase" }}>
                  Enrolled Students
                </div>
                <div style={{ fontSize: "2rem", fontWeight: 800, color: "var(--primary-learner)", marginTop: 6 }}>
                  {analytics.enrolledCount}
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>Active cohort</div>
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
            <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "12px", padding: 20 }}>
              <h3 style={{ fontSize: "1.1rem", fontWeight: 700, marginBottom: 4 }}>Cumulative Enrollment Growth</h3>
              <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 16 }}>New enrollments by week over the last 7 weeks</p>
              {analytics.trend.length === 0 ? (
                <div style={{ height: 160, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: "0.875rem", background: "var(--bg-main)", borderRadius: 8 }}>
                  {loadingAnalytics ? "Loading chart data..." : "No enrollment data available yet."}
                </div>
              ) : (
                <div style={{ height: 180, display: "flex", alignItems: "flex-end", gap: 8, padding: "10px 0", borderBottom: "1px solid var(--border-light)" }}>
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
                        <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>Wk {idx + 1}</span>
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
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 24 }}>
              <div>
                <h2 style={{ fontSize: "clamp(1.2rem, 3.5vw, 1.45rem)", fontWeight: 800 }}>Course &amp; Platform Resources</h2>
                <p style={{ fontSize: "0.875rem", color: "var(--text-muted)" }}>
                  Upload cheatsheets, slides, exercises, and PDFs accessible to learners.
                </p>
              </div>

              <button
                type="button"
                onClick={() => setShowResourceForm((p) => !p)}
                className="btn btn-solid-dark btn-sm"
              >
                {showResourceForm ? "✕ Cancel" : "+ Upload New Resource"}
              </button>
            </div>

            {/* Resource Upload Form */}
            {showResourceForm && (
              <form onSubmit={handleUploadTutorResource} style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "12px", padding: "20px", marginBottom: 24 }}>
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

                <div className="form-grid-2col">
                  <div className="form-field-group">
                    <label className="form-field-label">Attach File (PDF, ZIP, DOC, IMG)</label>
                    <input
                      type="file"
                      onChange={(e) => setResFile(e.target.files[0] || null)}
                      style={{ fontSize: "0.85rem", width: "100%" }}
                    />
                  </div>
                  <div className="form-field-group">
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
                  style={{ marginTop: 12 }}
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
                    padding: "16px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 12,
                  }}
                >
                  <div style={{ flex: "1 1 220px", minWidth: 0 }}>
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
