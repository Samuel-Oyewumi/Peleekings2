import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { COURSES_CATALOG } from "../data/courses";
import { getResources, uploadResource, deleteResource } from "../contexts/resourcesService";
import ErrorBoundary from "../components/ErrorBoundary";

function withTimeout(promise, ms = 5000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("FIRESTORE_REQUEST_TIMEOUT")), ms)
    ),
  ]);
}

function formatFirestoreDate(value, fallback = "Recent", includeTime = false) {
  if (!value) return fallback;
  try {
    let dateObj = null;
    if (typeof value.toDate === "function") {
      dateObj = value.toDate();
    } else if (typeof value === "object" && typeof value.seconds === "number") {
      dateObj = new Date(value.seconds * 1000);
    } else if (value instanceof Date) {
      dateObj = value;
    } else if (typeof value === "string" || typeof value === "number") {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        dateObj = parsed;
      } else if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    if (dateObj && !Number.isNaN(dateObj.getTime())) {
      return includeTime ? dateObj.toLocaleString() : dateObj.toLocaleDateString();
    }
  } catch {
    // Fallback below
  }
  return fallback;
}

function getTimestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value === "object" && typeof value.seconds === "number") return value.seconds * 1000;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export default function AdminPanel() {
  const { userProfile, currentUser } = useAuth();
  const navigate = useNavigate();

  // Active navigation tab
  // Options: "overview", "learners", "tutors", "applications", "courses", "announcements", "notifications", "resources", "analytics", "audit", "settings"
  const [activeTab, setActiveTab] = useState("overview");

  // Global Toast State
  const [toastMessage, setToastMessage] = useState("");
  const [toastType, setToastType] = useState("success"); // "success" | "error" | "info"

  const triggerToast = useCallback((msg, type = "success") => {
    setToastMessage(msg);
    setToastType(type);
    setTimeout(() => setToastMessage(""), 4000);
  }, []);

  // ── Global Loading & Section Error State ──────────────────────────
  const [isProcessing, setIsProcessing] = useState(false);
  const [sectionErrors, setSectionErrors] = useState({});

  const setSectionError = useCallback((section, message) => {
    setSectionErrors((prev) => ({ ...prev, [section]: message || null }));
  }, []);

  // ══════════════════════════════════════════════════════════════════
  // 1. DATA STATE: TUTOR APPLICATIONS
  // ══════════════════════════════════════════════════════════════════
  const [applications, setApplications] = useState([]);
  const [loadingApps, setLoadingApps] = useState(true);
  const [appFilter, setAppFilter] = useState("all");
  const [appSearch, setAppSearch] = useState("");
  const [selectedAppModal, setSelectedAppModal] = useState(null);
  const [rejectModalApp, setRejectModalApp] = useState(null);
  const [rejectionReasonText, setRejectionReasonText] = useState("");

  const fetchApplications = useCallback(async () => {
    setLoadingApps(true);
    setSectionError("applications", null);
    try {
      const snap = await withTimeout(getDocs(collection(db, "tutorApplications")), 6000);
      const list = snap.docs.map((d) => {
        const data = d.data() || {};
        const dateStr = formatFirestoreDate(
          data.submittedAt || data.createdAt || data.date,
          "Recent",
          false
        );
        return {
          ...data,
          id: d.id,
          applicantUid: data.applicantUid || data.uid || "",
          fullName: String(data.fullName || data.name || "Instructor Applicant"),
          email: String(data.email || ""),
          courseTitle: String(data.courseTitle || "Proposed Course"),
          category: String(data.category || "Tech & Digital Skills"),
          courseDescription: String(data.courseDescription || data.description || ""),
          learningOutcomes: String(data.learningOutcomes || ""),
          syllabus: String(data.syllabus || ""),
          status: String(data.status || "pending").toLowerCase(),
          date: dateStr,
          reviewedBy: data.reviewedBy || null,
          rejectionReason: data.rejectionReason ? String(data.rejectionReason) : null,
        };
      });
      setApplications(list);
    } catch (err) {
      console.error("Failed to load tutor applications from Firestore:", err);
      setSectionError("applications", err.message || "Failed to load tutor applications.");
    } finally {
      setLoadingApps(false);
    }
  }, [setSectionError]);

  // ══════════════════════════════════════════════════════════════════
  // 2. DATA STATE: LEARNERS (STUDENTS) & TUTORS
  // ══════════════════════════════════════════════════════════════════
  const [usersList, setUsersList] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [learnerSearch, setLearnerSearch] = useState("");
  const [learnerStatusFilter, setLearnerStatusFilter] = useState("all");
  const [learnerCourseFilter, setLearnerCourseFilter] = useState("all");
  const [learnerSortBy, setLearnerSortBy] = useState("newest");
  const [selectedLearner, setSelectedLearner] = useState(null);
  const [learnerEnrollments, setLearnerEnrollments] = useState([]);
  const [loadingLearnerEnrollments, setLoadingLearnerEnrollments] = useState(false);

  // Modals for Learner Management
  const [showEditLearnerModal, setShowEditLearnerModal] = useState(false);
  const [editLearnerForm, setEditLearnerForm] = useState({
    targetUid: "",
    fullName: "",
    phoneNumber: "",
    bio: "",
    studentType: "non_corper",
    nyscStateCode: "",
  });

  const [showSuspendModal, setShowSuspendModal] = useState(false);
  const [suspendTargetUser, setSuspendTargetUser] = useState(null);
  const [suspendReasonText, setSuspendReasonText] = useState("");

  const [showManualEnrollModal, setShowManualEnrollModal] = useState(false);
  const [enrollTargetCourseId, setEnrollTargetCourseId] = useState("");

  const fetchUsers = useCallback(async () => {
    setLoadingUsers(true);
    setSectionError("users", null);
    try {
      const q = query(collection(db, "users"), limit(200));
      const snap = await withTimeout(getDocs(q), 6000);
      const docs = snap.docs.map((d) => {
        const data = d.data() || {};
        const userName = String(
          data.fullName || data.displayName || (typeof data.email === "string" ? data.email.split("@")[0] : "") || "User"
        );
        const userType = data.studentType === "corper" ? "Corper" : "Non-Corper";
        const dateStr = formatFirestoreDate(data.createdAt || data.date, "Recent", false);
        return {
          ...data,
          id: d.id,
          uid: d.id,
          name: userName,
          fullName: String(data.fullName || userName),
          email: String(data.email || ""),
          phone: String(data.phoneNumber || data.phone || "N/A"),
          phoneNumber: String(data.phoneNumber || data.phone || ""),
          type: userType,
          studentType: String(data.studentType || "non_corper"),
          regId: String(data.regNumber || "Pending"),
          regNumber: String(data.regNumber || "Pending"),
          nyscCode: String(data.nyscStateCode || ""),
          nyscStateCode: String(data.nyscStateCode || ""),
          role: String(data.role || "student").toLowerCase(),
          status: String(data.status || "active").toLowerCase(),
          bio: String(data.bio || ""),
          date: dateStr,
          suspensionReason: data.suspensionReason ? String(data.suspensionReason) : null,
          suspendedAt: data.suspendedAt || null,
        };
      });
      setUsersList(docs);
    } catch (err) {
      console.error("Failed to load users from Firestore:", err);
      setSectionError("users", err.message || "Failed to load users.");
    } finally {
      setLoadingUsers(false);
    }
  }, [setSectionError]);

  // Load individual learner's enrollments from Firestore
  const loadLearnerEnrollments = useCallback(async (uid) => {
    if (!uid) return;
    setLoadingLearnerEnrollments(true);
    try {
      const q = query(collection(db, "enrollments"), where("uid", "==", uid));
      const snap = await withTimeout(getDocs(q), 5000);
      const list = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
      setLearnerEnrollments(list);
    } catch (err) {
      console.warn("Notice loading learner enrollments:", err);
      setLearnerEnrollments([]);
    } finally {
      setLoadingLearnerEnrollments(false);
    }
  }, []);

  // ══════════════════════════════════════════════════════════════════
  // 3. DATA STATE: TUTOR MANAGEMENT & ASSIGNMENTS
  // ══════════════════════════════════════════════════════════════════
  const [tutorSearch, setTutorSearch] = useState("");
  const [selectedTutor, setSelectedTutor] = useState(null);
  const [showCourseAssignModal, setShowCourseAssignModal] = useState(false);
  const [assignCourseSelectId, setAssignCourseSelectId] = useState("");

  const approvedTutors = useMemo(() => {
    return usersList.filter((u) => u.role === "tutor" || u.role === "admin");
  }, [usersList]);

  // ══════════════════════════════════════════════════════════════════
  // 4. DATA STATE: COURSES MANAGEMENT
  // ══════════════════════════════════════════════════════════════════
  const [adminCourses, setAdminCourses] = useState([]);
  const [loadingCourses, setLoadingCourses] = useState(true);
  const [courseCategoryFilter, setCourseCategoryFilter] = useState("all");
  const [courseStatusFilter, setCourseStatusFilter] = useState("all");
  const [courseSearch, setCourseSearch] = useState("");
  const [showAddCourseModal, setShowAddCourseModal] = useState(false);
  const [editingCourse, setEditingCourse] = useState(null);
  const [selectedCourseCurriculum, setSelectedCourseCurriculum] = useState(null);
  const [newCourseForm, setNewCourseForm] = useState({
    title: "",
    category: "Tech & Digital Skills",
    level: "Beginner",
    duration: "6h 00m",
    description: "",
    learningOutcomes: "",
    syllabus: "",
    image: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=600&auto=format&fit=crop&q=80",
    status: "published",
    tutorId: "",
  });

  const fetchCourses = useCallback(async () => {
    setLoadingCourses(true);
    setSectionError("courses", null);
    try {
      const snap = await withTimeout(getDocs(collection(db, "courses")), 6000);
      if (!snap.empty) {
        const list = snap.docs.map((d) => {
          const data = d.data() || {};
          return {
            ...data,
            id: d.id,
            title: String(data.title || "Untitled Course"),
            category: String(data.category || "Tech & Digital Skills"),
            status: String(data.status || "published").toLowerCase(),
            duration: String(data.duration || "Self-paced"),
            description: String(data.description || ""),
          };
        });
        setAdminCourses(list);
      } else {
        // Fallback to catalog defaults if empty
        setAdminCourses(COURSES_CATALOG.map((c) => ({ ...c, status: "published" })));
      }
    } catch (err) {
      console.error("Failed to load courses from Firestore:", err);
      setSectionError("courses", err.message || "Failed to load courses.");
      setAdminCourses((prev) => (prev.length > 0 ? prev : COURSES_CATALOG.map((c) => ({ ...c, status: "published" }))));
    } finally {
      setLoadingCourses(false);
    }
  }, [setSectionError]);

  // ══════════════════════════════════════════════════════════════════
  // 5. DATA STATE: ANNOUNCEMENTS
  // ══════════════════════════════════════════════════════════════════
  const [announcements, setAnnouncements] = useState([]);
  const [loadingAnnouncements, setLoadingAnnouncements] = useState(true);
  const [announcementFilter, setAnnouncementFilter] = useState("all");
  const [showAnnouncementModal, setShowAnnouncementModal] = useState(false);
  const [editingAnnouncement, setEditingAnnouncement] = useState(null);
  const [announcementForm, setAnnouncementForm] = useState({
    id: null,
    title: "",
    body: "",
    category: "General",
    priority: "normal",
    audience: "all",
    courseId: "",
    pinned: false,
    status: "published",
    expiresAt: "",
  });

  const fetchAnnouncements = useCallback(async () => {
    setLoadingAnnouncements(true);
    setSectionError("announcements", null);
    try {
      let snap;
      try {
        const q = query(collection(db, "announcements"), orderBy("createdAt", "desc"));
        snap = await withTimeout(getDocs(q), 5000);
      } catch {
        snap = await withTimeout(getDocs(collection(db, "announcements")), 5000);
      }
      const list = snap.docs
        .map((d) => {
          const data = d.data() || {};
          const dateStr = formatFirestoreDate(data.createdAt || data.date, "Recent", false);
          return {
            ...data,
            id: d.id,
            title: String(data.title || "Announcement"),
            body: String(data.body || ""),
            status: String(data.status || "published").toLowerCase(),
            audience: String(data.audience || "all"),
            priority: String(data.priority || "normal"),
            date: dateStr,
            _sortTime: getTimestampMillis(data.createdAt),
          };
        })
        .sort((a, b) => b._sortTime - a._sortTime);
      setAnnouncements(list);
    } catch (err) {
      console.warn("Notice fetching announcements:", err);
      setSectionError("announcements", err.message || "Failed to load announcements.");
      setAnnouncements([]);
    } finally {
      setLoadingAnnouncements(false);
    }
  }, [setSectionError]);

  // ══════════════════════════════════════════════════════════════════
  // 6. DATA STATE: NOTIFICATIONS DISPATCH
  // ══════════════════════════════════════════════════════════════════
  const [showSendNotifModal, setShowSendNotifModal] = useState(false);
  const [notifForm, setNotifForm] = useState({
    target: "all_learners",
    targetId: "",
    title: "",
    body: "",
    type: "announcement",
    courseId: "",
  });

  // ══════════════════════════════════════════════════════════════════
  // 7. DATA STATE: RESOURCES & UPLOADS
  // ══════════════════════════════════════════════════════════════════
  const [adminResources, setAdminResources] = useState([]);
  const [loadingResources, setLoadingResources] = useState(true);
  const [resourceFilter, setResourceFilter] = useState("all");
  const [showAddResourceModal, setShowAddResourceModal] = useState(false);
  const [newResourceForm, setNewResourceForm] = useState({
    title: "",
    description: "",
    category: "Tech & Digital Skills",
    courseId: "platform",
    externalUrl: "",
    file: null,
  });

  const fetchAdminResources = useCallback(async () => {
    setLoadingResources(true);
    try {
      const res = await withTimeout(getResources("all"), 6000);
      setAdminResources(Array.isArray(res) ? res : []);
    } catch (err) {
      console.error("Failed to load admin resources:", err);
    } finally {
      setLoadingResources(false);
    }
  }, []);

  // ══════════════════════════════════════════════════════════════════
  // 8. DATA STATE: AUDIT LOGS
  // ══════════════════════════════════════════════════════════════════
  const [auditLogs, setAuditLogs] = useState([]);
  const [loadingLogs, setLoadingLogs] = useState(true);
  const [auditFilter, setAuditFilter] = useState("all");
  const [auditSearch, setAuditSearch] = useState("");
  const [selectedAuditLog, setSelectedAuditLog] = useState(null);

  const fetchAuditLogs = useCallback(async () => {
    setLoadingLogs(true);
    setSectionError("audit", null);
    try {
      let snap;
      try {
        const q = query(collection(db, "auditLogs"), orderBy("timestamp", "desc"), limit(100));
        snap = await withTimeout(getDocs(q), 5000);
      } catch {
        const fallbackQ = query(collection(db, "auditLogs"), limit(100));
        snap = await withTimeout(getDocs(fallbackQ), 5000);
      }
      const list = snap.docs
        .map((d) => {
          const data = d.data() || {};
          const rawTs = data.timestamp || data.createdAt || null;
          const dateStr = formatFirestoreDate(rawTs, "Just now", true);
          return {
            ...data,
            id: d.id,
            action: typeof data.action === "string" && data.action ? data.action : "System Event",
            detail: typeof data.detail === "string" ? data.detail : "",
            badge: typeof data.badge === "string" && data.badge ? data.badge : "pill-tech",
            timestamp: dateStr,
            rawTimestamp: rawTs,
            _sortTime: getTimestampMillis(rawTs),
          };
        })
        .sort((a, b) => b._sortTime - a._sortTime);
      setAuditLogs(list);
    } catch (err) {
      console.warn("Failed to load audit logs from Firestore:", err);
      setSectionError("audit", err.message || "Failed to load audit logs.");
      setAuditLogs([]);
    } finally {
      setLoadingLogs(false);
    }
  }, [setSectionError]);

  // ══════════════════════════════════════════════════════════════════
  // 9. DATA STATE: PLATFORM SETTINGS
  // ══════════════════════════════════════════════════════════════════
  const [platformSettings, setPlatformSettings] = useState({
    platformName: "Peleekings LMS",
    supportEmail: "support@peleekings.com",
    maintenanceMode: false,
    openRegistrations: true,
    announcementBannerActive: false,
    bannerMessage: "Welcome to the new academic quarter at Peleekings!",
    allowTutorApplications: true,
  });
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);

  const fetchPlatformSettings = useCallback(async () => {
    setLoadingSettings(true);
    try {
      const docSnap = await withTimeout(getDoc(doc(db, "platformSettings", "general")), 5000);
      if (docSnap.exists()) {
        setPlatformSettings((prev) => ({ ...prev, ...docSnap.data() }));
      }
    } catch (err) {
      console.warn("Notice loading platform settings:", err);
    } finally {
      setLoadingSettings(false);
    }
  }, []);

  // Initial Data Fetch
  useEffect(() => {
    fetchApplications();
    fetchUsers();
    fetchCourses();
    fetchAnnouncements();
    fetchAdminResources();
    fetchAuditLogs();
    fetchPlatformSettings();
  }, [
    fetchApplications,
    fetchUsers,
    fetchCourses,
    fetchAnnouncements,
    fetchAdminResources,
    fetchAuditLogs,
    fetchPlatformSettings,
  ]);

  // ══════════════════════════════════════════════════════════════════
  // ACTIONS: TUTOR APPLICATION DECISIONS
  // ══════════════════════════════════════════════════════════════════
  async function handleApproveApplication(app) {
    if (!window.confirm(`Approve instructor application for "${app.fullName}"? This will assign the tutor role, create an initial course draft, and notify the applicant.`)) {
      return;
    }

    setIsProcessing(true);
    try {
      triggerToast("Executing atomic tutor promotion via Cloud Function...", "info");
      const promoteFn = httpsCallable(functions, "promoteToTutor");
      await promoteFn({ applicationId: app.id });
      triggerToast(`✓ Application approved! ${app.fullName} is now an active Tutor.`);
      setSelectedAppModal(null);
      await fetchApplications();
      await fetchUsers();
      await fetchCourses();
      await fetchAuditLogs();
    } catch (err) {
      console.error("Failed to promote tutor:", err);
      triggerToast("Promotion error: " + (err.message || "Failed to approve application."), "error");
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleConfirmRejectApplication(e) {
    e.preventDefault();
    if (!rejectModalApp) return;

    setIsProcessing(true);
    try {
      const rejectFn = httpsCallable(functions, "rejectTutorApplication");
      await rejectFn({
        applicationId: rejectModalApp.id,
        reason: rejectionReasonText.trim() || "Application does not meet current qualification criteria.",
      });
      triggerToast(`Application for ${rejectModalApp.fullName} rejected.`);
      setRejectModalApp(null);
      setSelectedAppModal(null);
      setRejectionReasonText("");
      await fetchApplications();
      await fetchAuditLogs();
    } catch (err) {
      console.error("Failed to reject application:", err);
      triggerToast("Rejection error: " + (err.message || "Failed."), "error");
    } finally {
      setIsProcessing(false);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // ACTIONS: LEARNER MANAGEMENT
  // ══════════════════════════════════════════════════════════════════
  async function handleSaveLearnerProfile(e) {
    e.preventDefault();
    if (!editLearnerForm.targetUid) return;

    setIsProcessing(true);
    try {
      const updateLearnerFn = httpsCallable(functions, "adminUpdateLearner");
      await updateLearnerFn(editLearnerForm);
      triggerToast("✓ Learner profile successfully updated!");
      setShowEditLearnerModal(false);
      await fetchUsers();
      if (selectedLearner && selectedLearner.id === editLearnerForm.targetUid) {
        setSelectedLearner((prev) => ({ ...prev, ...editLearnerForm }));
      }
      await fetchAuditLogs();
    } catch (err) {
      console.error("Failed to update learner profile:", err);
      triggerToast("Update error: " + (err.message || "Failed."), "error");
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleConfirmSuspend(e) {
    e.preventDefault();
    if (!suspendTargetUser) return;

    setIsProcessing(true);
    try {
      const setStatusFn = httpsCallable(functions, "adminSetAccountStatus");
      await setStatusFn({
        targetUid: suspendTargetUser.id,
        status: "suspended",
        reason: suspendReasonText.trim() || "Administrative suspension.",
      });
      triggerToast(`Account for ${suspendTargetUser.name} has been suspended.`);
      setShowSuspendModal(false);
      setSuspendReasonText("");
      await fetchUsers();
      if (selectedLearner && selectedLearner.id === suspendTargetUser.id) {
        setSelectedLearner((prev) => ({ ...prev, status: "suspended", suspensionReason: suspendReasonText }));
      }
      await fetchAuditLogs();
    } catch (err) {
      console.error("Failed to suspend account:", err);
      triggerToast("Suspension error: " + (err.message || "Failed."), "error");
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleReactivateLearner(user) {
    if (!window.confirm(`Reactivate account for ${user.name}? This will restore their access.`)) {
      return;
    }

    setIsProcessing(true);
    try {
      const setStatusFn = httpsCallable(functions, "adminSetAccountStatus");
      await setStatusFn({
        targetUid: user.id,
        status: "active",
      });
      triggerToast(`✓ Account for ${user.name} is now active.`);
      await fetchUsers();
      if (selectedLearner && selectedLearner.id === user.id) {
        setSelectedLearner((prev) => ({ ...prev, status: "active", suspensionReason: null }));
      }
      await fetchAuditLogs();
    } catch (err) {
      console.error("Failed to reactivate account:", err);
      triggerToast("Reactivation error: " + (err.message || "Failed."), "error");
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleManualEnrollLearner(e) {
    e.preventDefault();
    if (!selectedLearner || !enrollTargetCourseId) return;

    const targetCourse = adminCourses.find((c) => c.id === enrollTargetCourseId) || {
      id: enrollTargetCourseId,
      title: enrollTargetCourseId,
    };

    setIsProcessing(true);
    try {
      const manageEnrollFn = httpsCallable(functions, "adminManageEnrollment");
      await manageEnrollFn({
        action: "grant",
        uid: selectedLearner.id,
        courseId: targetCourse.id,
        courseTitle: targetCourse.title,
      });
      triggerToast(`✓ Enrolled ${selectedLearner.name} in "${targetCourse.title}".`);
      setShowManualEnrollModal(false);
      setEnrollTargetCourseId("");
      await loadLearnerEnrollments(selectedLearner.id);
      await fetchAuditLogs();
    } catch (err) {
      console.error("Failed to enroll learner:", err);
      triggerToast("Enrollment error: " + (err.message || "Failed."), "error");
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleRevokeEnrollment(enrollment) {
    if (!window.confirm(`Revoke enrollment in "${enrollment.courseTitle || enrollment.courseId}" for ${selectedLearner?.name}?`)) {
      return;
    }

    setIsProcessing(true);
    try {
      const manageEnrollFn = httpsCallable(functions, "adminManageEnrollment");
      await manageEnrollFn({
        action: "revoke",
        uid: enrollment.uid,
        courseId: enrollment.courseId,
      });
      triggerToast(`Enrollment revoked for "${enrollment.courseTitle || enrollment.courseId}".`);
      await loadLearnerEnrollments(enrollment.uid);
      await fetchAuditLogs();
    } catch (err) {
      console.error("Failed to revoke enrollment:", err);
      triggerToast("Error revoking enrollment: " + (err.message || "Failed."), "error");
    } finally {
      setIsProcessing(false);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // ACTIONS: TUTOR COURSE ASSIGNMENTS
  // ══════════════════════════════════════════════════════════════════
  async function handleAssignCourseToTutor(e) {
    e.preventDefault();
    if (!selectedTutor || !assignCourseSelectId) return;

    setIsProcessing(true);
    try {
      const assignFn = httpsCallable(functions, "adminAssignCourseTutor");
      await assignFn({
        courseId: assignCourseSelectId,
        tutorUid: selectedTutor.id,
        action: "assign",
      });
      triggerToast(`✓ Assigned course to ${selectedTutor.name}.`);
      setShowCourseAssignModal(false);
      setAssignCourseSelectId("");
      await fetchCourses();
      await fetchAuditLogs();
    } catch (err) {
      console.error("Failed to assign course to tutor:", err);
      triggerToast("Assignment error: " + (err.message || "Failed."), "error");
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleRemoveCourseFromTutor(courseId, tutorUid) {
    if (!window.confirm("Remove this course assignment from the tutor?")) return;

    setIsProcessing(true);
    try {
      const assignFn = httpsCallable(functions, "adminAssignCourseTutor");
      await assignFn({
        courseId,
        tutorUid,
        action: "remove",
      });
      triggerToast("Course assignment removed.");
      await fetchCourses();
      await fetchAuditLogs();
    } catch (err) {
      console.error("Failed to remove course assignment:", err);
      triggerToast("Error removing assignment: " + (err.message || "Failed."), "error");
    } finally {
      setIsProcessing(false);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // ACTIONS: COURSE MANAGEMENT
  // ══════════════════════════════════════════════════════════════════
  async function handleCreateCourse(e) {
    e.preventDefault();
    if (!newCourseForm.title.trim()) return;

    setIsProcessing(true);
    try {
      const slug = newCourseForm.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      const courseId = `${slug}-${Date.now().toString().slice(-4)}`;

      const assignedTutor = approvedTutors.find((t) => t.id === newCourseForm.tutorId);

      const payload = {
        id: courseId,
        title: newCourseForm.title.trim(),
        category: newCourseForm.category,
        level: newCourseForm.level,
        duration: newCourseForm.duration,
        description: newCourseForm.description.trim(),
        learningOutcomes: newCourseForm.learningOutcomes.trim(),
        syllabus: newCourseForm.syllabus.trim(),
        image: newCourseForm.image || "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=600&auto=format&fit=crop&q=80",
        status: newCourseForm.status || "published",
        tutorId: newCourseForm.tutorId || null,
        tutorName: assignedTutor ? assignedTutor.name : null,
        assignedTutors: newCourseForm.tutorId ? [newCourseForm.tutorId] : [],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      await setDoc(doc(db, "courses", courseId), payload);

      // Create default Module 1 for the new course
      await setDoc(doc(db, "courses", courseId, "modules", "module-1"), {
        title: "Module 1: Orientation & Foundations",
        order: 1,
        createdAt: serverTimestamp(),
      });

      triggerToast(`✓ Course "${newCourseForm.title}" created successfully!`);
      setShowAddCourseModal(false);
      setNewCourseForm({
        title: "",
        category: "Tech & Digital Skills",
        level: "Beginner",
        duration: "6h 00m",
        description: "",
        learningOutcomes: "",
        syllabus: "",
        image: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=600&auto=format&fit=crop&q=80",
        status: "published",
        tutorId: "",
      });
      await fetchCourses();
      await fetchAuditLogs();
    } catch (err) {
      console.error("Failed to create course:", err);
      triggerToast("Error creating course: " + err.message, "error");
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleSaveEditCourse(e) {
    e.preventDefault();
    if (!editingCourse) return;

    setIsProcessing(true);
    try {
      const courseRef = doc(db, "courses", editingCourse.id);
      const assignedTutor = approvedTutors.find((t) => t.id === editingCourse.tutorId);

      const updates = {
        title: editingCourse.title.trim(),
        category: editingCourse.category,
        level: editingCourse.level,
        duration: editingCourse.duration,
        description: (editingCourse.description || "").trim(),
        status: editingCourse.status,
        image: editingCourse.image,
        tutorId: editingCourse.tutorId || null,
        tutorName: assignedTutor ? assignedTutor.name : null,
        updatedAt: serverTimestamp(),
      };

      if (editingCourse.tutorId) {
        updates.assignedTutors = [editingCourse.tutorId];
      }

      await updateDoc(courseRef, updates);
      triggerToast(`✓ Course "${editingCourse.title}" updated.`);
      setEditingCourse(null);
      await fetchCourses();
      await fetchAuditLogs();
    } catch (err) {
      console.error("Failed to update course:", err);
      triggerToast("Error updating course: " + err.message, "error");
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleToggleCourseStatus(course) {
    const nextStatus = course.status === "published" ? "draft" : "published";
    setIsProcessing(true);
    try {
      await updateDoc(doc(db, "courses", course.id), {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
      triggerToast(`Course status updated to ${nextStatus}.`);
      setAdminCourses((prev) =>
        prev.map((c) => (c.id === course.id ? { ...c, status: nextStatus } : c))
      );
      await fetchAuditLogs();
    } catch (err) {
      console.error("Failed to toggle course status:", err);
      triggerToast("Error updating course status: " + err.message, "error");
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleDeleteCourse(course) {
    if (!window.confirm(`Are you sure you want to delete course "${course.title}"? This action is permanent.`)) {
      return;
    }

    setIsProcessing(true);
    try {
      await deleteDoc(doc(db, "courses", course.id));
      triggerToast(`Course "${course.title}" deleted.`);
      setAdminCourses((prev) => prev.filter((c) => c.id !== course.id));
      await fetchAuditLogs();
    } catch (err) {
      console.error("Failed to delete course:", err);
      triggerToast("Error deleting course: " + err.message, "error");
    } finally {
      setIsProcessing(false);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // ACTIONS: ANNOUNCEMENTS MANAGEMENT
  // ══════════════════════════════════════════════════════════════════
  async function handleSaveAnnouncement(e) {
    e.preventDefault();
    if (!announcementForm.title.trim() || !announcementForm.body.trim()) {
      triggerToast("Please provide both title and announcement body.", "error");
      return;
    }

    setIsProcessing(true);
    try {
      const pubFn = httpsCallable(functions, "adminPublishAnnouncement");
      await pubFn(announcementForm);
      triggerToast("✓ Announcement published successfully!");
      setShowAnnouncementModal(false);
      setEditingAnnouncement(null);
      setAnnouncementForm({
        id: null,
        title: "",
        body: "",
        category: "General",
        priority: "normal",
        audience: "all",
        courseId: "",
        pinned: false,
        status: "published",
        expiresAt: "",
      });
      await fetchAnnouncements();
      await fetchAuditLogs();
    } catch (err) {
      console.error("Failed to save announcement:", err);
      triggerToast("Announcement error: " + (err.message || "Failed to publish."), "error");
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleDeleteAnnouncement(announcement) {
    if (!window.confirm(`Delete announcement "${announcement.title}"?`)) return;

    setIsProcessing(true);
    try {
      await deleteDoc(doc(db, "announcements", announcement.id));
      triggerToast("Announcement removed.");
      setAnnouncements((prev) => prev.filter((a) => a.id !== announcement.id));
      await fetchAuditLogs();
    } catch (err) {
      console.error("Failed to delete announcement:", err);
      triggerToast("Error deleting announcement: " + err.message, "error");
    } finally {
      setIsProcessing(false);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // ACTIONS: NOTIFICATIONS DISPATCH
  // ══════════════════════════════════════════════════════════════════
  async function handleSendNotification(e) {
    e.preventDefault();
    if (!notifForm.title.trim() || !notifForm.body.trim()) {
      triggerToast("Please fill in both title and message.", "error");
      return;
    }

    setIsProcessing(true);
    try {
      const sendNotifFn = httpsCallable(functions, "adminSendNotification");
      const res = await sendNotifFn(notifForm);
      triggerToast(`✓ Dispatched notification to ${res.data?.count || 0} recipient(s)!`);
      setShowSendNotifModal(false);
      setNotifForm({
        target: "all_learners",
        targetId: "",
        title: "",
        body: "",
        type: "announcement",
        courseId: "",
      });
      await fetchAuditLogs();
    } catch (err) {
      console.error("Failed to send notifications:", err);
      triggerToast("Dispatch error: " + (err.message || "Failed."), "error");
    } finally {
      setIsProcessing(false);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // ACTIONS: RESOURCES MANAGEMENT
  // ══════════════════════════════════════════════════════════════════
  async function handleUploadResource(e) {
    e.preventDefault();
    if (!newResourceForm.title.trim() || (!newResourceForm.file && !newResourceForm.externalUrl.trim())) {
      triggerToast("Please provide a title and either a file upload or external URL.", "error");
      return;
    }

    setIsProcessing(true);
    try {
      const created = await uploadResource({
        file: newResourceForm.file,
        title: newResourceForm.title,
        description: newResourceForm.description,
        category: newResourceForm.category,
        courseId: newResourceForm.courseId,
        externalUrl: newResourceForm.externalUrl,
        user: {
          uid: currentUser?.uid || "admin",
          displayName: userProfile?.fullName || "Administrator",
          role: "admin",
        },
      });

      setAdminResources((prev) => [created, ...prev]);
      setShowAddResourceModal(false);
      setNewResourceForm({
        title: "",
        description: "",
        category: "Tech & Digital Skills",
        courseId: "platform",
        externalUrl: "",
        file: null,
      });
      triggerToast("✓ Resource uploaded and published to platform!");
      await fetchAdminResources();
    } catch (err) {
      console.error("Resource upload failure:", err);
      triggerToast("Upload failed: " + (err.message || "Cloud Storage error."), "error");
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleDeleteResourceItem(resource) {
    if (!window.confirm(`Delete resource "${resource.title}"?`)) return;

    setIsProcessing(true);
    try {
      await deleteResource(resource.id, resource.fileUrl);
      setAdminResources((prev) => prev.filter((r) => r.id !== resource.id));
      triggerToast("Resource removed.");
    } catch (err) {
      console.error("Failed to delete resource:", err);
      triggerToast("Failed to delete resource: " + err.message, "error");
    } finally {
      setIsProcessing(false);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // ACTIONS: PLATFORM SETTINGS
  // ══════════════════════════════════════════════════════════════════
  async function handleSaveSettings(e) {
    e.preventDefault();
    setSavingSettings(true);
    try {
      const settingsRef = doc(db, "platformSettings", "general");
      await setDoc(settingsRef, {
        ...platformSettings,
        updatedAt: serverTimestamp(),
        updatedBy: currentUser?.uid || "admin",
      }, { merge: true });

      // Record audit log
      await setDoc(doc(collection(db, "auditLogs")), {
        action: "Platform Settings Updated",
        detail: "Administrator updated platform system configurations.",
        adminUid: currentUser?.uid || "admin",
        badge: "pill-tech",
        timestamp: serverTimestamp(),
      });

      triggerToast("✓ Platform settings successfully saved!");
      await fetchAuditLogs();
    } catch (err) {
      console.error("Failed to save settings:", err);
      triggerToast("Error saving platform settings: " + err.message, "error");
    } finally {
      setSavingSettings(false);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // FILTERED LISTS
  // ══════════════════════════════════════════════════════════════════
  const filteredLearners = useMemo(() => {
    return usersList.filter((u) => {
      // Must not be admin (learners directory targets students)
      if (u.role === "admin") return false;

      // Status filter
      if (learnerStatusFilter !== "all" && u.status?.toLowerCase() !== learnerStatusFilter.toLowerCase()) {
        return false;
      }

      // Search filter
      if (learnerSearch.trim()) {
        const queryStr = learnerSearch.toLowerCase();
        const matchName = u.name?.toLowerCase().includes(queryStr);
        const matchEmail = u.email?.toLowerCase().includes(queryStr);
        const matchReg = u.regId?.toLowerCase().includes(queryStr);
        if (!matchName && !matchEmail && !matchReg) return false;
      }

      return true;
    }).sort((a, b) => {
      if (learnerSortBy === "name") return (a.name || "").localeCompare(b.name || "");
      if (learnerSortBy === "oldest") return (a.date || "").localeCompare(b.date || "");
      // Default newest
      return (b.date || "").localeCompare(a.date || "");
    });
  }, [usersList, learnerStatusFilter, learnerSearch, learnerSortBy]);

  const filteredApplications = useMemo(() => {
    return applications.filter((app) => {
      if (appFilter !== "all" && app.status !== appFilter) return false;
      if (appSearch.trim()) {
        const queryStr = appSearch.toLowerCase();
        const matchName = app.fullName?.toLowerCase().includes(queryStr);
        const matchEmail = app.email?.toLowerCase().includes(queryStr);
        const matchCourse = app.courseTitle?.toLowerCase().includes(queryStr);
        if (!matchName && !matchEmail && !matchCourse) return false;
      }
      return true;
    });
  }, [applications, appFilter, appSearch]);

  const filteredCourses = useMemo(() => {
    return adminCourses.filter((c) => {
      if (courseCategoryFilter !== "all" && c.category !== courseCategoryFilter) return false;
      if (courseStatusFilter !== "all" && c.status?.toLowerCase() !== courseStatusFilter.toLowerCase()) return false;
      if (courseSearch.trim()) {
        const queryStr = courseSearch.toLowerCase();
        const matchTitle = c.title?.toLowerCase().includes(queryStr);
        const matchDesc = c.description?.toLowerCase().includes(queryStr);
        if (!matchTitle && !matchDesc) return false;
      }
      return true;
    });
  }, [adminCourses, courseCategoryFilter, courseStatusFilter, courseSearch]);

  const filteredAnnouncements = useMemo(() => {
    return announcements.filter((a) => {
      if (announcementFilter !== "all" && a.status !== announcementFilter) return false;
      return true;
    });
  }, [announcements, announcementFilter]);

  const filteredAuditLogs = useMemo(() => {
    return auditLogs.filter((log) => {
      if (auditFilter !== "all" && log.action !== auditFilter) return false;
      if (auditSearch.trim()) {
        const q = auditSearch.toLowerCase();
        const matchAction = log.action?.toLowerCase().includes(q);
        const matchDetail = log.detail?.toLowerCase().includes(q);
        const matchAdmin = log.adminUid?.toLowerCase().includes(q);
        if (!matchAction && !matchDetail && !matchAdmin) return false;
      }
      return true;
    });
  }, [auditLogs, auditFilter, auditSearch]);

  // Distinct Action Types for Audit Filter
  const distinctAuditActions = useMemo(() => {
    return Array.from(new Set(auditLogs.map((l) => l.action).filter(Boolean)));
  }, [auditLogs]);

  return (
    <div className="admin-page-container" style={{ minHeight: "100vh", background: "var(--bg-main)", padding: "28px 20px 80px" }}>
      {/* Toast Notification */}
      {toastMessage && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            zIndex: 9999,
            padding: "12px 20px",
            borderRadius: 8,
            color: "#FFFFFF",
            background: toastType === "error" ? "#DC2626" : toastType === "info" ? "#2563EB" : "#16A34A",
            boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
            fontSize: "0.875rem",
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 10,
            animation: "slideIn 0.3s ease-out",
          }}
        >
          <span>{toastType === "error" ? "⚠️" : toastType === "info" ? "ℹ️" : "✓"}</span>
          <span>{toastMessage}</span>
        </div>
      )}

      <div style={{ maxWidth: 1280, margin: "0 auto" }}>
        {/* ── Top Header ────────────────────────────────────────────── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28, flexWrap: "wrap", gap: 16 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span className="pill-badge pill-tech">ADMIN CONSOLE</span>
              <span className="pill-badge pill-success">VERIFIED SESSION</span>
            </div>
            <h1 style={{ fontSize: "2.1rem", fontWeight: 800, color: "var(--text-primary)", margin: 0 }}>
              Peleekings Admin Console
            </h1>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.95rem", margin: "4px 0 0" }}>
              Comprehensive administrative management system: learners, instructors, courses, announcements, and audit records.
            </p>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn btn-outline btn-sm" onClick={() => navigate("/dashboard")}>
              Learner Portal &rarr;
            </button>
            <button className="btn btn-outline btn-sm" onClick={() => navigate("/teach-portal")}>
              Teaching Portal &rarr;
            </button>
          </div>
        </div>

        {/* ── High-Level KPI Summary (Always Visible) ────────────────── */}
        <div className="stats-cards-deck" style={{ marginBottom: 24 }}>
          {[
            { label: "Total Learners", value: `${usersList.filter((u) => u.role !== "admin" && u.role !== "tutor").length}`, color: "pill-tech" },
            { label: "Approved Tutors", value: `${approvedTutors.length}`, color: "pill-success" },
            { label: "Pending Applications", value: `${applications.filter((a) => a.status === "pending").length}`, color: "pill-creative" },
            { label: "Published Courses", value: `${adminCourses.filter((c) => c.status === "published").length}`, color: "pill-success" },
            { label: "Audit Events", value: `${auditLogs.length}`, color: "pill-tech" },
          ].map((m) => (
            <div key={m.label} className="stat-metric-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)", letterSpacing: "0.05em" }}>
                  {m.label}
                </span>
                <span className={`pill-badge ${m.color}`}>LIVE</span>
              </div>
              <div style={{ fontSize: "1.9rem", fontWeight: 900, color: "var(--text-primary)", margin: "8px 0 2px", fontFamily: "Montserrat, sans-serif" }}>
                {m.value}
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                Verified Firestore data
              </div>
            </div>
          ))}
        </div>

        {/* ── 11-Tab Navigation Bar ──────────────────────────────────── */}
        <div
          style={{
            display: "flex",
            gap: 8,
            borderBottom: "1px solid var(--border-light)",
            paddingBottom: 12,
            marginBottom: 28,
            overflowX: "auto",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {[
            { id: "overview", label: "Overview", count: null },
            { id: "learners", label: "Learner Management", count: usersList.filter((u) => u.role !== "admin" && u.role !== "tutor").length },
            { id: "tutors", label: "Tutor Management", count: approvedTutors.length },
            { id: "applications", label: "Tutor Applications", count: applications.filter((a) => a.status === "pending").length },
            { id: "courses", label: "Course Management", count: adminCourses.length },
            { id: "announcements", label: "Announcements", count: announcements.length },
            { id: "notifications", label: "Notifications", count: null },
            { id: "resources", label: "Resources", count: adminResources.length },
            { id: "analytics", label: "Analytics", count: null },
            { id: "audit", label: "Audit Logs", count: auditLogs.length },
            { id: "settings", label: "Platform Settings", count: null },
          ].map((t) => (
            <button
              key={t.id}
              className={`btn ${activeTab === t.id ? "btn-solid-dark" : "btn-outline"} btn-sm`}
              style={{ whiteSpace: "nowrap" }}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label} {t.count !== null && `(${t.count})`}
            </button>
          ))}
        </div>

        {/* Non-blocking section error banner if a Firestore request for the current tab failed */}
        {(() => {
          const activeErrorMsg =
            activeTab === "overview"
              ? sectionErrors.audit
              : activeTab === "learners" || activeTab === "tutors" || activeTab === "analytics"
              ? sectionErrors.users
              : sectionErrors[activeTab];
          if (!activeErrorMsg) return null;
          return (
            <div
              role="alert"
              style={{
                marginBottom: 20,
                padding: "12px 16px",
                borderRadius: 10,
                background: "#FEF2F2",
                border: "1px solid #FECACA",
                color: "#991B1B",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
                fontSize: "0.875rem",
              }}
            >
              <span>
                <strong>Notice:</strong> {activeErrorMsg}
              </span>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => {
                  if (activeTab === "applications") fetchApplications();
                  else if (activeTab === "learners" || activeTab === "tutors" || activeTab === "analytics") fetchUsers();
                  else if (activeTab === "courses") fetchCourses();
                  else if (activeTab === "announcements") fetchAnnouncements();
                  else if (activeTab === "resources") fetchResources();
                  else fetchAuditLogs();
                }}
              >
                Retry Request
              </button>
            </div>
          );
        })()}

        <ErrorBoundary
          inline
          resetKeys={[activeTab]}
          title="Unable to render this Admin Console tab"
          message="An unexpected error occurred while displaying this tab. You can retry or switch to another tab."
        >
        {/* ══════════════════════════════════════════════════════════════ */}
        {/* TAB 1: OVERVIEW */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {activeTab === "overview" && (
          <div>
            {/* Quick Action Shortcuts */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 28 }}>
              <div
                className="dashboard-card"
                style={{ padding: 18, cursor: "pointer", border: "1px solid var(--border-light)", borderRadius: 12, background: "#FFFFFF" }}
                onClick={() => setActiveTab("applications")}
              >
                <div style={{ fontSize: "1.2rem", marginBottom: 6 }}>📬</div>
                <h4 style={{ margin: "0 0 4px", fontSize: "1rem", fontWeight: 700 }}>Review Applications</h4>
                <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  {applications.filter((a) => a.status === "pending").length} pending tutor requests awaiting review.
                </p>
              </div>

              <div
                className="dashboard-card"
                style={{ padding: 18, cursor: "pointer", border: "1px solid var(--border-light)", borderRadius: 12, background: "#FFFFFF" }}
                onClick={() => setActiveTab("announcements")}
              >
                <div style={{ fontSize: "1.2rem", marginBottom: 6 }}>📢</div>
                <h4 style={{ margin: "0 0 4px", fontSize: "1rem", fontWeight: 700 }}>Post Announcement</h4>
                <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  Publish notices across student and tutor dashboards.
                </p>
              </div>

              <div
                className="dashboard-card"
                style={{ padding: 18, cursor: "pointer", border: "1px solid var(--border-light)", borderRadius: 12, background: "#FFFFFF" }}
                onClick={() => setActiveTab("courses")}
              >
                <div style={{ fontSize: "1.2rem", marginBottom: 6 }}>📚</div>
                <h4 style={{ margin: "0 0 4px", fontSize: "1rem", fontWeight: 700 }}>Manage Courses</h4>
                <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  Create courses, assign instructors, and update content.
                </p>
              </div>

              <div
                className="dashboard-card"
                style={{ padding: 18, cursor: "pointer", border: "1px solid var(--border-light)", borderRadius: 12, background: "#FFFFFF" }}
                onClick={() => setActiveTab("notifications")}
              >
                <div style={{ fontSize: "1.2rem", marginBottom: 6 }}>🔔</div>
                <h4 style={{ margin: "0 0 4px", fontSize: "1rem", fontWeight: 700 }}>Dispatch Notification</h4>
                <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  Send targeted in-app alerts to learners or instructors.
                </p>
              </div>
            </div>

            {/* Recent Audit Activities Stream */}
            <div className="dashboard-card" style={{ padding: 24, borderRadius: 12, border: "1px solid var(--border-light)", background: "#FFFFFF" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: "1.2rem", fontWeight: 800 }}>Recent Platform Activities &amp; Audit Stream</h3>
                  <p style={{ margin: "4px 0 0", fontSize: "0.85rem", color: "var(--text-muted)" }}>
                    Immutable server-recorded events across user creation, role promotions, and status changes.
                  </p>
                </div>
                <button className="btn btn-outline btn-sm" onClick={() => setActiveTab("audit")}>
                  View All Audit Logs &rarr;
                </button>
              </div>

              {loadingLogs ? (
                <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>Loading audit records...</div>
              ) : auditLogs.length === 0 ? (
                <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>No recorded audit events found.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {auditLogs.slice(0, 8).map((log) => (
                    <div
                      key={log.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "12px 16px",
                        borderRadius: 8,
                        background: "var(--bg-main)",
                        border: "1px solid var(--border-light)",
                        gap: 12,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <span className={`pill-badge ${log.badge || "pill-tech"}`} style={{ fontSize: "0.75rem" }}>
                          {String(log.action || "System Event")}
                        </span>
                        <span style={{ fontSize: "0.875rem", color: "var(--text-primary)" }}>{String(log.detail || "")}</span>
                      </div>
                      <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                        {typeof log.timestamp === "string" ? log.timestamp : formatFirestoreDate(log.timestamp, "Recent", true)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* TAB 2: LEARNER MANAGEMENT */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {activeTab === "learners" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
              <div>
                <h2 style={{ fontSize: "1.3rem", fontWeight: 800, margin: 0 }}>Learner Directory</h2>
                <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: "4px 0 0" }}>
                  Inspect registered learners, view course progress, manage enrollments, and toggle account access.
                </p>
              </div>
            </div>

            {/* Filter & Search Bar */}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 20 }}>
              <input
                type="text"
                placeholder="Search by name, email, or reg number..."
                className="form-field-input"
                style={{ maxWidth: 320 }}
                value={learnerSearch}
                onChange={(e) => setLearnerSearch(e.target.value)}
              />

              <div style={{ display: "flex", gap: 6 }}>
                {["all", "active", "suspended"].map((st) => (
                  <button
                    key={st}
                    className={`filter-pill-btn ${learnerStatusFilter === st ? "active" : ""}`}
                    onClick={() => setLearnerStatusFilter(st)}
                  >
                    {st === "all" ? "All Status" : st.charAt(0).toUpperCase() + st.slice(1)}
                  </button>
                ))}
              </div>

              <select
                className="form-field-input"
                style={{ width: "auto" }}
                value={learnerSortBy}
                onChange={(e) => setLearnerSortBy(e.target.value)}
              >
                <option value="newest">Sort: Newest Registered</option>
                <option value="oldest">Sort: Oldest Registered</option>
                <option value="name">Sort: Name (A-Z)</option>
              </select>

              <div style={{ marginLeft: "auto", fontSize: "0.85rem", color: "var(--text-muted)" }}>
                Showing {filteredLearners.length} registered learner(s)
              </div>
            </div>

            {/* Learners Table */}
            <div className="admin-table-container" style={{ background: "#FFFFFF", borderRadius: 12, border: "1px solid var(--border-light)", overflowX: "auto" }}>
              <table className="admin-table" style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border-light)", background: "var(--bg-main)" }}>
                    <th style={{ padding: "12px 16px", fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)" }}>REG CODE</th>
                    <th style={{ padding: "12px 16px", fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)" }}>FULL NAME</th>
                    <th style={{ padding: "12px 16px", fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)" }}>EMAIL</th>
                    <th style={{ padding: "12px 16px", fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)" }}>TYPE</th>
                    <th style={{ padding: "12px 16px", fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)" }}>STATUS</th>
                    <th style={{ padding: "12px 16px", fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)" }}>JOINED</th>
                    <th style={{ padding: "12px 16px", fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)", textAlign: "right" }}>ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {loadingUsers ? (
                    <tr>
                      <td colSpan={7} style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>
                        Loading registered learners from Firestore...
                      </td>
                    </tr>
                  ) : filteredLearners.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>
                        No learners match the current filter criteria.
                      </td>
                    </tr>
                  ) : (
                    filteredLearners.map((u) => (
                      <tr key={u.id} style={{ borderBottom: "1px solid var(--border-light)" }}>
                        <td style={{ padding: "12px 16px", fontWeight: 700, fontSize: "0.85rem", color: "var(--primary-learner)" }}>
                          {u.regId}
                        </td>
                        <td style={{ padding: "12px 16px", fontWeight: 600, fontSize: "0.9rem" }}>{u.name}</td>
                        <td style={{ padding: "12px 16px", fontSize: "0.85rem", color: "var(--text-secondary)" }}>{u.email}</td>
                        <td style={{ padding: "12px 16px" }}>
                          <span className={`pill-badge ${u.studentType === "corper" ? "pill-success" : "pill-tech"}`} style={{ fontSize: "0.75rem" }}>
                            {u.studentType === "corper" ? "NYSC Corper" : "Standard"}
                          </span>
                        </td>
                        <td style={{ padding: "12px 16px" }}>
                          <span className={`pill-badge ${u.status === "suspended" ? "pill-danger" : "pill-success"}`} style={{ fontSize: "0.75rem" }}>
                            {u.status === "suspended" ? "Suspended" : "Active"}
                          </span>
                        </td>
                        <td style={{ padding: "12px 16px", fontSize: "0.85rem", color: "var(--text-muted)" }}>{u.date}</td>
                        <td style={{ padding: "12px 16px", textAlign: "right" }}>
                          <div style={{ display: "inline-flex", gap: 6 }}>
                            <button
                              className="btn btn-outline btn-sm"
                              onClick={() => {
                                setSelectedLearner(u);
                                loadLearnerEnrollments(u.id);
                              }}
                            >
                              Manage Profile
                            </button>
                            {u.status === "suspended" ? (
                              <button
                                className="btn btn-outline btn-sm"
                                style={{ color: "#16A34A" }}
                                onClick={() => handleReactivateLearner(u)}
                              >
                                Reactivate
                              </button>
                            ) : (
                              <button
                                className="btn btn-outline btn-sm"
                                style={{ color: "#DC2626" }}
                                onClick={() => {
                                  setSuspendTargetUser(u);
                                  setShowSuspendModal(true);
                                }}
                              >
                                Suspend
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* TAB 3: TUTOR MANAGEMENT */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {activeTab === "tutors" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
              <div>
                <h2 style={{ fontSize: "1.3rem", fontWeight: 800, margin: 0 }}>Approved Instructors &amp; Course Assignments</h2>
                <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: "4px 0 0" }}>
                  View approved tutors, check assigned curriculum courses, and manage instructor course assignments.
                </p>
              </div>
            </div>

            {/* Tutor Search */}
            <div style={{ marginBottom: 20 }}>
              <input
                type="text"
                placeholder="Search tutors by name or email..."
                className="form-field-input"
                style={{ maxWidth: 320 }}
                value={tutorSearch}
                onChange={(e) => setTutorSearch(e.target.value)}
              />
            </div>

            {/* Tutors Grid */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 16 }}>
              {approvedTutors
                .filter((t) => {
                  if (!tutorSearch.trim()) return true;
                  const q = tutorSearch.toLowerCase();
                  return t.name?.toLowerCase().includes(q) || t.email?.toLowerCase().includes(q);
                })
                .map((t) => {
                  const assigned = adminCourses.filter(
                    (c) => c.tutorId === t.id || (c.assignedTutors && c.assignedTutors.includes(t.id))
                  );

                  return (
                    <div
                      key={t.id}
                      className="dashboard-card"
                      style={{ padding: 20, borderRadius: 12, border: "1px solid var(--border-light)", background: "#FFFFFF" }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                            <span className="pill-badge pill-success">APPROVED INSTRUCTOR</span>
                            {t.role === "admin" && <span className="pill-badge pill-tech">ADMIN</span>}
                          </div>
                          <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700 }}>{t.name}</h3>
                          <div style={{ fontSize: "0.825rem", color: "var(--text-muted)" }}>{t.email}</div>
                        </div>
                        <button
                          className="btn btn-outline btn-sm"
                          onClick={() => {
                            setSelectedTutor(t);
                            setShowCourseAssignModal(true);
                          }}
                        >
                          + Assign Course
                        </button>
                      </div>

                      {t.bio && (
                        <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", margin: "0 0 12px", lineHeight: 1.4 }}>
                          {t.bio}
                        </p>
                      )}

                      <div style={{ borderTop: "1px solid var(--border-light)", paddingTop: 12, marginTop: 8 }}>
                        <div style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 8 }}>
                          Assigned Courses ({assigned.length})
                        </div>
                        {assigned.length === 0 ? (
                          <div style={{ fontSize: "0.825rem", color: "var(--text-muted)", fontStyle: "italic" }}>
                            No courses currently assigned to this instructor.
                          </div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            {assigned.map((c) => (
                              <div
                                key={c.id}
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  padding: "6px 10px",
                                  borderRadius: 6,
                                  background: "var(--bg-main)",
                                  fontSize: "0.85rem",
                                }}
                              >
                                <span style={{ fontWeight: 600 }}>{c.title}</span>
                                <button
                                  style={{
                                    border: "none",
                                    background: "transparent",
                                    color: "#DC2626",
                                    cursor: "pointer",
                                    fontSize: "0.75rem",
                                    fontWeight: 700,
                                  }}
                                  onClick={() => handleRemoveCourseFromTutor(c.id, t.id)}
                                >
                                  Remove
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* TAB 4: TUTOR APPLICATIONS */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {activeTab === "applications" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
              <div>
                <h2 style={{ fontSize: "1.3rem", fontWeight: 800, margin: 0 }}>Tutor Applications Queue</h2>
                <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: "4px 0 0" }}>
                  Loaded from tutorApplications collection. Approving atomically assigns custom claims, creates draft course, and notifies applicant.
                </p>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {["all", "pending", "approved", "rejected"].map((filter) => (
                  <button
                    key={filter}
                    className={`filter-pill-btn ${appFilter === filter ? "active" : ""}`}
                    onClick={() => setAppFilter(filter)}
                  >
                    {filter.charAt(0).toUpperCase() + filter.slice(1)} (
                    {applications.filter((a) => (filter === "all" ? true : a.status === filter)).length})
                  </button>
                ))}
              </div>
            </div>

            {/* Applications List */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {loadingApps ? (
                <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>Loading applications...</div>
              ) : filteredApplications.length === 0 ? (
                <div className="dashboard-card" style={{ padding: 40, textAlign: "center", background: "#FFFFFF", borderRadius: 12 }}>
                  <div style={{ fontSize: "2rem", marginBottom: 8 }}>📬</div>
                  <h3 style={{ margin: 0, fontWeight: 700 }}>No Applications Found</h3>
                  <p style={{ margin: "4px 0 0", color: "var(--text-muted)", fontSize: "0.875rem" }}>
                    There are no applications matching the current filter.
                  </p>
                </div>
              ) : (
                filteredApplications.map((app) => (
                  <div
                    key={app.id}
                    className="dashboard-card"
                    style={{
                      padding: 20,
                      borderRadius: 12,
                      background: "#FFFFFF",
                      border: "1px solid var(--border-light)",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: 16,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 260 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                        <span
                          className={`pill-badge ${
                            app.status === "approved" ? "pill-success" : app.status === "rejected" ? "pill-danger" : "pill-warning"
                          }`}
                          style={{ fontSize: "0.75rem" }}
                        >
                          {(app.status || "pending").toUpperCase()}
                        </span>
                        <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Submitted {String(app.date || "Recently")}</span>
                      </div>
                      <h3 style={{ margin: "0 0 2px", fontSize: "1.1rem", fontWeight: 700 }}>{app.fullName}</h3>
                      <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: 6 }}>{app.email}</div>
                      <div style={{ fontSize: "0.9rem", fontWeight: 600, color: "var(--primary-learner)" }}>
                        Proposed Course: {app.courseTitle}
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <button className="btn btn-outline btn-sm" onClick={() => setSelectedAppModal(app)}>
                        View Details
                      </button>
                      {app.status === "pending" && (
                        <>
                          <button
                            className="btn btn-solid-dark btn-sm"
                            disabled={isProcessing}
                            onClick={() => handleApproveApplication(app)}
                          >
                            Approve
                          </button>
                          <button
                            className="btn btn-outline btn-sm"
                            style={{ color: "#DC2626" }}
                            disabled={isProcessing}
                            onClick={() => {
                              setRejectModalApp(app);
                              setRejectionReasonText("");
                            }}
                          >
                            Reject
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* TAB 5: COURSE MANAGEMENT */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {activeTab === "courses" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
              <div>
                <h2 style={{ fontSize: "1.3rem", fontWeight: 800, margin: 0 }}>Course Administration</h2>
                <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: "4px 0 0" }}>
                  Create and publish courses, edit metadata, configure assigned instructors, and manage curriculum modules.
                </p>
              </div>
              <button className="btn btn-solid-dark btn-sm" onClick={() => setShowAddCourseModal(true)}>
                + Create New Course
              </button>
            </div>

            {/* Filter Bar */}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 20 }}>
              <input
                type="text"
                placeholder="Search courses..."
                className="form-field-input"
                style={{ maxWidth: 280 }}
                value={courseSearch}
                onChange={(e) => setCourseSearch(e.target.value)}
              />

              <div style={{ display: "flex", gap: 6 }}>
                {["all", "published", "draft"].map((st) => (
                  <button
                    key={st}
                    className={`filter-pill-btn ${courseStatusFilter === st ? "active" : ""}`}
                    onClick={() => setCourseStatusFilter(st)}
                  >
                    {st === "all" ? "All Status" : st.charAt(0).toUpperCase() + st.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Courses Table */}
            <div className="admin-table-container" style={{ background: "#FFFFFF", borderRadius: 12, border: "1px solid var(--border-light)", overflowX: "auto" }}>
              <table className="admin-table" style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border-light)", background: "var(--bg-main)" }}>
                    <th style={{ padding: "12px 16px", fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)" }}>TITLE</th>
                    <th style={{ padding: "12px 16px", fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)" }}>CATEGORY</th>
                    <th style={{ padding: "12px 16px", fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)" }}>STATUS</th>
                    <th style={{ padding: "12px 16px", fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)" }}>INSTRUCTOR</th>
                    <th style={{ padding: "12px 16px", fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)" }}>DURATION</th>
                    <th style={{ padding: "12px 16px", fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)", textAlign: "right" }}>ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {loadingCourses ? (
                    <tr>
                      <td colSpan={6} style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>
                        Loading courses from Firestore...
                      </td>
                    </tr>
                  ) : filteredCourses.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>
                        No courses found matching criteria.
                      </td>
                    </tr>
                  ) : (
                    filteredCourses.map((c) => (
                      <tr key={c.id} style={{ borderBottom: "1px solid var(--border-light)" }}>
                        <td style={{ padding: "12px 16px" }}>
                          <div style={{ fontWeight: 700, fontSize: "0.9rem" }}>{c.title}</div>
                          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>ID: {c.id}</div>
                        </td>
                        <td style={{ padding: "12px 16px", fontSize: "0.85rem" }}>{c.category || "General"}</td>
                        <td style={{ padding: "12px 16px" }}>
                          <span
                            className={`pill-badge ${c.status === "published" ? "pill-success" : "pill-warning"}`}
                            style={{ fontSize: "0.75rem" }}
                          >
                            {c.status?.toUpperCase() || "PUBLISHED"}
                          </span>
                        </td>
                        <td style={{ padding: "12px 16px", fontSize: "0.85rem" }}>
                          {c.tutorName || (c.tutorId ? "Assigned" : "Unassigned")}
                        </td>
                        <td style={{ padding: "12px 16px", fontSize: "0.85rem", color: "var(--text-muted)" }}>{c.duration || "Self-paced"}</td>
                        <td style={{ padding: "12px 16px", textAlign: "right" }}>
                          <div style={{ display: "inline-flex", gap: 6 }}>
                            <button
                              className="btn btn-outline btn-sm"
                              onClick={() => handleToggleCourseStatus(c)}
                            >
                              {c.status === "published" ? "Unpublish" : "Publish"}
                            </button>
                            <button
                              className="btn btn-outline btn-sm"
                              onClick={() => setEditingCourse(c)}
                            >
                              Edit
                            </button>
                            <button
                              className="btn btn-outline btn-sm"
                              style={{ color: "#DC2626" }}
                              onClick={() => handleDeleteCourse(c)}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* TAB 6: ANNOUNCEMENTS */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {activeTab === "announcements" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
              <div>
                <h2 style={{ fontSize: "1.3rem", fontWeight: 800, margin: 0 }}>Announcements Management</h2>
                <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: "4px 0 0" }}>
                  Create and manage targeted announcements that display on learner dashboards, tutor portals, or course classrooms.
                </p>
              </div>
              <button
                className="btn btn-solid-dark btn-sm"
                onClick={() => {
                  setEditingAnnouncement(null);
                  setAnnouncementForm({
                    id: null,
                    title: "",
                    body: "",
                    category: "General",
                    priority: "normal",
                    audience: "all",
                    courseId: "",
                    pinned: false,
                    status: "published",
                    expiresAt: "",
                  });
                  setShowAnnouncementModal(true);
                }}
              >
                + Create Announcement
              </button>
            </div>

            {/* Filter Tabs */}
            <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
              {["all", "published", "draft"].map((st) => (
                <button
                  key={st}
                  className={`filter-pill-btn ${announcementFilter === st ? "active" : ""}`}
                  onClick={() => setAnnouncementFilter(st)}
                >
                  {st === "all" ? "All Announcements" : st.charAt(0).toUpperCase() + st.slice(1)} (
                  {announcements.filter((a) => (st === "all" ? true : a.status === st)).length})
                </button>
              ))}
            </div>

            {/* Announcements List */}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {loadingAnnouncements ? (
                <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>Loading announcements...</div>
              ) : filteredAnnouncements.length === 0 ? (
                <div className="dashboard-card" style={{ padding: 40, textAlign: "center", background: "#FFFFFF", borderRadius: 12 }}>
                  <div style={{ fontSize: "2rem", marginBottom: 8 }}>📢</div>
                  <h3 style={{ margin: 0, fontWeight: 700 }}>No Announcements</h3>
                  <p style={{ margin: "4px 0 0", color: "var(--text-muted)", fontSize: "0.875rem" }}>
                    Create an announcement to broadcast notices to your users.
                  </p>
                </div>
              ) : (
                filteredAnnouncements.map((ann) => (
                  <div
                    key={ann.id}
                    className="dashboard-card"
                    style={{
                      padding: 20,
                      borderRadius: 12,
                      background: "#FFFFFF",
                      border: "1px solid var(--border-light)",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      flexWrap: "wrap",
                      gap: 16,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 280 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                        <span className={`pill-badge ${ann.status === "published" ? "pill-success" : "pill-warning"}`}>
                          {(ann.status || "published").toUpperCase()}
                        </span>
                        <span className="pill-badge pill-tech">AUDIENCE: {(ann.audience || "all").toUpperCase()}</span>
                        {ann.pinned && <span className="pill-badge pill-creative">📌 PINNED</span>}
                        {ann.priority === "urgent" && <span className="pill-badge pill-danger">URGENT</span>}
                        <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Posted {String(ann.date || "Recently")}</span>
                      </div>
                      <h3 style={{ margin: "0 0 6px", fontSize: "1.15rem", fontWeight: 700 }}>{ann.title}</h3>
                      <p style={{ margin: 0, fontSize: "0.875rem", color: "var(--text-secondary)", lineHeight: 1.5, whiteSpace: "pre-line" }}>
                        {ann.body}
                      </p>
                      {ann.courseId && (
                        <div style={{ marginTop: 8, fontSize: "0.8rem", color: "var(--primary-learner)", fontWeight: 600 }}>
                          Targeted Course ID: {ann.courseId}
                        </div>
                      )}
                    </div>

                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        className="btn btn-outline btn-sm"
                        onClick={() => {
                          setEditingAnnouncement(ann);
                          setAnnouncementForm({
                            id: ann.id,
                            title: ann.title || "",
                            body: ann.body || "",
                            category: ann.category || "General",
                            priority: ann.priority || "normal",
                            audience: ann.audience || "all",
                            courseId: ann.courseId || "",
                            pinned: Boolean(ann.pinned),
                            status: ann.status || "published",
                            expiresAt: ann.expiresAt || "",
                          });
                          setShowAnnouncementModal(true);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="btn btn-outline btn-sm"
                        style={{ color: "#DC2626" }}
                        onClick={() => handleDeleteAnnouncement(ann)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* TAB 7: NOTIFICATIONS */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {activeTab === "notifications" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
              <div>
                <h2 style={{ fontSize: "1.3rem", fontWeight: 800, margin: 0 }}>Notification Dispatch Center</h2>
                <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: "4px 0 0" }}>
                  Broadcast targeted in-app notifications directly to students, instructors, or individual accounts.
                </p>
              </div>
              <button className="btn btn-solid-dark btn-sm" onClick={() => setShowSendNotifModal(true)}>
                + Send In-App Notification
              </button>
            </div>

            <div className="dashboard-card" style={{ padding: 24, borderRadius: 12, border: "1px solid var(--border-light)", background: "#FFFFFF", marginBottom: 24 }}>
              <h3 style={{ margin: "0 0 12px", fontSize: "1.1rem", fontWeight: 700 }}>Dispatch Guidelines</h3>
              <ul style={{ margin: 0, paddingLeft: 20, fontSize: "0.875rem", color: "var(--text-secondary)", lineHeight: 1.6 }}>
                <li>Notifications sent here are written to the target user's Firestore <code>notifications</code> subcollection.</li>
                <li>Learners and Instructors will see a badge update in their top navigation bell menu in real time.</li>
                <li>Mass broadcasts are executed safely in batches through trusted Cloud Functions to prevent client timeouts.</li>
              </ul>
            </div>

            {/* Notification Dispatch History */}
            <div className="dashboard-card" style={{ padding: 24, borderRadius: 12, border: "1px solid var(--border-light)", background: "#FFFFFF" }}>
              <h3 style={{ margin: "0 0 16px", fontSize: "1.1rem", fontWeight: 700 }}>Notification Dispatch History</h3>
              {auditLogs.filter((l) => l.action === "Notification Dispatched").length === 0 ? (
                <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)", fontStyle: "italic" }}>
                  No recent notification dispatch records found in audit logs.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {auditLogs
                    .filter((l) => l.action === "Notification Dispatched")
                    .map((log) => (
                      <div
                        key={log.id}
                        style={{
                          padding: "12px 16px",
                          borderRadius: 8,
                          background: "var(--bg-main)",
                          border: "1px solid var(--border-light)",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 12,
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{String(log.detail || "")}</div>
                          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                            Target: {typeof log.target === "string" ? log.target : "All"}
                          </div>
                        </div>
                        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                          {typeof log.timestamp === "string" ? log.timestamp : formatFirestoreDate(log.timestamp, "Recent", true)}
                        </span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* TAB 8: RESOURCES */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {activeTab === "resources" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
              <div>
                <h2 style={{ fontSize: "1.3rem", fontWeight: 800, margin: 0 }}>Platform &amp; Course Resources</h2>
                <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: "4px 0 0" }}>
                  Upload downloadable materials, PDF guides, cheatsheets, and templates using Cloud Storage &amp; Firestore.
                </p>
              </div>
              <button className="btn btn-solid-dark btn-sm" onClick={() => setShowAddResourceModal(true)}>
                + Upload Resource
              </button>
            </div>

            {/* Filter Bar */}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
              {["all", "platform", "Tech & Digital Skills", "Professional Skills", "Creative & Design"].map((cat) => (
                <button
                  key={cat}
                  className={`filter-pill-btn ${resourceFilter === cat ? "active" : ""}`}
                  onClick={() => setResourceFilter(cat)}
                >
                  {cat === "all" ? "All Resources" : cat}
                </button>
              ))}
            </div>

            {/* Resources List */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
              {loadingResources ? (
                <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>Loading resources...</div>
              ) : adminResources.length === 0 ? (
                <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>No resources found.</div>
              ) : (
                adminResources
                  .filter((r) => {
                    if (resourceFilter === "all") return true;
                    if (resourceFilter === "platform") return r.courseId === "platform";
                    return r.category === resourceFilter;
                  })
                  .map((r) => (
                    <div
                      key={r.id}
                      className="dashboard-card"
                      style={{ padding: 18, borderRadius: 12, border: "1px solid var(--border-light)", background: "#FFFFFF", display: "flex", flexDirection: "column", justifyContent: "space-between" }}
                    >
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                          <span className="pill-badge pill-tech" style={{ fontSize: "0.75rem" }}>{r.type || "Resource"}</span>
                          <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{r.fileSize}</span>
                        </div>
                        <h4 style={{ margin: "0 0 6px", fontSize: "1rem", fontWeight: 700 }}>{r.title}</h4>
                        <p style={{ margin: "0 0 12px", fontSize: "0.85rem", color: "var(--text-secondary)", lineHeight: 1.4 }}>
                          {r.desc}
                        </p>
                      </div>

                      <div style={{ borderTop: "1px solid var(--border-light)", paddingTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Course: {r.courseId || "Platform"}</span>
                        <div style={{ display: "flex", gap: 6 }}>
                          {r.fileUrl && (
                            <a
                              href={r.fileUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="btn btn-outline btn-sm"
                              style={{ textDecoration: "none" }}
                            >
                              Download
                            </a>
                          )}
                          {!r.isDefault && (
                            <button
                              className="btn btn-outline btn-sm"
                              style={{ color: "#DC2626" }}
                              onClick={() => handleDeleteResourceItem(r)}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
              )}
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* TAB 9: ANALYTICS */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {activeTab === "analytics" && (
          <div>
            <div style={{ marginBottom: 20 }}>
              <h2 style={{ fontSize: "1.3rem", fontWeight: 800, margin: 0 }}>Platform Analytics &amp; Metrics</h2>
              <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: "4px 0 0" }}>
                Real data aggregations calculated across users, courses, and tutor application workflows.
              </p>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginBottom: 28 }}>
              <div className="dashboard-card" style={{ padding: 20, borderRadius: 12, border: "1px solid var(--border-light)", background: "#FFFFFF" }}>
                <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>
                  Learner Demographics
                </div>
                <div style={{ fontSize: "1.8rem", fontWeight: 900, margin: "8px 0 4px" }}>
                  {usersList.filter((u) => u.studentType === "corper").length} Corpers
                </div>
                <div style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                  vs {usersList.filter((u) => u.studentType !== "corper" && u.role !== "admin").length} Non-Corpers
                </div>
              </div>

              <div className="dashboard-card" style={{ padding: 20, borderRadius: 12, border: "1px solid var(--border-light)", background: "#FFFFFF" }}>
                <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>
                  Application Approval Rate
                </div>
                <div style={{ fontSize: "1.8rem", fontWeight: 900, margin: "8px 0 4px" }}>
                  {applications.length > 0
                    ? `${Math.round((applications.filter((a) => a.status === "approved").length / applications.length) * 100)}%`
                    : "100%"}
                </div>
                <div style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                  {applications.filter((a) => a.status === "approved").length} approved of {applications.length} total
                </div>
              </div>

              <div className="dashboard-card" style={{ padding: 20, borderRadius: 12, border: "1px solid var(--border-light)", background: "#FFFFFF" }}>
                <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>
                  Active vs Suspended Accounts
                </div>
                <div style={{ fontSize: "1.8rem", fontWeight: 900, margin: "8px 0 4px", color: "#16A34A" }}>
                  {usersList.filter((u) => u.status === "active").length} Active
                </div>
                <div style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                  {usersList.filter((u) => u.status === "suspended").length} currently suspended
                </div>
              </div>
            </div>

            {/* Course Distribution Table */}
            <div className="dashboard-card" style={{ padding: 24, borderRadius: 12, border: "1px solid var(--border-light)", background: "#FFFFFF" }}>
              <h3 style={{ margin: "0 0 16px", fontSize: "1.1rem", fontWeight: 700 }}>Course Catalog Distribution</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {adminCourses.map((c) => (
                  <div
                    key={c.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "10px 14px",
                      borderRadius: 8,
                      background: "var(--bg-main)",
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{c.title}</div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Category: {c.category || "General"}</div>
                    </div>
                    <span className={`pill-badge ${c.status === "published" ? "pill-success" : "pill-warning"}`}>
                      {c.status?.toUpperCase() || "PUBLISHED"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* TAB 10: AUDIT LOGS */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {activeTab === "audit" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
              <div>
                <h2 style={{ fontSize: "1.3rem", fontWeight: 800, margin: 0 }}>System Audit Logs</h2>
                <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: "4px 0 0" }}>
                  Immutable audit records automatically recorded by Cloud Functions and administrative operations.
                </p>
              </div>
            </div>

            {/* Filter Bar */}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 20 }}>
              <input
                type="text"
                placeholder="Search audit records by detail or admin UID..."
                className="form-field-input"
                style={{ maxWidth: 320 }}
                value={auditSearch}
                onChange={(e) => setAuditSearch(e.target.value)}
              />

              <select
                className="form-field-input"
                style={{ width: "auto" }}
                value={auditFilter}
                onChange={(e) => setAuditFilter(e.target.value)}
              >
                <option value="all">All Action Types</option>
                {distinctAuditActions.map((act) => (
                  <option key={act} value={act}>
                    {act}
                  </option>
                ))}
              </select>

              <div style={{ marginLeft: "auto", fontSize: "0.85rem", color: "var(--text-muted)" }}>
                Showing {filteredAuditLogs.length} audit event(s)
              </div>
            </div>

            {/* Audit Logs Table */}
            <div className="admin-table-container" style={{ background: "#FFFFFF", borderRadius: 12, border: "1px solid var(--border-light)", overflowX: "auto" }}>
              <table className="admin-table" style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border-light)", background: "var(--bg-main)" }}>
                    <th style={{ padding: "12px 16px", fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)" }}>ACTION</th>
                    <th style={{ padding: "12px 16px", fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)" }}>EVENT DETAIL</th>
                    <th style={{ padding: "12px 16px", fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)" }}>ADMIN / CALLER</th>
                    <th style={{ padding: "12px 16px", fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)" }}>TIMESTAMP</th>
                    <th style={{ padding: "12px 16px", fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)", textAlign: "right" }}>PAYLOAD</th>
                  </tr>
                </thead>
                <tbody>
                  {loadingLogs ? (
                    <tr>
                      <td colSpan={5} style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>
                        Loading audit logs from Firestore...
                      </td>
                    </tr>
                  ) : filteredAuditLogs.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>
                        No audit records match the current filter.
                      </td>
                    </tr>
                  ) : (
                    filteredAuditLogs.map((log) => (
                      <tr key={log.id} style={{ borderBottom: "1px solid var(--border-light)" }}>
                        <td style={{ padding: "12px 16px" }}>
                          <span className={`pill-badge ${log.badge || "pill-tech"}`} style={{ fontSize: "0.75rem" }}>
                            {String(log.action || "System Event")}
                          </span>
                        </td>
                        <td style={{ padding: "12px 16px", fontSize: "0.85rem", color: "var(--text-primary)" }}>{String(log.detail || "")}</td>
                        <td style={{ padding: "12px 16px", fontSize: "0.8rem", color: "var(--text-muted)", fontFamily: "monospace" }}>
                          {typeof log.adminUid === "string" && log.adminUid
                            ? log.adminUid.slice(0, 8) + "…"
                            : typeof log.approvedBy === "string" && log.approvedBy
                            ? log.approvedBy.slice(0, 8) + "…"
                            : typeof log.uid === "string" && log.uid
                            ? log.uid.slice(0, 8) + "…"
                            : "system"}
                        </td>
                        <td style={{ padding: "12px 16px", fontSize: "0.8rem", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                          {typeof log.timestamp === "string" ? log.timestamp : formatFirestoreDate(log.timestamp, "Recent", true)}
                        </td>
                        <td style={{ padding: "12px 16px", textAlign: "right" }}>
                          <button
                            className="btn btn-outline btn-sm"
                            onClick={() => setSelectedAuditLog(log)}
                          >
                            Inspect
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* TAB 11: PLATFORM SETTINGS */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {activeTab === "settings" && (
          <div>
            <div style={{ marginBottom: 20 }}>
              <h2 style={{ fontSize: "1.3rem", fontWeight: 800, margin: 0 }}>Platform Configuration</h2>
              <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: "4px 0 0" }}>
                Manage system-wide parameters, maintenance toggles, and public support contact information.
              </p>
            </div>

            <div className="dashboard-card" style={{ padding: 28, borderRadius: 12, border: "1px solid var(--border-light)", background: "#FFFFFF", maxWidth: 680 }}>
              <form onSubmit={handleSaveSettings}>
                <div className="form-field-group" style={{ marginBottom: 16 }}>
                  <label className="form-field-label">Platform Name</label>
                  <input
                    type="text"
                    className="form-field-input"
                    value={platformSettings.platformName}
                    onChange={(e) => setPlatformSettings({ ...platformSettings, platformName: e.target.value })}
                    required
                  />
                </div>

                <div className="form-field-group" style={{ marginBottom: 16 }}>
                  <label className="form-field-label">Academic Support Email</label>
                  <input
                    type="email"
                    className="form-field-input"
                    value={platformSettings.supportEmail}
                    onChange={(e) => setPlatformSettings({ ...platformSettings, supportEmail: e.target.value })}
                    required
                  />
                </div>

                <div className="form-field-group" style={{ marginBottom: 16 }}>
                  <label className="form-field-label">Top Banner Announcement Message</label>
                  <input
                    type="text"
                    className="form-field-input"
                    value={platformSettings.bannerMessage}
                    onChange={(e) => setPlatformSettings({ ...platformSettings, bannerMessage: e.target.value })}
                  />
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 12, margin: "20px 0" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: "0.9rem" }}>
                    <input
                      type="checkbox"
                      checked={platformSettings.openRegistrations}
                      onChange={(e) => setPlatformSettings({ ...platformSettings, openRegistrations: e.target.checked })}
                    />
                    <span>Open Public Learner Registrations</span>
                  </label>

                  <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: "0.9rem" }}>
                    <input
                      type="checkbox"
                      checked={platformSettings.allowTutorApplications}
                      onChange={(e) => setPlatformSettings({ ...platformSettings, allowTutorApplications: e.target.checked })}
                    />
                    <span>Accept New Instructor Applications</span>
                  </label>

                  <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: "0.9rem" }}>
                    <input
                      type="checkbox"
                      checked={platformSettings.maintenanceMode}
                      onChange={(e) => setPlatformSettings({ ...platformSettings, maintenanceMode: e.target.checked })}
                    />
                    <span style={{ color: platformSettings.maintenanceMode ? "#DC2626" : "inherit" }}>
                      Maintenance Mode (Admins Only)
                    </span>
                  </label>
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button type="submit" disabled={savingSettings} className="btn btn-solid-dark">
                    {savingSettings ? "Saving Settings..." : "Save Platform Settings"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* MODAL 1: LEARNER PROFILE DRAWER / MODAL */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {selectedLearner && (
          <div className="modal-backdrop-overlay" onClick={() => setSelectedLearner(null)}>
            <div className="modal-dialog-box" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span className={`pill-badge ${selectedLearner.status === "suspended" ? "pill-danger" : "pill-success"}`}>
                      {selectedLearner.status?.toUpperCase() || "ACTIVE"}
                    </span>
                    <span className="pill-badge pill-tech">{selectedLearner.type}</span>
                  </div>
                  <h3 style={{ margin: 0, fontSize: "1.3rem", fontWeight: 800 }}>{selectedLearner.name}</h3>
                  <div style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>Reg Code: {selectedLearner.regId}</div>
                </div>
                <button className="btn btn-outline btn-sm" onClick={() => setSelectedLearner(null)}>✕</button>
              </div>

              {/* Personal & Contact Information */}
              <div style={{ background: "var(--bg-main)", padding: 14, borderRadius: 8, marginBottom: 18, fontSize: "0.875rem" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div><strong>Email:</strong> {selectedLearner.email}</div>
                  <div><strong>Phone:</strong> {selectedLearner.phone}</div>
                  <div><strong>NYSC Code:</strong> {selectedLearner.nyscCode || "N/A"}</div>
                  <div><strong>Joined:</strong> {selectedLearner.date}</div>
                </div>
                {selectedLearner.bio && (
                  <div style={{ marginTop: 8 }}>
                    <strong>Bio:</strong> {selectedLearner.bio}
                  </div>
                )}
                {selectedLearner.suspensionReason && (
                  <div style={{ marginTop: 8, color: "#DC2626", fontWeight: 600 }}>
                    ⚠️ Suspension Reason: {selectedLearner.suspensionReason}
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => {
                    setEditLearnerForm({
                      targetUid: selectedLearner.id,
                      fullName: selectedLearner.fullName || selectedLearner.name,
                      phoneNumber: selectedLearner.phoneNumber || selectedLearner.phone || "",
                      bio: selectedLearner.bio || "",
                      studentType: selectedLearner.studentType || "non_corper",
                      nyscStateCode: selectedLearner.nyscStateCode || selectedLearner.nyscCode || "",
                    });
                    setShowEditLearnerModal(true);
                  }}
                >
                  Edit Profile
                </button>

                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => setShowManualEnrollModal(true)}
                >
                  + Manually Enroll in Course
                </button>

                {selectedLearner.status === "suspended" ? (
                  <button
                    className="btn btn-outline btn-sm"
                    style={{ color: "#16A34A" }}
                    onClick={() => handleReactivateLearner(selectedLearner)}
                  >
                    Reactivate Account
                  </button>
                ) : (
                  <button
                    className="btn btn-outline btn-sm"
                    style={{ color: "#DC2626" }}
                    onClick={() => {
                      setSuspendTargetUser(selectedLearner);
                      setShowSuspendModal(true);
                    }}
                  >
                    Suspend Account
                  </button>
                )}
              </div>

              {/* Enrolled Courses & Progress */}
              <div>
                <h4 style={{ margin: "0 0 10px", fontSize: "1rem", fontWeight: 700 }}>
                  Course Enrollments ({learnerEnrollments.length})
                </h4>
                {loadingLearnerEnrollments ? (
                  <div style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>Loading course records...</div>
                ) : learnerEnrollments.length === 0 ? (
                  <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", fontStyle: "italic" }}>
                    No active enrollments for this learner.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {learnerEnrollments.map((enr) => (
                      <div
                        key={enr.id}
                        style={{
                          padding: "10px 14px",
                          borderRadius: 8,
                          background: "#FFFFFF",
                          border: "1px solid var(--border-light)",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>
                            {enr.courseTitle || enr.courseId}
                          </div>
                          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                            Progress: {enr.progressPercent || 0}% • Status: {enr.status || "active"}
                          </div>
                        </div>
                        <button
                          className="btn btn-outline btn-sm"
                          style={{ color: "#DC2626" }}
                          onClick={() => handleRevokeEnrollment(enr)}
                        >
                          Revoke
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* MODAL 2: EDIT LEARNER MODAL */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {showEditLearnerModal && (
          <div className="modal-backdrop-overlay" onClick={() => setShowEditLearnerModal(false)}>
            <div className="modal-dialog-box" style={{ maxWidth: 500 }} onClick={(e) => e.stopPropagation()}>
              <h3 style={{ margin: "0 0 16px", fontSize: "1.2rem", fontWeight: 800 }}>Edit Learner Profile</h3>
              <form onSubmit={handleSaveLearnerProfile}>
                <div className="form-field-group" style={{ marginBottom: 12 }}>
                  <label className="form-field-label">Full Name</label>
                  <input
                    type="text"
                    className="form-field-input"
                    value={editLearnerForm.fullName}
                    onChange={(e) => setEditLearnerForm({ ...editLearnerForm, fullName: e.target.value })}
                    required
                  />
                </div>

                <div className="form-field-group" style={{ marginBottom: 12 }}>
                  <label className="form-field-label">Phone Number</label>
                  <input
                    type="text"
                    className="form-field-input"
                    value={editLearnerForm.phoneNumber}
                    onChange={(e) => setEditLearnerForm({ ...editLearnerForm, phoneNumber: e.target.value })}
                  />
                </div>

                <div className="form-field-group" style={{ marginBottom: 12 }}>
                  <label className="form-field-label">Student Type</label>
                  <select
                    className="form-field-input"
                    value={editLearnerForm.studentType}
                    onChange={(e) => setEditLearnerForm({ ...editLearnerForm, studentType: e.target.value })}
                  >
                    <option value="non_corper">Standard (Non-Corper)</option>
                    <option value="corper">NYSC Corper</option>
                  </select>
                </div>

                {editLearnerForm.studentType === "corper" && (
                  <div className="form-field-group" style={{ marginBottom: 12 }}>
                    <label className="form-field-label">NYSC State Code</label>
                    <input
                      type="text"
                      className="form-field-input"
                      value={editLearnerForm.nyscStateCode}
                      onChange={(e) => setEditLearnerForm({ ...editLearnerForm, nyscStateCode: e.target.value })}
                      placeholder="e.g. AB/24A/1234"
                    />
                  </div>
                )}

                <div className="form-field-group" style={{ marginBottom: 16 }}>
                  <label className="form-field-label">Bio / Notes</label>
                  <textarea
                    rows={3}
                    className="form-field-input"
                    value={editLearnerForm.bio}
                    onChange={(e) => setEditLearnerForm({ ...editLearnerForm, bio: e.target.value })}
                  />
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                  <button type="button" className="btn btn-outline" onClick={() => setShowEditLearnerModal(false)}>
                    Cancel
                  </button>
                  <button type="submit" disabled={isProcessing} className="btn btn-solid-dark">
                    Save Changes
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* MODAL 3: SUSPEND ACCOUNT REASON MODAL */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {showSuspendModal && (
          <div className="modal-backdrop-overlay" onClick={() => setShowSuspendModal(false)}>
            <div className="modal-dialog-box" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
              <h3 style={{ margin: "0 0 10px", fontSize: "1.2rem", fontWeight: 800, color: "#DC2626" }}>
                Suspend Account Access
              </h3>
              <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", margin: "0 0 16px" }}>
                Suspending will disable authentication for <strong>{suspendTargetUser?.name}</strong> and immediately revoke active sessions.
              </p>
              <form onSubmit={handleConfirmSuspend}>
                <div className="form-field-group" style={{ marginBottom: 16 }}>
                  <label className="form-field-label">Reason for Suspension *</label>
                  <textarea
                    rows={3}
                    required
                    className="form-field-input"
                    placeholder="Document the administrative reason for this suspension..."
                    value={suspendReasonText}
                    onChange={(e) => setSuspendReasonText(e.target.value)}
                  />
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                  <button type="button" className="btn btn-outline" onClick={() => setShowSuspendModal(false)}>
                    Cancel
                  </button>
                  <button type="submit" disabled={isProcessing} className="btn btn-solid-dark" style={{ background: "#DC2626" }}>
                    Confirm Suspension
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* MODAL 4: MANUAL COURSE ENROLLMENT MODAL */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {showManualEnrollModal && (
          <div className="modal-backdrop-overlay" onClick={() => setShowManualEnrollModal(false)}>
            <div className="modal-dialog-box" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
              <h3 style={{ margin: "0 0 10px", fontSize: "1.2rem", fontWeight: 800 }}>
                Grant Course Enrollment
              </h3>
              <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", margin: "0 0 16px" }}>
                Select an eligible course to grant official approved access to <strong>{selectedLearner?.name}</strong>.
              </p>
              <form onSubmit={handleManualEnrollLearner}>
                <div className="form-field-group" style={{ marginBottom: 16 }}>
                  <label className="form-field-label">Select Course *</label>
                  <select
                    className="form-field-input"
                    required
                    value={enrollTargetCourseId}
                    onChange={(e) => setEnrollTargetCourseId(e.target.value)}
                  >
                    <option value="">-- Choose Course --</option>
                    {adminCourses.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                  </select>
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                  <button type="button" className="btn btn-outline" onClick={() => setShowManualEnrollModal(false)}>
                    Cancel
                  </button>
                  <button type="submit" disabled={isProcessing || !enrollTargetCourseId} className="btn btn-solid-dark">
                    Grant Enrollment
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* MODAL 5: ASSIGN COURSE TO TUTOR MODAL */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {showCourseAssignModal && (
          <div className="modal-backdrop-overlay" onClick={() => setShowCourseAssignModal(false)}>
            <div className="modal-dialog-box" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
              <h3 style={{ margin: "0 0 10px", fontSize: "1.2rem", fontWeight: 800 }}>
                Assign Course to Instructor
              </h3>
              <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", margin: "0 0 16px" }}>
                Assigning a course allows <strong>{selectedTutor?.name}</strong> to manage lessons, resources, and student submissions for that course.
              </p>
              <form onSubmit={handleAssignCourseToTutor}>
                <div className="form-field-group" style={{ marginBottom: 16 }}>
                  <label className="form-field-label">Select Course to Assign *</label>
                  <select
                    className="form-field-input"
                    required
                    value={assignCourseSelectId}
                    onChange={(e) => setAssignCourseSelectId(e.target.value)}
                  >
                    <option value="">-- Choose Course --</option>
                    {adminCourses.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                  </select>
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                  <button type="button" className="btn btn-outline" onClick={() => setShowCourseAssignModal(false)}>
                    Cancel
                  </button>
                  <button type="submit" disabled={isProcessing || !assignCourseSelectId} className="btn btn-solid-dark">
                    Assign Course
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* MODAL 6: APPLICATION DETAIL REVIEW MODAL */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {selectedAppModal && (
          <div className="modal-backdrop-overlay" onClick={() => setSelectedAppModal(null)}>
            <div className="modal-dialog-box" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                <div>
                  <span
                    className={`pill-badge ${
                      selectedAppModal.status === "approved"
                        ? "pill-success"
                        : selectedAppModal.status === "rejected"
                        ? "pill-danger"
                        : "pill-warning"
                    }`}
                  >
                    {(selectedAppModal.status || "pending").toUpperCase()}
                  </span>
                  <h3 style={{ margin: "6px 0 2px", fontSize: "1.3rem", fontWeight: 800 }}>{selectedAppModal.fullName}</h3>
                  <div style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>{selectedAppModal.email}</div>
                </div>
                <button className="btn btn-outline btn-sm" onClick={() => setSelectedAppModal(null)}>✕</button>
              </div>

              <div style={{ background: "var(--bg-main)", padding: 16, borderRadius: 8, marginBottom: 16, fontSize: "0.875rem" }}>
                <div style={{ marginBottom: 10 }}>
                  <strong>Proposed Course:</strong> {selectedAppModal.courseTitle} ({selectedAppModal.category})
                </div>
                {selectedAppModal.courseDescription && (
                  <div style={{ marginBottom: 10 }}>
                    <strong>Course Description:</strong>
                    <p style={{ margin: "4px 0 0", color: "var(--text-secondary)" }}>{selectedAppModal.courseDescription}</p>
                  </div>
                )}
                {selectedAppModal.learningOutcomes && (
                  <div style={{ marginBottom: 10 }}>
                    <strong>Learning Outcomes:</strong>
                    <p style={{ margin: "4px 0 0", color: "var(--text-secondary)" }}>{selectedAppModal.learningOutcomes}</p>
                  </div>
                )}
                {selectedAppModal.syllabus && (
                  <div>
                    <strong>Syllabus Structure:</strong>
                    <pre style={{ margin: "4px 0 0", background: "#FFFFFF", padding: 10, borderRadius: 6, fontSize: "0.8rem", whiteSpace: "pre-wrap" }}>
                      {selectedAppModal.syllabus}
                    </pre>
                  </div>
                )}
                {selectedAppModal.rejectionReason && (
                  <div style={{ marginTop: 10, color: "#DC2626" }}>
                    <strong>Rejection Reason:</strong> {selectedAppModal.rejectionReason}
                  </div>
                )}
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                {selectedAppModal.status === "pending" && (
                  <>
                    <button
                      className="btn btn-outline"
                      style={{ color: "#DC2626" }}
                      onClick={() => {
                        setRejectModalApp(selectedAppModal);
                        setRejectionReasonText("");
                      }}
                    >
                      Reject Application
                    </button>
                    <button
                      className="btn btn-solid-dark"
                      disabled={isProcessing}
                      onClick={() => handleApproveApplication(selectedAppModal)}
                    >
                      Approve &amp; Promote to Tutor
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* MODAL 7: REJECT APPLICATION REASON MODAL */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {rejectModalApp && (
          <div className="modal-backdrop-overlay" onClick={() => setRejectModalApp(null)}>
            <div className="modal-dialog-box" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
              <h3 style={{ margin: "0 0 10px", fontSize: "1.2rem", fontWeight: 800, color: "#DC2626" }}>
                Reject Instructor Application
              </h3>
              <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", margin: "0 0 16px" }}>
                Provide feedback or a reason for applicant <strong>{rejectModalApp.fullName}</strong>.
              </p>
              <form onSubmit={handleConfirmRejectApplication}>
                <div className="form-field-group" style={{ marginBottom: 16 }}>
                  <label className="form-field-label">Rejection Reason *</label>
                  <textarea
                    rows={3}
                    required
                    className="form-field-input"
                    placeholder="Enter the reason why this application was not accepted..."
                    value={rejectionReasonText}
                    onChange={(e) => setRejectionReasonText(e.target.value)}
                  />
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                  <button type="button" className="btn btn-outline" onClick={() => setRejectModalApp(null)}>
                    Cancel
                  </button>
                  <button type="submit" disabled={isProcessing} className="btn btn-solid-dark" style={{ background: "#DC2626" }}>
                    Confirm Rejection
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* MODAL 8: CREATE COURSE MODAL */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {showAddCourseModal && (
          <div className="modal-backdrop-overlay" onClick={() => setShowAddCourseModal(false)}>
            <div className="modal-dialog-box" style={{ maxWidth: 580 }} onClick={(e) => e.stopPropagation()}>
              <h3 style={{ margin: "0 0 16px", fontSize: "1.3rem", fontWeight: 800 }}>Create New Course</h3>
              <form onSubmit={handleCreateCourse}>
                <div className="form-field-group" style={{ marginBottom: 12 }}>
                  <label className="form-field-label">Course Title *</label>
                  <input
                    type="text"
                    required
                    className="form-field-input"
                    value={newCourseForm.title}
                    onChange={(e) => setNewCourseForm({ ...newCourseForm, title: e.target.value })}
                    placeholder="e.g. Applied Generative AI & Automation"
                  />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                  <div className="form-field-group">
                    <label className="form-field-label">Category</label>
                    <select
                      className="form-field-input"
                      value={newCourseForm.category}
                      onChange={(e) => setNewCourseForm({ ...newCourseForm, category: e.target.value })}
                    >
                      <option>Tech &amp; Digital Skills</option>
                      <option>Professional Skills</option>
                      <option>Creative &amp; Design</option>
                      <option>NYSC Guides</option>
                    </select>
                  </div>

                  <div className="form-field-group">
                    <label className="form-field-label">Level</label>
                    <select
                      className="form-field-input"
                      value={newCourseForm.level}
                      onChange={(e) => setNewCourseForm({ ...newCourseForm, level: e.target.value })}
                    >
                      <option>Beginner</option>
                      <option>Intermediate</option>
                      <option>Advanced</option>
                    </select>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                  <div className="form-field-group">
                    <label className="form-field-label">Duration</label>
                    <input
                      type="text"
                      className="form-field-input"
                      value={newCourseForm.duration}
                      onChange={(e) => setNewCourseForm({ ...newCourseForm, duration: e.target.value })}
                      placeholder="e.g. 8h 30m"
                    />
                  </div>

                  <div className="form-field-group">
                    <label className="form-field-label">Assign Instructor</label>
                    <select
                      className="form-field-input"
                      value={newCourseForm.tutorId}
                      onChange={(e) => setNewCourseForm({ ...newCourseForm, tutorId: e.target.value })}
                    >
                      <option value="">-- Unassigned --</option>
                      {approvedTutors.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="form-field-group" style={{ marginBottom: 12 }}>
                  <label className="form-field-label">Course Description</label>
                  <textarea
                    rows={3}
                    className="form-field-input"
                    value={newCourseForm.description}
                    onChange={(e) => setNewCourseForm({ ...newCourseForm, description: e.target.value })}
                    placeholder="Brief description of the course..."
                  />
                </div>

                <div className="form-field-group" style={{ marginBottom: 16 }}>
                  <label className="form-field-label">Thumbnail Image URL</label>
                  <input
                    type="url"
                    className="form-field-input"
                    value={newCourseForm.image}
                    onChange={(e) => setNewCourseForm({ ...newCourseForm, image: e.target.value })}
                  />
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                  <button type="button" className="btn btn-outline" onClick={() => setShowAddCourseModal(false)}>
                    Cancel
                  </button>
                  <button type="submit" disabled={isProcessing} className="btn btn-solid-dark">
                    Publish Course
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* MODAL 9: EDIT COURSE MODAL */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {editingCourse && (
          <div className="modal-backdrop-overlay" onClick={() => setEditingCourse(null)}>
            <div className="modal-dialog-box" style={{ maxWidth: 540 }} onClick={(e) => e.stopPropagation()}>
              <h3 style={{ margin: "0 0 16px", fontSize: "1.2rem", fontWeight: 800 }}>Edit Course: {editingCourse.title}</h3>
              <form onSubmit={handleSaveEditCourse}>
                <div className="form-field-group" style={{ marginBottom: 12 }}>
                  <label className="form-field-label">Course Title *</label>
                  <input
                    type="text"
                    required
                    className="form-field-input"
                    value={editingCourse.title}
                    onChange={(e) => setEditingCourse({ ...editingCourse, title: e.target.value })}
                  />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                  <div className="form-field-group">
                    <label className="form-field-label">Category</label>
                    <select
                      className="form-field-input"
                      value={editingCourse.category || "Tech & Digital Skills"}
                      onChange={(e) => setEditingCourse({ ...editingCourse, category: e.target.value })}
                    >
                      <option>Tech &amp; Digital Skills</option>
                      <option>Professional Skills</option>
                      <option>Creative &amp; Design</option>
                      <option>NYSC Guides</option>
                    </select>
                  </div>

                  <div className="form-field-group">
                    <label className="form-field-label">Status</label>
                    <select
                      className="form-field-input"
                      value={editingCourse.status || "published"}
                      onChange={(e) => setEditingCourse({ ...editingCourse, status: e.target.value })}
                    >
                      <option value="published">Published</option>
                      <option value="draft">Draft</option>
                    </select>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                  <div className="form-field-group">
                    <label className="form-field-label">Assign Instructor</label>
                    <select
                      className="form-field-input"
                      value={editingCourse.tutorId || ""}
                      onChange={(e) => setEditingCourse({ ...editingCourse, tutorId: e.target.value })}
                    >
                      <option value="">-- Unassigned --</option>
                      {approvedTutors.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="form-field-group">
                    <label className="form-field-label">Duration</label>
                    <input
                      type="text"
                      className="form-field-input"
                      value={editingCourse.duration || ""}
                      onChange={(e) => setEditingCourse({ ...editingCourse, duration: e.target.value })}
                    />
                  </div>
                </div>

                <div className="form-field-group" style={{ marginBottom: 16 }}>
                  <label className="form-field-label">Description</label>
                  <textarea
                    rows={3}
                    className="form-field-input"
                    value={editingCourse.description || ""}
                    onChange={(e) => setEditingCourse({ ...editingCourse, description: e.target.value })}
                  />
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                  <button type="button" className="btn btn-outline" onClick={() => setEditingCourse(null)}>
                    Cancel
                  </button>
                  <button type="submit" disabled={isProcessing} className="btn btn-solid-dark">
                    Save Changes
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* MODAL 10: CREATE / EDIT ANNOUNCEMENT MODAL */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {showAnnouncementModal && (
          <div className="modal-backdrop-overlay" onClick={() => setShowAnnouncementModal(false)}>
            <div className="modal-dialog-box" style={{ maxWidth: 540 }} onClick={(e) => e.stopPropagation()}>
              <h3 style={{ margin: "0 0 16px", fontSize: "1.2rem", fontWeight: 800 }}>
                {editingAnnouncement ? "Edit Announcement" : "Create New Announcement"}
              </h3>
              <form onSubmit={handleSaveAnnouncement}>
                <div className="form-field-group" style={{ marginBottom: 12 }}>
                  <label className="form-field-label">Announcement Title *</label>
                  <input
                    type="text"
                    required
                    className="form-field-input"
                    placeholder="e.g. Scheduled Live Q&A Session This Friday"
                    value={announcementForm.title}
                    onChange={(e) => setAnnouncementForm({ ...announcementForm, title: e.target.value })}
                  />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                  <div className="form-field-group">
                    <label className="form-field-label">Target Audience</label>
                    <select
                      className="form-field-input"
                      value={announcementForm.audience}
                      onChange={(e) => setAnnouncementForm({ ...announcementForm, audience: e.target.value })}
                    >
                      <option value="all">All Platform Users</option>
                      <option value="learners">Learners Only</option>
                      <option value="tutors">Instructors Only</option>
                      <option value="course">Specific Course Enrollees</option>
                    </select>
                  </div>

                  <div className="form-field-group">
                    <label className="form-field-label">Priority</label>
                    <select
                      className="form-field-input"
                      value={announcementForm.priority}
                      onChange={(e) => setAnnouncementForm({ ...announcementForm, priority: e.target.value })}
                    >
                      <option value="normal">Normal</option>
                      <option value="high">High</option>
                      <option value="urgent">Urgent Alert</option>
                    </select>
                  </div>
                </div>

                {announcementForm.audience === "course" && (
                  <div className="form-field-group" style={{ marginBottom: 12 }}>
                    <label className="form-field-label">Target Course *</label>
                    <select
                      className="form-field-input"
                      required
                      value={announcementForm.courseId}
                      onChange={(e) => setAnnouncementForm({ ...announcementForm, courseId: e.target.value })}
                    >
                      <option value="">-- Choose Course --</option>
                      {adminCourses.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="form-field-group" style={{ marginBottom: 12 }}>
                  <label className="form-field-label">Announcement Message Body *</label>
                  <textarea
                    rows={4}
                    required
                    className="form-field-input"
                    placeholder="Write announcement body..."
                    value={announcementForm.body}
                    onChange={(e) => setAnnouncementForm({ ...announcementForm, body: e.target.value })}
                  />
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: "0.875rem" }}>
                    <input
                      type="checkbox"
                      checked={announcementForm.pinned}
                      onChange={(e) => setAnnouncementForm({ ...announcementForm, pinned: e.target.checked })}
                    />
                    <span>Pin Announcement to Top</span>
                  </label>

                  <select
                    className="form-field-input"
                    style={{ width: "auto" }}
                    value={announcementForm.status}
                    onChange={(e) => setAnnouncementForm({ ...announcementForm, status: e.target.value })}
                  >
                    <option value="published">Publish Immediately</option>
                    <option value="draft">Save as Draft</option>
                  </select>
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                  <button type="button" className="btn btn-outline" onClick={() => setShowAnnouncementModal(false)}>
                    Cancel
                  </button>
                  <button type="submit" disabled={isProcessing} className="btn btn-solid-dark">
                    Publish Announcement
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* MODAL 11: SEND NOTIFICATION MODAL */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {showSendNotifModal && (
          <div className="modal-backdrop-overlay" onClick={() => setShowSendNotifModal(false)}>
            <div className="modal-dialog-box" style={{ maxWidth: 500 }} onClick={(e) => e.stopPropagation()}>
              <h3 style={{ margin: "0 0 16px", fontSize: "1.2rem", fontWeight: 800 }}>Dispatch In-App Notification</h3>
              <form onSubmit={handleSendNotification}>
                <div className="form-field-group" style={{ marginBottom: 12 }}>
                  <label className="form-field-label">Target Audience *</label>
                  <select
                    className="form-field-input"
                    value={notifForm.target}
                    onChange={(e) => setNotifForm({ ...notifForm, target: e.target.value })}
                  >
                    <option value="all_learners">All Registered Learners</option>
                    <option value="all_tutors">All Approved Instructors</option>
                    <option value="course">Students in Specific Course</option>
                    <option value="single_user">Single User (by UID)</option>
                  </select>
                </div>

                {notifForm.target === "course" && (
                  <div className="form-field-group" style={{ marginBottom: 12 }}>
                    <label className="form-field-label">Target Course *</label>
                    <select
                      className="form-field-input"
                      required
                      value={notifForm.targetId}
                      onChange={(e) => setNotifForm({ ...notifForm, targetId: e.target.value, courseId: e.target.value })}
                    >
                      <option value="">-- Choose Course --</option>
                      {adminCourses.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {notifForm.target === "single_user" && (
                  <div className="form-field-group" style={{ marginBottom: 12 }}>
                    <label className="form-field-label">Recipient User UID *</label>
                    <input
                      type="text"
                      required
                      className="form-field-input"
                      placeholder="Paste target user UID..."
                      value={notifForm.targetId}
                      onChange={(e) => setNotifForm({ ...notifForm, targetId: e.target.value })}
                    />
                  </div>
                )}

                <div className="form-field-group" style={{ marginBottom: 12 }}>
                  <label className="form-field-label">Notification Title *</label>
                  <input
                    type="text"
                    required
                    className="form-field-input"
                    placeholder="e.g. New Learning Material Available"
                    value={notifForm.title}
                    onChange={(e) => setNotifForm({ ...notifForm, title: e.target.value })}
                  />
                </div>

                <div className="form-field-group" style={{ marginBottom: 16 }}>
                  <label className="form-field-label">Notification Body *</label>
                  <textarea
                    rows={3}
                    required
                    className="form-field-input"
                    placeholder="Enter message content..."
                    value={notifForm.body}
                    onChange={(e) => setNotifForm({ ...notifForm, body: e.target.value })}
                  />
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                  <button type="button" className="btn btn-outline" onClick={() => setShowSendNotifModal(false)}>
                    Cancel
                  </button>
                  <button type="submit" disabled={isProcessing} className="btn btn-solid-dark">
                    Dispatch Now
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* MODAL 12: UPLOAD RESOURCE MODAL */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {showAddResourceModal && (
          <div className="modal-backdrop-overlay" onClick={() => setShowAddResourceModal(false)}>
            <div className="modal-dialog-box" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
              <h3 style={{ margin: "0 0 16px", fontSize: "1.2rem", fontWeight: 800 }}>Upload Resource</h3>
              <form onSubmit={handleUploadResource}>
                <div className="form-field-group" style={{ marginBottom: 12 }}>
                  <label className="form-field-label">Resource Title *</label>
                  <input
                    type="text"
                    required
                    className="form-field-input"
                    placeholder="e.g. 2025 AI Cheatsheet & Prompts"
                    value={newResourceForm.title}
                    onChange={(e) => setNewResourceForm({ ...newResourceForm, title: e.target.value })}
                  />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                  <div className="form-field-group">
                    <label className="form-field-label">Target Audience / Course</label>
                    <select
                      className="form-field-input"
                      value={newResourceForm.courseId}
                      onChange={(e) => setNewResourceForm({ ...newResourceForm, courseId: e.target.value })}
                    >
                      <option value="platform">Platform-Wide (All)</option>
                      {adminCourses.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="form-field-group">
                    <label className="form-field-label">Category</label>
                    <select
                      className="form-field-input"
                      value={newResourceForm.category}
                      onChange={(e) => setNewResourceForm({ ...newResourceForm, category: e.target.value })}
                    >
                      <option>Tech &amp; Digital Skills</option>
                      <option>Professional Skills</option>
                      <option>Creative &amp; Design</option>
                      <option>NYSC Guides</option>
                    </select>
                  </div>
                </div>

                <div className="form-field-group" style={{ marginBottom: 12 }}>
                  <label className="form-field-label">Upload File (PDF, ZIP, DOC, PNG)</label>
                  <input
                    type="file"
                    style={{ fontSize: "0.85rem", width: "100%", marginTop: 4 }}
                    onChange={(e) => setNewResourceForm({ ...newResourceForm, file: e.target.files[0] || null })}
                  />
                </div>

                <div className="form-field-group" style={{ marginBottom: 16 }}>
                  <label className="form-field-label">Or External URL (Google Drive, Figma, GitHub)</label>
                  <input
                    type="url"
                    className="form-field-input"
                    placeholder="https://..."
                    value={newResourceForm.externalUrl}
                    onChange={(e) => setNewResourceForm({ ...newResourceForm, externalUrl: e.target.value })}
                  />
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                  <button type="button" className="btn btn-outline" onClick={() => setShowAddResourceModal(false)}>
                    Cancel
                  </button>
                  <button type="submit" disabled={isProcessing} className="btn btn-solid-dark">
                    Publish Resource
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* MODAL 13: INSPECT AUDIT LOG MODAL */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {selectedAuditLog && (
          <div className="modal-backdrop-overlay" onClick={() => setSelectedAuditLog(null)}>
            <div className="modal-dialog-box" style={{ maxWidth: 540 }} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
                <div>
                  <span className={`pill-badge ${selectedAuditLog.badge || "pill-tech"}`}>
                    {String(selectedAuditLog.action || "System Event")}
                  </span>
                  <h3 style={{ margin: "6px 0 2px", fontSize: "1.15rem", fontWeight: 800 }}>Audit Event Record</h3>
                  <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                    {typeof selectedAuditLog.timestamp === "string"
                      ? selectedAuditLog.timestamp
                      : formatFirestoreDate(selectedAuditLog.timestamp, "Recent", true)}
                  </div>
                </div>
                <button className="btn btn-outline btn-sm" onClick={() => setSelectedAuditLog(null)}>✕</button>
              </div>

              <div style={{ marginBottom: 14, fontSize: "0.9rem" }}>
                <strong>Event Summary:</strong>
                <p style={{ margin: "4px 0 0", color: "var(--text-primary)" }}>{String(selectedAuditLog.detail || "")}</p>
              </div>

              <div style={{ marginBottom: 16 }}>
                <strong>Full Audit Payload (JSON):</strong>
                <pre
                  style={{
                    margin: "6px 0 0",
                    background: "var(--bg-main)",
                    padding: 12,
                    borderRadius: 8,
                    fontSize: "0.75rem",
                    maxHeight: 240,
                    overflowY: "auto",
                    border: "1px solid var(--border-light)",
                  }}
                >
                  {JSON.stringify(selectedAuditLog, null, 2)}
                </pre>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button className="btn btn-outline" onClick={() => setSelectedAuditLog(null)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
        </ErrorBoundary>
      </div>
    </div>
  );
}
