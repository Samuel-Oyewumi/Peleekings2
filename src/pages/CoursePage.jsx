import { useState, useEffect } from "react";
import { useParams, useNavigate, useLocation, Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { COURSES_CATALOG } from "../data/courses";
import { getCurriculumForCourse } from "../data/courseCurricula";
import { collection, query, orderBy, getDocs, addDoc, serverTimestamp, doc, getDoc } from "firebase/firestore";
import { db } from "../firebase";
import {
  getCourseEnrollment,
  enrollInCourse,
  toggleLessonCompletion,
  submitAssignment,
  getAssignmentSubmission,
  submitTest,
  getTestSubmission,
  incrementDailyActivity,
} from "../contexts/userActivity";
import { getResources, uploadResource } from "../contexts/resourcesService";

function getYouTubeEmbedUrl(url) {
  if (!url) return null;
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
  return match ? `https://www.youtube-nocookie.com/embed/${match[1]}?autoplay=1` : null;
}

export default function CoursePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { currentUser, userProfile } = useAuth();

  const [courseData, setCourseData] = useState(() => {
    return COURSES_CATALOG.find(c => c.id === id) || {
      id,
      title: "Course Classroom",
      category: "Tech & Digital Skills",
      description: "Comprehensive skills training on Peleekings.",
      duration: "6 weeks",
      modulesCount: 4,
      rating: 5.0,
      badge: "Certificate",
      image: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=600&auto=format&fit=crop&q=80",
    };
  });
  const courseCurriculum = getCurriculumForCourse(courseData.id);

  // Load custom/updated course details from Firestore
  useEffect(() => {
    let isMounted = true;
    async function fetchCourseDetails() {
      const fromCatalog = COURSES_CATALOG.find(c => c.id === id);
      if (fromCatalog && isMounted) {
        setCourseData(fromCatalog);
      }
      try {
        const snap = await getDoc(doc(db, "courses", id));
        if (snap.exists() && isMounted) {
          const data = snap.data();
          setCourseData(prev => ({
            ...prev,
            ...data,
            id: snap.id,
            title: data.title || prev.title,
            description: data.description || prev.description,
            image: data.image || prev.image,
            category: data.category || prev.category,
            duration: data.duration || prev.duration,
            badge: data.badge || prev.badge || "Certificate",
          }));
        }
      } catch (err) {
        console.warn("Notice: could not load course doc from Firestore:", err);
      }
    }
    fetchCourseDetails();
    return () => { isMounted = false; };
  }, [id]);

  // Firestore-backed enrollment state (source of truth)
  const [enrollment, setEnrollment] = useState(null);
  const [isEnrolled, setIsEnrolled] = useState(false);
  const [loadingEnrollment, setLoadingEnrollment] = useState(true);

  const [viewMode, setViewMode] = useState(location.state?.classroom ? "classroom" : "detail");
  const [selectedExperience, setSelectedExperience] = useState("online"); // "online" or "hands-on"
  const [isEnrolling, setIsEnrolling] = useState(false);
  
  // Classroom lesson state with saved progress initialized dynamically per course
  const [modules, setModules] = useState(() => courseCurriculum.modules);
  const [activeLessonId, setActiveLessonId] = useState(() => courseCurriculum.modules[0]?.lessons[0]?.id || "l1");
  const [activeTab, setActiveTab] = useState("Overview");
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [showMobileCurriculum, setShowMobileCurriculum] = useState(false);

  // Assignment & Test submission state
  const [assignmentContent, setAssignmentContent] = useState("");
  const [assignmentSubmitting, setAssignmentSubmitting] = useState(false);
  const [currentSubmission, setCurrentSubmission] = useState(null);
  const [testAnswers, setTestAnswers] = useState({});
  const [testSubmitting, setTestSubmitting] = useState(false);
  const [currentTestSubmission, setCurrentTestSubmission] = useState(null);

  // Discussion state — loaded from Firestore
  const [comments, setComments] = useState([]);
  const [newComment, setNewComment] = useState("");

  // Announcements state
  const [announcements, setAnnouncements] = useState([]);
  const [showAddAnnouncement, setShowAddAnnouncement] = useState(false);
  const [announcementForm, setAnnouncementForm] = useState({ title: "", body: "" });
  const [postingAnnouncement, setPostingAnnouncement] = useState(false);

  // Test engine state (one question at a time)
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [testScore, setTestScore] = useState(null);

  // Synchronize curriculum and lesson selection when the route's course ID changes
  // Loads live teacher-uploaded modules and materials from Firestore
  useEffect(() => {
    let isMounted = true;
    const curr = getCurriculumForCourse(courseData.id);
    const initialLessonId = curr.modules[0]?.lessons[0]?.id || "l1";
    setActiveLessonId(initialLessonId);
    setModules(curr.modules);
    setCurrentQuestionIndex(0);
    setTestScore(null);
    setTestAnswers({});
    setCurrentSubmission(null);
    setCurrentTestSubmission(null);

    async function loadDynamicCurriculum() {
      try {
        const modSnap = await getDocs(
          query(collection(db, "courses", courseData.id, "modules"), orderBy("order", "asc"))
        );

        if (!modSnap.empty && isMounted) {
          const [notesSnap, lessonsSnap, asgnSnap, testsSnap] = await Promise.allSettled([
            getDocs(collection(db, "courses", courseData.id, "notes")),
            getDocs(collection(db, "courses", courseData.id, "lessons")),
            getDocs(collection(db, "courses", courseData.id, "assignments")),
            getDocs(collection(db, "courses", courseData.id, "tests")),
          ]);

          const firestoreItems = [];
          if (notesSnap.status === "fulfilled" && !notesSnap.value.empty) {
            notesSnap.value.docs.forEach((d) => firestoreItems.push({ id: d.id, ...d.data(), type: "reading" }));
          }
          if (lessonsSnap.status === "fulfilled" && !lessonsSnap.value.empty) {
            lessonsSnap.value.docs.forEach((d) => firestoreItems.push({ id: d.id, ...d.data(), type: "video" }));
          }
          if (asgnSnap.status === "fulfilled" && !asgnSnap.value.empty) {
            asgnSnap.value.docs.forEach((d) => firestoreItems.push({ id: d.id, ...d.data(), type: "assignment" }));
          }
          if (testsSnap.status === "fulfilled" && !testsSnap.value.empty) {
            testsSnap.value.docs.forEach((d) => firestoreItems.push({ id: d.id, ...d.data(), type: "test" }));
          }

          const dynamicModules = modSnap.docs.map((d) => {
            const mData = d.data();
            const modId = d.id;
            const items = firestoreItems
              .filter((item) => item.moduleId === modId)
              .sort((a, b) => (a.order || 1) - (b.order || 1))
              .map((item) => ({
                id: item.id,
                title: item.title,
                duration: item.duration || (item.type === "video" ? "15 min" : item.type === "test" ? "20 min" : "10 min"),
                completed: false,
                type: item.type || "reading",
                body: item.body || "",
                instructions: item.instructions || "",
                fileUrl: item.fileUrl || item.attachmentUrl || null,
                videoUrl: item.videoUrl || null,
                questions: item.questions || null,
                dueAt: item.dueAt || null,
              }));

            return {
              id: modId,
              title: mData.title,
              order: mData.order || 1,
              lessons: items.length > 0 ? items : [
                {
                  id: `l_${modId}_intro`,
                  title: `${mData.title} - Module Overview`,
                  duration: "10 min",
                  completed: false,
                  type: "reading",
                  body: "Welcome to this module. Course material, presentations, and assessments uploaded by your instructor will appear here."
                }
              ]
            };
          });

          if (dynamicModules.length > 0 && isMounted) {
            if (curr.modules.length === 0 || courseData.tutorId) {
              setModules(dynamicModules);
              if (dynamicModules[0]?.lessons[0]?.id) {
                setActiveLessonId(dynamicModules[0].lessons[0].id);
              }
            } else {
              const existingIds = new Set(curr.modules.map((m) => m.id));
              const extraModules = dynamicModules.filter((m) => !existingIds.has(m.id));
              if (extraModules.length > 0) {
                setModules([...curr.modules, ...extraModules]);
              }
            }
          }
        }
      } catch (err) {
        console.warn("Notice: could not load dynamic curriculum from Firestore:", err);
      }
    }

    loadDynamicCurriculum();
    return () => { isMounted = false; };
  }, [courseData.id, courseData.tutorId]);

  useEffect(() => {
    async function loadAnnouncements() {
      try {
        const snap = await getDocs(
          query(collection(db, "courses", courseData.id, "announcements"), orderBy("createdAt", "desc"))
        );
        if (!snap.empty) {
          setAnnouncements(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        } else {
          setAnnouncements([
            {
              id: "a1",
              title: `Welcome to ${courseData.title}!`,
              body: "We are thrilled to have you here. Please review the course syllabus and download lecture notes from the Resources tab.",
              postedBy: "Peleekings Academic Team",
              createdAt: { seconds: Date.now() / 1000 - 86400 },
            },
            {
              id: "a2",
              title: "Weekly Office Hours & Live Q&A",
              body: "Join us this Thursday at 4 PM GMT for a live walkthrough of the capstone project requirements and assignment deliverables.",
              postedBy: "Lead Instructor",
              createdAt: { seconds: Date.now() / 1000 - 172800 },
            },
          ]);
        }
      } catch (e) {
        setAnnouncements([
          {
            id: "a1",
            title: `Welcome to ${courseData.title}!`,
            body: "We are thrilled to have you here. Please review the course syllabus and download lecture notes from the Resources tab.",
            postedBy: "Peleekings Academic Team",
            createdAt: { seconds: Date.now() / 1000 - 86400 },
          },
        ]);
      }
    }
    loadAnnouncements();
  }, [courseData.id]);

  // Load comments from Firestore
  useEffect(() => {
    let isMounted = true;
    async function loadComments() {
      try {
        const snap = await getDocs(
          query(collection(db, "courses", courseData.id, "comments"), orderBy("createdAt", "desc"))
        );
        if (isMounted && !snap.empty) {
          setComments(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        } else if (isMounted) {
          // Seed with default sample comments so the UI is never empty
          setComments([
            { id: "c_default_1", author: "Esther James", time: "1h ago", text: "The breakdown of few-shot prompt chaining was exceptionally clear. Loved the Zapier connector pattern!" },
            { id: "c_default_2", author: "David Okafor", time: "3h ago", text: "Are the exercise files compatible with both Windows and Mac?" },
          ]);
        }
      } catch (err) {
        console.warn("Could not load comments:", err);
        if (isMounted) {
          setComments([
            { id: "c_default_1", author: "Esther James", time: "1h ago", text: "The breakdown of few-shot prompt chaining was exceptionally clear!" },
          ]);
        }
      }
    }
    loadComments();
    return () => { isMounted = false; };
  }, [courseData.id]);

  // Query Firestore for user's enrollment
  useEffect(() => {
    let isMounted = true;
    async function fetchEnrollment() {
      if (!currentUser?.uid) {
        setIsEnrolled(false);
        setEnrollment(null);
        setLoadingEnrollment(false);
        return;
      }
      setLoadingEnrollment(true);
      try {
        const enr = await getCourseEnrollment(currentUser.uid, courseData.id);
        if (isMounted) {
          if (enr && enr.status === "active") {
            setEnrollment(enr);
            setIsEnrolled(true);
            const completedSet = new Set(enr.completedItemIds || []);
            setModules(prev =>
              prev.map(mod => ({
                ...mod,
                lessons: mod.lessons.map(les => ({
                  ...les,
                  completed: completedSet.has(les.id)
                }))
              }))
            );
          } else {
            setEnrollment(null);
            setIsEnrolled(false);
          }
        }
      } catch (err) {
        console.warn("Error fetching enrollment from Firestore:", err);
      } finally {
        if (isMounted) setLoadingEnrollment(false);
      }
    }
    fetchEnrollment();
    return () => { isMounted = false; };
  }, [currentUser?.uid, courseData.id]);

  // Enter classroom mode automatically if navigated from Dashboard with classroom state
  useEffect(() => {
    if (location.state?.classroom && isEnrolled) {
      setViewMode("classroom");
    }
  }, [location.state?.classroom, isEnrolled]);

  // Track active study time while in classroom mode — 1 minute increments to Firestore
  useEffect(() => {
    if (!currentUser?.uid || !isEnrolled) return;
    // Immediately record 1 minute when entering classroom
    incrementDailyActivity(currentUser.uid, 1);
    // Then continue tracking every 60 seconds
    const timer = setInterval(() => {
      if (viewMode === "classroom") {
        incrementDailyActivity(currentUser.uid, 1);
      }
    }, 60000);
    return () => clearInterval(timer);
  }, [currentUser?.uid, isEnrolled, viewMode]);


  // Fetch submissions when active lesson changes — dynamic by lesson type
  useEffect(() => {
    let isMounted = true;
    async function loadSubmission() {
      if (!currentUser?.uid || !isEnrolled) return;
      const activeLesson = modules.flatMap(m => m.lessons).find(l => l.id === activeLessonId);
      if (!activeLesson) return;
      if (activeLesson.type === "assignment") {
        const sub = await getAssignmentSubmission(currentUser.uid, activeLessonId);
        if (isMounted) setCurrentSubmission(sub);
      } else if (activeLesson.type === "test") {
        const sub = await getTestSubmission(currentUser.uid, activeLessonId);
        if (isMounted) setCurrentTestSubmission(sub);
      }
    }
    loadSubmission();
    return () => { isMounted = false; };
  }, [currentUser?.uid, activeLessonId, isEnrolled, modules]);

  // Live Course Resources State
  const [courseResources, setCourseResources] = useState([]);
  const [showResourceUpload, setShowResourceUpload] = useState(false);
  const [resourceUploadData, setResourceUploadData] = useState({
    title: "",
    description: "",
    file: null,
    externalUrl: "",
  });
  const [isUploadingResource, setIsUploadingResource] = useState(false);

  useEffect(() => {
    if (courseData?.id) {
      getResources(courseData.id)
        .then((res) => {
          if (res) setCourseResources(res);
        })
        .catch((err) => console.warn("Failed to load course resources:", err));
    }
  }, [courseData?.id, activeTab]);

  async function handleUploadCourseResource(e) {
    e.preventDefault();
    if (!resourceUploadData.title.trim() || (!resourceUploadData.file && !resourceUploadData.externalUrl.trim())) {
      triggerToast("Please provide a title and either a file or link.");
      return;
    }

    setIsUploadingResource(true);
    try {
      const newRes = await uploadResource({
        file: resourceUploadData.file,
        title: resourceUploadData.title,
        description: resourceUploadData.description,
        category: courseData.category || "Tech & Digital Skills",
        courseId: courseData.id,
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

      setCourseResources((prev) => [newRes, ...prev]);
      setResourceUploadData({ title: "", description: "", file: null, externalUrl: "" });
      setShowResourceUpload(false);
      triggerToast("✓ Course resource uploaded and reflected on page!");
    } catch (err) {
      console.error("Failed to upload course resource:", err);
      triggerToast("Failed to upload resource. Please check file permissions.");
    } finally {
      setIsUploadingResource(false);
    }
  }

  function triggerToast(msg) {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(""), 3500);
  }

  // Find active lesson & parent module
  let currentLesson = null;
  let currentModule = null;
  for (const m of modules) {
    const found = m.lessons.find(l => l.id === activeLessonId);
    if (found) {
      currentLesson = found;
      currentModule = m;
      break;
    }
  }
  if (!currentLesson) {
    currentLesson = modules[0]?.lessons[0] || { id: "l1", title: "Introduction", duration: "10 min", completed: false, type: "video" };
    currentModule = modules[0] || null;
  }

  // Calculate overall progress
  const allLessons = modules.flatMap(m => m.lessons);
  const completedCount = allLessons.filter(l => l.completed).length;
  const progressPercent = allLessons.length > 0 ? Math.round((completedCount / allLessons.length) * 100) : 0;

  async function toggleLessonComplete(lessonId) {
    if (!isEnrolled || !currentUser?.uid) {
      triggerToast("Please enroll in this course to track your progress.");
      return;
    }

    try {
      const res = await toggleLessonCompletion(currentUser.uid, courseData.id, lessonId, allLessons.length);
      if (res) {
        const completedSet = new Set(res.completedItemIds);
        setModules(prev =>
          prev.map(mod => ({
            ...mod,
            lessons: mod.lessons.map(les =>
              les.id === lessonId ? { ...les, completed: completedSet.has(les.id) } : les
            )
          }))
        );
        const isNowCompleted = completedSet.has(lessonId);
        triggerToast(isNowCompleted ? "✓ Lesson marked as complete!" : "Lesson marked as incomplete");
      }
    } catch (err) {
      console.error(err);
      triggerToast("Failed to update lesson progress in Firestore.");
    }
  }

  async function handleEnroll(experienceType) {
    if (!currentUser) {
      navigate("/auth", { state: { from: `/course/${courseData.id}` } });
      return;
    }

    setSelectedExperience(experienceType);

    // If already enrolled in this exact format, immediately enter classroom!
    if (isEnrolled && enrollment?.experienceType === experienceType) {
      setViewMode("classroom");
      return;
    }

    setIsEnrolling(true);

    const enrollmentId = `${currentUser.uid}_${courseData.id}`;
    const optimisticEnr = {
      id: enrollmentId,
      uid: currentUser.uid,
      courseId: courseData.id,
      courseTitle: courseData.title,
      status: "active",
      experienceType,
      completedItemIds: enrollment?.completedItemIds || [],
      progressPercent: enrollment?.progressPercent || 0,
      totalLessons: modules.flatMap((m) => m.lessons).length || 8,
      currentModule: enrollment?.currentModule || "Module 1",
    };

    setEnrollment(optimisticEnr);
    setIsEnrolled(true);

    triggerToast(`🎉 ${isEnrolled ? "Track switched to" : "Enrolled in"} ${experienceType === "online" ? "Online Classes" : "Hands-on Training"}! Entering classroom...`);

    // Switch to classroom view immediately — zero lag
    setViewMode("classroom");

    // Sync in background without blocking the UI
    enrollInCourse(currentUser.uid, courseData.id, experienceType, optimisticEnr.totalLessons)
      .catch((err) => console.warn("Background enrollment notice:", err))
      .finally(() => setIsEnrolling(false));
  }

  async function handleAssignmentSubmit(e) {
    e.preventDefault();
    if (!assignmentContent.trim()) return;
    setAssignmentSubmitting(true);
    try {
      const res = await submitAssignment(currentUser.uid, courseData.id, currentLesson.id, {
        content: assignmentContent.trim(),
      });
      setCurrentSubmission(res);
      setAssignmentContent("");
      triggerToast("✓ Assignment submitted successfully!");
    } catch (err) {
      console.error(err);
      triggerToast("Failed to submit assignment.");
    } finally {
      setAssignmentSubmitting(false);
    }
  }

  const TEST_QUESTIONS = (currentLesson?.questions && currentLesson.questions.length > 0)
    ? currentLesson.questions
    : (courseCurriculum.quizQuestions || []);

  async function handleTestSubmit(e) {
    if (e) e.preventDefault();
    setTestSubmitting(true);
    try {
      // Calculate score
      let correctCount = 0;
      TEST_QUESTIONS.forEach((q, idx) => {
        if (testAnswers[idx] === q.correctIndex) {
          correctCount++;
        }
      });
      const calculatedScore = Math.round((correctCount / TEST_QUESTIONS.length) * 100);
      setTestScore(calculatedScore);

      const res = await submitTest(currentUser.uid, courseData.id, currentLesson.id, testAnswers, calculatedScore);
      setCurrentTestSubmission(res);
      await toggleLessonComplete(currentLesson.id);
      triggerToast(`✓ Test submitted! Your score: ${calculatedScore}%`);
    } catch (err) {
      console.error(err);
      triggerToast("Failed to submit test.");
    } finally {
      setTestSubmitting(false);
    }
  }

  async function handlePostAnnouncement(e) {
    e.preventDefault();
    if (!announcementForm.title.trim() || !announcementForm.body.trim()) return;
    setPostingAnnouncement(true);
    try {
      const newAnn = {
        title: announcementForm.title.trim(),
        body: announcementForm.body.trim(),
        postedBy: userProfile?.fullName || currentUser?.displayName || "Instructor",
        postedByUid: currentUser?.uid || "tutor",
        createdAt: serverTimestamp(),
      };
      const docRef = await addDoc(collection(db, "courses", courseData.id, "announcements"), newAnn);
      setAnnouncements((prev) => [
        { id: docRef.id, ...newAnn, createdAt: { seconds: Date.now() / 1000 } },
        ...prev,
      ]);
      setAnnouncementForm({ title: "", body: "" });
      setShowAddAnnouncement(false);
      triggerToast("✓ Announcement posted successfully!");
    } catch (err) {
      console.error("Failed to post announcement:", err);
      triggerToast("Could not post announcement.");
    } finally {
      setPostingAnnouncement(false);
    }
  }

  async function handleAddComment(e) {
    e.preventDefault();
    if (!newComment.trim()) return;
    const commentData = {
      uid: currentUser?.uid || "anonymous",
      author: currentUser?.displayName || userProfile?.fullName || "Learner",
      text: newComment.trim(),
      createdAt: serverTimestamp(),
      time: "Just now",
    };
    // Optimistic local update
    const localId = `temp_${Date.now()}`;
    setComments(prev => [{ id: localId, ...commentData, createdAt: null }, ...prev]);
    setNewComment("");
    try {
      const docRef = await addDoc(collection(db, "courses", courseData.id, "comments"), commentData);
      // Replace temp entry with real Firestore id
      setComments(prev => prev.map(c => c.id === localId ? { ...c, id: docRef.id } : c));
      triggerToast("Comment posted!");
    } catch (err) {
      console.error("Failed to post comment:", err);
      // Remove optimistic entry on failure
      setComments(prev => prev.filter(c => c.id !== localId));
      triggerToast("Failed to post comment.");
    }
  }

  function triggerDownload(fileName) {
    triggerToast(`Preparing download for: ${fileName}`);
    const blob = new Blob([`Peleekings Learning Material: ${fileName}\nCourse: ${courseData.title}\nLesson: ${currentLesson.title}\nGenerated on: ${new Date().toLocaleDateString()}`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /* ──────────────────────────────────────────────────────────────────────────
     CLASSROOM VIEW (Screen 6 from Mockup)
  ────────────────────────────────────────────────────────────────────────── */
  if (viewMode === "classroom") {
    return (
      <div className="classroom-container">
        {/* Toast Notification Banner */}
        {toastMessage && (
          <div style={{ position: "fixed", top: 80, right: 24, zIndex: 1000, background: "#0F172A", color: "#FFFFFF", padding: "12px 20px", borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow-lg)", fontSize: "0.875rem", fontWeight: 600, display: "flex", alignItems: "center", gap: 10 }}>
            <span>✓</span> {toastMessage}
          </div>
        )}

        {/* Classroom Top Bar */}
        <div className="classroom-top-bar">
          <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <button
              onClick={() => setViewMode("detail")}
              className="btn btn-ghost btn-sm"
              style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}
            >
              &larr; Back to Details
            </button>
            <div style={{ height: 20, width: 1, background: "var(--border-light)" }} />
            <div style={{ fontWeight: 700, fontSize: "1.05rem", color: "var(--text-primary)" }}>
              {courseData.title}
            </div>
            {/* Mobile Curriculum Toggle Button */}
            <button
              type="button"
              className="btn btn-outline btn-sm mobile-curriculum-btn"
              onClick={() => setShowMobileCurriculum(prev => !prev)}
              aria-label="Toggle curriculum"
            >
              {showMobileCurriculum ? "✕ Close" : "☰ Curriculum"}
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div
              className="pill-badge pill-success"
              style={{ padding: "6px 14px", fontSize: "0.8rem", fontWeight: 700 }}
            >
              {progressPercent}% complete
            </div>
            <button
              className="btn btn-outline btn-sm"
              onClick={() => navigate("/dashboard")}
            >
              My Dashboard
            </button>
          </div>
        </div>

        {/* Mobile Curriculum Backdrop */}
        {showMobileCurriculum && (
          <div
            className="portal-sidebar-backdrop"
            onClick={() => setShowMobileCurriculum(false)}
            aria-label="Close curriculum"
          />
        )}

        {/* Classroom Split Layout */}
        <div className="classroom-split-layout">
          {/* Left: Collapsible Curriculum Sidebar */}
          <aside className={`classroom-curriculum-sidebar ${showMobileCurriculum ? "mobile-open" : ""}`}>
            <div className="classroom-sidebar-mobile-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px 14px" }}>
              <span style={{ fontWeight: 800, fontSize: "0.95rem", color: "var(--text-primary)" }}>
                Course Curriculum
              </span>
              <button
                type="button"
                className="sidebar-close-btn"
                onClick={() => setShowMobileCurriculum(false)}
                aria-label="Close curriculum"
              >
                ✕
              </button>
            </div>

            {modules.map((mod) => (
              <div key={mod.id} className="curriculum-module-group">
                <div className="module-header-title">
                  {mod.title}
                </div>
                <div>
                  {mod.lessons.map(lesson => {
                    const isActive = lesson.id === activeLessonId;
                    return (
                      <div
                        key={lesson.id}
                        className={`lesson-curriculum-row ${isActive ? "active" : ""}`}
                        onClick={() => {
                          setActiveLessonId(lesson.id);
                          setShowMobileCurriculum(false);
                        }}
                      >
                        <div
                          className={`lesson-check-icon ${lesson.completed ? "completed" : ""}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleLessonComplete(lesson.id);
                          }}
                          title={lesson.completed ? "Mark incomplete" : "Mark complete"}
                        >
                          &#10003;
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: "0.85rem", lineHeight: 1.3 }}>
                            {lesson.title}
                          </div>
                          <div style={{ fontSize: "0.725rem", color: "var(--text-muted)", marginTop: 2 }}>
                            {lesson.duration} &bull; {lesson.type}
                          </div>
                        </div>
                        {isActive && (
                          <span style={{ fontSize: "0.8rem", color: "var(--primary-learner)" }}>▶</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </aside>

          {/* Right: Main Video Player & Lesson Content (Strictly Gated by Firestore Enrollment) */}
          <main className="classroom-video-main">
            {!isEnrolled ? (
              <div
                style={{
                  background: "#FFFFFF",
                  border: "1px solid var(--border-light)",
                  borderRadius: "var(--radius-md)",
                  padding: "48px 32px",
                  textAlign: "center",
                  maxWidth: 640,
                  margin: "40px auto",
                  boxShadow: "var(--shadow-sm)",
                }}
              >
                <div style={{ fontSize: "3rem", marginBottom: 16 }}>🔒</div>
                <h2 style={{ fontSize: "1.6rem", fontWeight: 800, marginBottom: 10, color: "var(--text-primary)" }}>
                  Enrollment Required
                </h2>
                <p style={{ fontSize: "0.95rem", color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 24 }}>
                  You are viewing the course curriculum outline. Lesson videos, downloadable exercise materials, interactive assignments, and quizzes require an active enrollment record in Firestore.
                </p>
                <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
                  <button
                    className="btn btn-solid-dark btn-lg"
                    onClick={() => handleEnroll("online")}
                    style={{ padding: "12px 28px", fontWeight: 700 }}
                  >
                    Enroll in Online Classes &rarr;
                  </button>
                  <button
                    className="btn btn-outline btn-lg"
                    onClick={() => handleEnroll("hands-on")}
                    style={{ padding: "12px 28px", fontWeight: 700 }}
                  >
                    Enroll in Hands-on Training
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* Video Player Frame */}
                <div className="video-frame-container" id="classroom-video-player" style={{ position: "relative", minHeight: 380, background: "#000" }}>
                  {isPlaying && currentLesson.videoUrl ? (
                    getYouTubeEmbedUrl(currentLesson.videoUrl) ? (
                      <iframe
                        src={getYouTubeEmbedUrl(currentLesson.videoUrl)}
                        style={{ width: "100%", height: "100%", minHeight: 380, border: "none" }}
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                        title={currentLesson.title}
                      />
                    ) : (
                      <video
                        controls
                        autoPlay
                        src={currentLesson.videoUrl}
                        style={{ width: "100%", height: "100%", minHeight: 380, objectFit: "contain", background: "#000" }}
                      />
                    )
                  ) : (
                    <>
                      <img
                        src="https://images.unsplash.com/photo-1531482615713-2afd69097998?w=1200&auto=format&fit=crop&q=80"
                        alt="Lesson Video Preview"
                        style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.85 }}
                      />

                      <div className="video-mockup-overlay">
                        {/* Top Overlay */}
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div className="pill-badge" style={{ background: "rgba(0,0,0,0.6)", color: "#FFFFFF", backdropFilter: "blur(4px)" }}>
                            {courseData.badge} &bull; {currentLesson.title}
                          </div>
                          <div style={{ fontSize: "0.85rem", opacity: 0.9 }}>HD 1080p</div>
                        </div>

                        {/* Big Center Play Button */}
                        <div style={{ alignSelf: "center", cursor: "pointer" }} onClick={() => setIsPlaying(true)}>
                          <div
                            style={{
                              width: 68,
                              height: 68,
                              borderRadius: "50%",
                              background: "rgba(17, 24, 39, 0.85)",
                              border: "2px solid rgba(255,255,255,0.7)",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: "1.6rem",
                              color: "#FFFFFF",
                              boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
                              transition: "transform 0.2s ease"
                            }}
                          >
                            ▶
                          </div>
                        </div>

                        {/* Bottom Controls Bar */}
                        <div className="video-controls-bar">
                          <span style={{ cursor: "pointer" }} onClick={() => setIsPlaying(true)}>
                            ▶
                          </span>
                          <div style={{ flex: 1, height: 5, background: "rgba(255,255,255,0.3)", borderRadius: 99, position: "relative" }}>
                            <div style={{ width: "52%", height: "100%", background: "var(--primary-learner)", borderRadius: 99, transition: "width 0.3s" }} />
                          </div>
                          <span>{currentLesson.duration || "15 min"}</span>
                          <span style={{ cursor: "pointer" }} onClick={() => setIsMuted(m => !m)} title={isMuted ? "Unmute" : "Mute"}>
                            {isMuted ? "🔇" : "🔊"}
                          </span>
                          <span style={{ cursor: "pointer" }} title="Settings">&#x2699;</span>
                          <span
                            style={{ cursor: "pointer" }}
                            title="Toggle Fullscreen"
                            onClick={() => {
                              const el = document.getElementById("classroom-video-player");
                              if (el) {
                                if (!document.fullscreenElement) el.requestFullscreen().catch(() => {});
                                else document.exitFullscreen().catch(() => {});
                              }
                            }}
                          >
                            &#x26F6;
                          </span>
                        </div>
                      </div>
                    </>
                  )}
                </div>

                {/* Lesson Title & Module Info */}
                <div style={{ marginTop: 24, display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
                  <div>
                    <h1 style={{ fontSize: "1.6rem", fontWeight: 800, marginBottom: 4 }}>
                      {currentLesson.title}
                    </h1>
                    <div style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                      {currentModule?.title || "Classroom"} &bull; {currentLesson.duration} &bull; Self-paced learning
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 10 }}>
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => {
                        const currentIndex = allLessons.findIndex(l => l.id === activeLessonId);
                        if (currentIndex > 0) setActiveLessonId(allLessons[currentIndex - 1].id);
                      }}
                    >
                      &larr; Previous
                    </button>
                    <button
                      className={`btn ${currentLesson.completed ? "btn-outline" : "btn-solid-dark"} btn-sm`}
                      onClick={() => toggleLessonComplete(currentLesson.id)}
                    >
                      {currentLesson.completed ? "✓ Completed" : "Mark as complete"}
                    </button>
                    <button
                      className="btn btn-solid-dark btn-sm"
                      onClick={() => {
                        const currentIndex = allLessons.findIndex(l => l.id === activeLessonId);
                        if (currentIndex < allLessons.length - 1) setActiveLessonId(allLessons[currentIndex + 1].id);
                      }}
                    >
                      Next lesson &rarr;
                    </button>
                  </div>
                </div>

                {/* Content Tabs */}
                <div className="lesson-tabs-header">
                  {["Overview", "Notes", "Resources", "Announcements", "Discussion"].map(tab => (
                    <button
                      key={tab}
                      className={`lesson-tab-btn ${activeTab === tab ? "active" : ""}`}
                      onClick={() => setActiveTab(tab)}
                    >
                      {tab}
                    </button>
                  ))}
                </div>

                {/* Tab Body */}
                <div style={{ fontSize: "0.925rem", color: "var(--text-secondary)", lineHeight: 1.7, maxWidth: 840 }}>
                  {activeTab === "Overview" && (
                    <div>
                      <p style={{ marginBottom: 14 }}>
                        {courseCurriculum.overview?.description}
                      </p>
                      <h4 style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--text-primary)", margin: "16px 0 8px" }}>
                        Key Learning Objectives:
                      </h4>
                      <ul style={{ paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6, marginBottom: 20 }}>
                        {(courseCurriculum.overview?.objectives || []).map((obj, i) => (
                          <li key={i}>{obj}</li>
                        ))}
                      </ul>

                      {/* Interactive Firestore Assignment Submission */}
                      {currentLesson.type === "assignment" && (
                        <div style={{ background: "#F8FAFC", border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", padding: 24, marginTop: 24 }}>
                          <h4 style={{ fontSize: "1.05rem", fontWeight: 700, marginBottom: 8 }}>
                            {currentLesson.title || courseCurriculum.assignment?.title || "📝 Practical Assignment"}
                          </h4>
                          <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", marginBottom: 16 }}>
                            {currentLesson.instructions || courseCurriculum.assignment?.description || "Submit your practical deliverables below for instructor review."}
                          </p>
                          {currentLesson.fileUrl && (
                            <div style={{ marginBottom: 16 }}>
                              <a
                                href={currentLesson.fileUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="btn btn-outline btn-sm"
                                style={{ textDecoration: "none" }}
                              >
                                Download Assignment Brief / Starter Kit &darr;
                              </a>
                            </div>
                          )}

                          {currentSubmission ? (
                            <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)", padding: 16 }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                                <span className="pill-badge pill-success">Status: Submitted</span>
                                <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Recorded in Firestore</span>
                              </div>
                              <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", background: "#F1F5F9", padding: 10, borderRadius: 6, fontFamily: "monospace" }}>
                                {currentSubmission.content}
                              </div>
                              {currentSubmission.grade && (
                                <div style={{ marginTop: 12, padding: "10px 14px", background: "#ECFDF5", border: "1px solid #A7F3D0", borderRadius: 6, color: "#065F46" }}>
                                  <strong>Instructor Grade:</strong> {currentSubmission.grade}
                                  {currentSubmission.feedback && <p style={{ marginTop: 4, fontSize: "0.85rem" }}>{currentSubmission.feedback}</p>}
                                </div>
                              )}
                            </div>
                          ) : (
                            <form onSubmit={handleAssignmentSubmit}>
                              <textarea
                                rows={4}
                                required
                                value={assignmentContent}
                                onChange={(e) => setAssignmentContent(e.target.value)}
                                placeholder={courseCurriculum.assignment?.placeholder || "Paste your assignment deliverables or solution notes here..."}
                                style={{ width: "100%", padding: 12, borderRadius: "var(--radius-sm)", border: "1px solid var(--border-light)", fontSize: "0.875rem", fontFamily: "inherit", outline: "none", marginBottom: 12 }}
                              />
                              <button type="submit" disabled={assignmentSubmitting} className="btn btn-solid-dark btn-sm">
                                {assignmentSubmitting ? "Submitting to Firestore..." : "Submit Assignment"}
                              </button>
                            </form>
                          )}
                        </div>
                      )}

                      {/* Interactive Firestore Test Submission (Stage 4 One-Question-at-a-Time Engine) */}
                      {currentLesson.type === "test" && (
                        <div style={{ background: "#F8FAFC", border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", padding: 24, marginTop: 24 }}>
                          <h4 style={{ fontSize: "1.05rem", fontWeight: 700, marginBottom: 8 }}>
                            🎓 Knowledge Assessment Quiz
                          </h4>
                          <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", marginBottom: 16 }}>
                            Complete the quiz below. Your score will be calculated and saved to your learner profile immediately.
                          </p>

                          {currentTestSubmission ? (
                            <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)", padding: 20 }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                                <span className="pill-badge pill-success">Status: Completed &amp; Recorded</span>
                                <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Firestore Record Saved</span>
                              </div>
                              <div style={{ textAlign: "center", padding: "16px 0", background: "var(--bg-main)", borderRadius: "8px", marginBottom: 12 }}>
                                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", textTransform: "uppercase", fontWeight: 700 }}>Your Assessment Score</div>
                                <div style={{ fontSize: "2.5rem", fontWeight: 800, color: "var(--primary-learner)", margin: "4px 0" }}>
                                  {currentTestSubmission.score !== undefined && currentTestSubmission.score !== null ? `${currentTestSubmission.score}%` : `${testScore || 100}%`}
                                </div>
                                <div style={{ fontSize: "0.85rem", color: "#166534", fontWeight: 600 }}>
                                  ✓ Knowledge check recorded in your enrollment progress.
                                </div>
                              </div>
                              {currentTestSubmission.grade && (
                                <div style={{ marginTop: 12, padding: "10px 14px", background: "#ECFDF5", border: "1px solid #A7F3D0", borderRadius: 6, color: "#065F46" }}>
                                  <strong>Instructor Feedback:</strong> {currentTestSubmission.grade}
                                  {currentTestSubmission.feedback && <p style={{ marginTop: 4, fontSize: "0.85rem" }}>{currentTestSubmission.feedback}</p>}
                                </div>
                              )}
                            </div>
                          ) : (
                            <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)", padding: 20 }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                                <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--primary-learner)" }}>
                                  Question {currentQuestionIndex + 1} of {TEST_QUESTIONS.length}
                                </span>
                                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                                  Passing score: 70%
                                </span>
                              </div>

                              <div style={{ fontSize: "1rem", fontWeight: 700, color: "var(--text-primary)", marginBottom: 16 }}>
                                {TEST_QUESTIONS[currentQuestionIndex].question}
                              </div>

                              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
                                {TEST_QUESTIONS[currentQuestionIndex].options.map((opt, oIdx) => {
                                  const isSelected = testAnswers[currentQuestionIndex] === oIdx;
                                  return (
                                    <div
                                      key={oIdx}
                                      onClick={() => setTestAnswers(prev => ({ ...prev, [currentQuestionIndex]: oIdx }))}
                                      style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 12,
                                        padding: "12px 16px",
                                        borderRadius: "8px",
                                        border: `1px solid ${isSelected ? "var(--primary-learner)" : "var(--border-light)"}`,
                                        background: isSelected ? "var(--primary-learner-light)" : "#FFFFFF",
                                        cursor: "pointer",
                                        transition: "all 0.15s ease"
                                      }}
                                    >
                                      <div
                                        style={{
                                          width: 18,
                                          height: 18,
                                          borderRadius: "50%",
                                          border: `2px solid ${isSelected ? "var(--primary-learner)" : "#CBD5E1"}`,
                                          display: "flex",
                                          alignItems: "center",
                                          justifyContent: "center"
                                        }}
                                      >
                                        {isSelected && <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--primary-learner)" }} />}
                                      </div>
                                      <span style={{ fontSize: "0.875rem", color: isSelected ? "var(--primary-learner)" : "var(--text-secondary)", fontWeight: isSelected ? 600 : 400 }}>
                                        {opt}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>

                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                <button
                                  type="button"
                                  disabled={currentQuestionIndex === 0}
                                  onClick={() => setCurrentQuestionIndex(i => i - 1)}
                                  className="btn btn-outline btn-sm"
                                  style={{ opacity: currentQuestionIndex === 0 ? 0.5 : 1 }}
                                >
                                  &larr; Previous
                                </button>

                                {currentQuestionIndex < TEST_QUESTIONS.length - 1 ? (
                                  <button
                                    type="button"
                                    disabled={testAnswers[currentQuestionIndex] === undefined}
                                    onClick={() => setCurrentQuestionIndex(i => i + 1)}
                                    className="btn btn-solid-dark btn-sm"
                                  >
                                    Next Question &rarr;
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    disabled={testAnswers[currentQuestionIndex] === undefined || testSubmitting}
                                    onClick={handleTestSubmit}
                                    className="btn btn-solid-dark btn-sm"
                                    style={{ background: "var(--primary-learner)" }}
                                  >
                                    {testSubmitting ? "Scoring Test..." : "Submit Test & See Score →"}
                                  </button>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {activeTab === "Notes" && (
                    <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", padding: 20 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 10 }}>
                        <div style={{ fontWeight: 700, color: "var(--text-primary)" }}>Course Notes: {currentLesson.title}</div>
                        {currentLesson.fileUrl ? (
                          <a
                            href={currentLesson.fileUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="btn btn-outline btn-sm"
                            style={{ textDecoration: "none" }}
                          >
                            Download Material &darr;
                          </a>
                        ) : (
                          <button className="btn btn-outline btn-sm" onClick={() => triggerDownload(courseCurriculum.notesFileName)}>
                            Download PDF &darr;
                          </button>
                        )}
                      </div>
                      <div style={{ whiteSpace: "pre-line", lineHeight: 1.7, color: "var(--text-secondary)" }}>
                        {currentLesson.body || `Comprehensive lecture notes summarizing the concepts covered in this module for ${courseData.title}, including cheatsheets, reference architectures, and industry best practices.`}
                      </div>
                    </div>
                  )}

                  {activeTab === "Resources" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                      {/* Admin & Tutor Upload Bar */}
                      {(userProfile?.role === "admin" || userProfile?.role === "tutor" || userProfile?.role === "instructor") && (
                        <div style={{ background: "#F8FAFC", border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)", padding: 16 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div>
                              <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "var(--text-primary)" }}>
                                Instructor &amp; Admin Resource Manager
                              </div>
                              <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                                Upload exercise files, slides, and cheat sheets for this course.
                              </div>
                            </div>
                            <button
                              className="btn btn-solid-dark btn-sm"
                              onClick={() => setShowResourceUpload((prev) => !prev)}
                            >
                              {showResourceUpload ? "✕ Cancel" : "+ Upload Course Resource"}
                            </button>
                          </div>

                          {showResourceUpload && (
                            <form onSubmit={handleUploadCourseResource} style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", gap: 10 }}>
                              <div>
                                <label style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                                  RESOURCE TITLE *
                                </label>
                                <input
                                  type="text"
                                  required
                                  placeholder="e.g. Module 2 Hands-on Exercise Files"
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
                                  placeholder="Brief description of file contents"
                                  value={resourceUploadData.description}
                                  onChange={(e) => setResourceUploadData({ ...resourceUploadData, description: e.target.value })}
                                  className="form-field-input"
                                  style={{ padding: "8px 12px", fontSize: "0.875rem" }}
                                />
                              </div>

                              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                                <div>
                                  <label style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                                    ATTACH FILE (PDF, ZIP, DOC, IMG)
                                  </label>
                                  <input
                                    type="file"
                                    onChange={(e) => setResourceUploadData({ ...resourceUploadData, file: e.target.files[0] || null })}
                                    style={{ fontSize: "0.8rem", width: "100%" }}
                                  />
                                </div>
                                <div>
                                  <label style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                                    OR EXTERNAL URL (DRIVE, FIGMA, GITHUB)
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
                              </div>

                              <button
                                type="submit"
                                disabled={isUploadingResource}
                                className="btn btn-solid-dark btn-sm"
                                style={{ alignSelf: "flex-start", marginTop: 6 }}
                              >
                                {isUploadingResource ? "Uploading..." : "Publish to Course →"}
                              </button>
                            </form>
                          )}
                        </div>
                      )}

                      {/* Course Resources List */}
                      {courseResources.length === 0 ? (
                        <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)", padding: 24, textAlign: "center", color: "var(--text-muted)" }}>
                          No resources uploaded for this course yet.
                        </div>
                      ) : (
                        courseResources.map((res) => (
                          <div
                            key={res.id}
                            style={{
                              background: "#FFFFFF",
                              border: "1px solid var(--border-light)",
                              borderRadius: "var(--radius-sm)",
                              padding: "16px 20px",
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              gap: 12,
                            }}
                          >
                            <div style={{ maxWidth: "75%" }}>
                              <div style={{ fontWeight: 700, color: "var(--text-primary)", fontSize: "0.95rem" }}>
                                {res.title}
                              </div>
                              <div style={{ fontSize: "0.825rem", color: "var(--text-muted)", marginTop: 2 }}>
                                {res.desc || res.description}
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                                <span className="pill-badge pill-success">{res.type}</span>
                                {res.fileSize && (
                                  <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{res.fileSize}</span>
                                )}
                                {res.uploaderName && (
                                  <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                                    &bull; Uploaded by {res.uploaderName}
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
                              Download &darr;
                            </a>
                          </div>
                        ))
                      )}
                    </div>
                  )}

                  {activeTab === "Announcements" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                      {/* Tutor / Admin Post Announcement Bar */}
                      {(userProfile?.role === "admin" || userProfile?.role === "tutor" || userProfile?.role === "instructor") && (
                        <div style={{ background: "#F8FAFC", border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)", padding: 16 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div>
                              <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "var(--text-primary)" }}>
                                Course Announcements Manager
                              </div>
                              <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                                Broadcast updates, reminders, or schedule changes to all enrolled students.
                              </div>
                            </div>
                            <button
                              className="btn btn-solid-dark btn-sm"
                              onClick={() => setShowAddAnnouncement((prev) => !prev)}
                            >
                              {showAddAnnouncement ? "✕ Cancel" : "+ New Announcement"}
                            </button>
                          </div>

                          {showAddAnnouncement && (
                            <form onSubmit={handlePostAnnouncement} style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", gap: 10 }}>
                              <div>
                                <label style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                                  ANNOUNCEMENT TITLE *
                                </label>
                                <input
                                  type="text"
                                  required
                                  placeholder="e.g. Midterm Project Submissions Due Friday"
                                  value={announcementForm.title}
                                  onChange={(e) => setAnnouncementForm({ ...announcementForm, title: e.target.value })}
                                  className="form-field-input"
                                  style={{ padding: "8px 12px", fontSize: "0.875rem" }}
                                />
                              </div>
                              <div>
                                <label style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                                  DETAILS / BODY *
                                </label>
                                <textarea
                                  rows={3}
                                  required
                                  placeholder="Write announcement details..."
                                  value={announcementForm.body}
                                  onChange={(e) => setAnnouncementForm({ ...announcementForm, body: e.target.value })}
                                  className="form-field-input"
                                  style={{ padding: "8px 12px", fontSize: "0.875rem" }}
                                />
                              </div>
                              <button
                                type="submit"
                                disabled={postingAnnouncement}
                                className="btn btn-solid-dark btn-sm"
                                style={{ alignSelf: "flex-start" }}
                              >
                                {postingAnnouncement ? "Posting..." : "Broadcast Announcement →"}
                              </button>
                            </form>
                          )}
                        </div>
                      )}

                      {/* Announcements Feed */}
                      {announcements.length === 0 ? (
                        <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)", padding: 24, textAlign: "center", color: "var(--text-muted)" }}>
                          No announcements posted for this course yet.
                        </div>
                      ) : (
                        announcements.map((ann) => (
                          <div
                            key={ann.id}
                            style={{
                              background: "#FFFFFF",
                              border: "1px solid var(--border-light)",
                              borderRadius: "var(--radius-sm)",
                              padding: "18px 20px",
                              display: "flex",
                              flexDirection: "column",
                              gap: 8,
                            }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
                              <div style={{ fontWeight: 700, color: "var(--text-primary)", fontSize: "1.05rem" }}>
                                {ann.title}
                              </div>
                              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                                {ann.createdAt?.seconds ? new Date(ann.createdAt.seconds * 1000).toLocaleDateString() : "Recent"}
                              </div>
                            </div>
                            <p style={{ fontSize: "0.9rem", color: "var(--text-secondary)", lineHeight: 1.6, margin: 0 }}>
                              {ann.body}
                            </p>
                            <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>
                              Posted by <strong style={{ color: "var(--text-primary)" }}>{ann.postedBy || "Course Staff"}</strong>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}

                  {activeTab === "Discussion" && (
                    <div>
                      <form onSubmit={handleAddComment} style={{ display: "flex", gap: 12, marginBottom: 20 }}>
                        <input
                          type="text"
                          placeholder="Ask a question or share a thought on this lesson..."
                          value={newComment}
                          onChange={e => setNewComment(e.target.value)}
                          style={{ flex: 1, padding: "10px 14px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-light)", outline: "none" }}
                        />
                        <button type="submit" className="btn btn-solid-dark">Post</button>
                      </form>
                      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                        {comments.map(c => (
                          <div key={c.id} style={{ padding: "12px 16px", background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                              <span style={{ fontWeight: 700, fontSize: "0.85rem", color: "var(--text-primary)" }}>{c.author}</span>
                              <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{c.time}</span>
                            </div>
                            <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>{c.text}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </main>
        </div>

        {/* Mobile Curriculum Drawer Modal */}
        {showMobileCurriculum && (
          <div className="modal-backdrop-overlay" onClick={() => setShowMobileCurriculum(false)}>
            <div className="modal-dialog-box" onClick={e => e.stopPropagation()} style={{ maxHeight: "80vh" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h3 style={{ fontSize: "1.2rem", fontWeight: 800 }}>Course Curriculum</h3>
                <button className="btn-ghost" onClick={() => setShowMobileCurriculum(false)}>✕</button>
              </div>
              <div>
                {modules.map((mod) => (
                  <div key={mod.id} style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", padding: "6px 0" }}>
                      {mod.title}
                    </div>
                    {mod.lessons.map(lesson => (
                      <div
                        key={lesson.id}
                        style={{
                          padding: "10px 12px",
                          borderRadius: 8,
                          background: lesson.id === activeLessonId ? "var(--primary-learner-light)" : "#F8FAFC",
                          color: lesson.id === activeLessonId ? "var(--primary-learner)" : "var(--text-primary)",
                          fontWeight: lesson.id === activeLessonId ? 700 : 500,
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: 6,
                          cursor: "pointer"
                        }}
                        onClick={() => {
                          setActiveLessonId(lesson.id);
                          setShowMobileCurriculum(false);
                        }}
                      >
                        <span>{lesson.title}</span>
                        <span style={{ fontSize: "0.75rem" }}>{lesson.completed ? "✓" : lesson.duration}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  /* ──────────────────────────────────────────────────────────────────────────
     COURSE DETAIL VIEW (Screen 3 from Mockup)
  ────────────────────────────────────────────────────────────────────────── */
  return (
    <div className="course-detail-page">
      {/* Toast Notification Banner on Detail View */}
      {toastMessage && (
        <div style={{ position: "fixed", top: 80, right: 24, zIndex: 1000, background: "#0F172A", color: "#FFFFFF", padding: "12px 20px", borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow-lg)", fontSize: "0.875rem", fontWeight: 600, display: "flex", alignItems: "center", gap: 10 }}>
          <span>✓</span> {toastMessage}
        </div>
      )}

      {/* Back Breadcrumb */}
      <Link to="/" className="back-breadcrumb">
        &larr; Back
      </Link>

      {/* Header Banner Card */}
      <div className="course-detail-header-card">
        <div>
          <span className={`pill-badge ${courseData.badgeClass}`} style={{ marginBottom: 14 }}>
            {courseData.badge}
          </span>
          <h1 style={{ fontSize: "2.4rem", fontWeight: 800, lineHeight: 1.15, marginBottom: 12 }}>
            {courseData.title}
          </h1>
          <p style={{ fontSize: "1.05rem", color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 20 }}>
            {courseData.description}
          </p>

          <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: 28, flexWrap: "wrap" }}>
            <div className="star-rating-box">
              <span>★</span>
              <strong style={{ color: "var(--text-primary)" }}>{courseData.rating}</strong> ({courseData.reviewsCount} learners)
            </div>
            <span>&bull;</span>
            <span>{courseData.modulesCount} Modules</span>
            <span>&bull;</span>
            <span>{courseData.duration}</span>
            <span>&bull;</span>
            <span>{courseData.level}</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            {isEnrolled ? (
              <button
                className="btn btn-solid-dark btn-lg"
                onClick={() => setViewMode("classroom")}
              >
                Enter Classroom &rarr;
              </button>
            ) : (
              <button
                className="btn btn-solid-dark btn-lg"
                disabled={isEnrolling}
                onClick={() => handleEnroll("online")}
              >
                {isEnrolling ? "Enrolling..." : "Enroll Now"}
              </button>
            )}
          </div>
        </div>

        {/* Right Graphic Preview */}
        <div style={{ borderRadius: "var(--radius-md)", overflow: "hidden", border: "1px solid var(--border-light)", boxShadow: "var(--shadow-md)" }}>
          <img
            src={courseData.image}
            alt={courseData.title}
            style={{ width: "100%", height: 260, objectFit: "cover" }}
          />
        </div>
      </div>

      {/* Choose Your Learning Experience Section */}
      <div style={{ marginTop: 40 }}>
        <h2 style={{ fontSize: "1.6rem", fontWeight: 800, marginBottom: 6 }}>
          Choose your learning experience
        </h2>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.95rem" }}>
          Select how you prefer to master this skill.
        </p>

        <div className="experience-options-grid">
          {/* Card 1: Online Classes */}
          <div
            className="experience-card"
            style={{
              border: (isEnrolled && (enrollment?.experienceType === "online" || selectedExperience === "online"))
                ? "2px solid var(--primary-learner)"
                : selectedExperience === "online"
                ? "2px solid #0F172A"
                : "1px solid var(--border-light)",
              cursor: "pointer",
              transition: "transform 0.15s ease, box-shadow 0.15s ease",
            }}
            onClick={() => handleEnroll("online")}
          >
            <div className="experience-card-header">
              <div className="experience-icon-box">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                  <line x1="8" y1="21" x2="16" y2="21"></line>
                  <line x1="12" y1="17" x2="12" y2="21"></line>
                </svg>
              </div>
              <div>
                <h3 style={{ fontSize: "1.15rem", fontWeight: 700 }}>ONLINE CLASSES</h3>
                <div style={{ fontSize: "0.825rem", color: "var(--text-muted)" }}>Learn from wherever you are.</div>
              </div>
            </div>

            <div className="perks-list">
              <div className="perk-item"><span>✓</span> Online lessons</div>
              <div className="perk-item"><span>✓</span> Digital course materials</div>
              <div className="perk-item"><span>✓</span> Online assignments</div>
              <div className="perk-item"><span>✓</span> Online tests &amp; quizzes</div>
              <div className="perk-item"><span>✓</span> Course announcements &amp; updates</div>
              <div className="perk-item"><span>✓</span> Remote learning resources</div>
            </div>

            <button
              className="btn btn-solid-dark btn-lg"
              style={{ marginTop: "auto", width: "100%" }}
              disabled={isEnrolling}
              onClick={(e) => {
                e.stopPropagation();
                handleEnroll("online");
              }}
            >
              {isEnrolled && (enrollment?.experienceType === "online" || selectedExperience === "online")
                ? "✓ Enrolled • Enter Classroom →"
                : isEnrolling && selectedExperience === "online"
                ? "Enrolling..."
                : isEnrolled
                ? "Switch to Online →"
                : "Choose Online →"}
            </button>
          </div>

          {/* Card 2: Hands-on Training */}
          <div
            className="experience-card"
            style={{
              border: (isEnrolled && (enrollment?.experienceType === "hands-on" || selectedExperience === "hands-on"))
                ? "2px solid var(--primary-learner)"
                : selectedExperience === "hands-on"
                ? "2px solid #0F172A"
                : "1px solid var(--border-light)",
              cursor: "pointer",
              transition: "transform 0.15s ease, box-shadow 0.15s ease",
            }}
            onClick={() => handleEnroll("hands-on")}
          >
            <div className="experience-card-header">
              <div className="experience-icon-box" style={{ background: "#F5F3FF", color: "#5624D0" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                  <circle cx="9" cy="7" r="4"></circle>
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                  <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                </svg>
              </div>
              <div>
                <h3 style={{ fontSize: "1.15rem", fontWeight: 700 }}>HANDS-ON TRAINING</h3>
                <div style={{ fontSize: "0.825rem", color: "var(--text-muted)" }}>Learn by doing, in person.</div>
              </div>
            </div>

            <div className="perks-list">
              <div className="perk-item"><span>✓</span> Instructor-led practical sessions</div>
              <div className="perk-item"><span>✓</span> Physical training &amp; hardware labs</div>
              <div className="perk-item"><span>✓</span> Practical assignments with feedback</div>
              <div className="perk-item"><span>✓</span> Physical learning resources</div>
              <div className="perk-item"><span>✓</span> In-person assessments</div>
              <div className="perk-item"><span>✓</span> Access to studio activities</div>
            </div>

            <button
              className="btn btn-solid-dark btn-lg"
              style={{ marginTop: "auto", width: "100%" }}
              disabled={isEnrolling}
              onClick={(e) => {
                e.stopPropagation();
                handleEnroll("hands-on");
              }}
            >
              {isEnrolled && (enrollment?.experienceType === "hands-on" || selectedExperience === "hands-on")
                ? "✓ Enrolled • Enter Classroom →"
                : isEnrolling && selectedExperience === "hands-on"
                ? "Enrolling..."
                : isEnrolled
                ? "Switch to Hands-on →"
                : "Choose Hands-on →"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
