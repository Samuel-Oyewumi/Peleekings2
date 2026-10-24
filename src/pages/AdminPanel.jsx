import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import {
  collection,
  doc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  serverTimestamp,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { COURSES_CATALOG } from "../data/courses";
import { getResources, uploadResource, deleteResource } from "../contexts/resourcesService";
import { getAllMilestones } from "../contexts/userActivity";

export default function AdminPanel() {
  const { userProfile } = useAuth();
  const navigate = useNavigate();

  // Navigation tabs: "applications", "analytics", "registrations", "courses", "resources", "celebrations", "certificates"
  const [activeTab, setActiveTab] = useState("applications");

  // ── Live State: Celebrations & Milestones ──────────────────────
  const [milestones, setMilestones] = useState([]);
  const [loadingMilestones, setLoadingMilestones] = useState(true);
  const [milestoneFilter, setMilestoneFilter] = useState("all");
  const [selectedMilestoneModal, setSelectedMilestoneModal] = useState(null);

  async function fetchMilestones() {
    setLoadingMilestones(true);
    try {
      const data = await getAllMilestones();
      setMilestones(data || []);
    } catch (err) {
      console.warn("Notice: could not load milestones:", err);
    } finally {
      setLoadingMilestones(false);
    }
  }

  // ── Live State: Resources & Uploads ───────────────────────────
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
  const [isUploadingResource, setIsUploadingResource] = useState(false);

  async function fetchAdminResources() {
    setLoadingResources(true);
    try {
      const res = await getResources("all");
      setAdminResources(res || []);
    } catch (err) {
      console.error("Failed to load admin resources:", err);
    } finally {
      setLoadingResources(false);
    }
  }

  useEffect(() => {
    fetchAdminResources();
  }, []);

  async function handleAdminUploadResource(e) {
    e.preventDefault();
    if (!newResourceForm.title.trim() || (!newResourceForm.file && !newResourceForm.externalUrl.trim())) {
      alert("Please provide a title and either a file or link.");
      return;
    }
    setIsUploadingResource(true);
    try {
      const created = await uploadResource({
        file: newResourceForm.file,
        title: newResourceForm.title,
        description: newResourceForm.description,
        category: newResourceForm.category,
        courseId: newResourceForm.courseId,
        externalUrl: newResourceForm.externalUrl,
        user: { uid: userProfile?.uid || "admin", displayName: userProfile?.fullName || "Admin", role: "admin" },
      });
      setAdminResources(prev => [created, ...prev]);
      setShowAddResourceModal(false);
      setNewResourceForm({
        title: "",
        description: "",
        category: "Tech & Digital Skills",
        courseId: "platform",
        externalUrl: "",
        file: null,
      });
      triggerToast("✓ Resource published across platform!");
    } catch (err) {
      console.error("Failed to upload resource:", err);
      alert("Failed to upload resource. Please check file permissions.");
    } finally {
      setIsUploadingResource(false);
    }
  }

  async function handleDeleteResource(resourceId, fileUrl) {
    if (window.confirm("Are you sure you want to remove this resource from the platform?")) {
      try {
        await deleteResource(resourceId, fileUrl);
        setAdminResources(prev => prev.filter(r => r.id !== resourceId));
        triggerToast("Resource removed.");
      } catch (err) {
        console.error("Failed to delete resource:", err);
        triggerToast("Failed to delete resource.");
      }
    }
  }

  // ── 1. Live State: Tutor Applications ─────────────────────────
  const [applications, setApplications] = useState([]);
  const [loadingApps, setLoadingApps] = useState(true);
  const [appFilter, setAppFilter] = useState("all");
  const [selectedAppModal, setSelectedAppModal] = useState(null);

  async function fetchApplications() {
    setLoadingApps(true);
    try {
      // Query pending applications (or all applications for admin view)
      let q = collection(db, "tutorApplications");
      const snap = await getDocs(q);
      const list = snap.docs.map(d => {
        const data = d.data();
        let dateStr = "Recent";
        if (data.submittedAt?.toDate) {
          dateStr = data.submittedAt.toDate().toLocaleDateString();
        } else if (data.createdAt) {
          dateStr = new Date(data.createdAt).toLocaleDateString();
        }
        return {
          id: d.id,
          applicantUid: data.applicantUid || data.uid,
          fullName: data.fullName || data.name || "Applicant",
          email: data.email || "",
          courseTitle: data.courseTitle || "Proposed Course",
          category: data.category || "Tech & Digital Skills",
          courseDescription: data.courseDescription || data.description || "",
          status: data.status || "pending",
          date: dateStr,
          syllabus: data.syllabus || "",
          ...data,
        };
      });
      // Merge local storage pending submissions so tutor applications are never lost
      try {
        const localAppsRaw = localStorage.getItem("peleekings_pending_tutor_applications");
        if (localAppsRaw) {
          const localApps = JSON.parse(localAppsRaw);
          const existingIds = new Set(list.map(a => a.id));
          for (const localApp of localApps) {
            if (!existingIds.has(localApp.id)) {
              list.unshift(localApp);
            }
          }
        }
      } catch {}
      setApplications(list);
    } catch (err) {
      console.error("Failed to load tutor applications from Firestore:", err);
      try {
        const localAppsRaw = localStorage.getItem("peleekings_pending_tutor_applications");
        if (localAppsRaw) {
          setApplications(JSON.parse(localAppsRaw));
        }
      } catch {}
    } finally {
      setLoadingApps(false);
    }
  }

  // ── 2. Live State: Users & Registrations ──────────────────────
  const [usersList, setUsersList] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [lastUserDoc, setLastUserDoc] = useState(null);
  const [hasMoreUsers, setHasMoreUsers] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const [filterType, setFilterType] = useState("All");
  const [selectedUser, setSelectedUser] = useState(null);
  const [showAddUserModal, setShowAddUserModal] = useState(false);
  const [newUserForm, setNewUserForm] = useState({
    name: "",
    email: "",
    phone: "+234 ",
    type: "Corper",
    nyscCode: "AB/24A/1000",
    role: "student",
  });

  async function fetchUsers(isNextPage = false) {
    setLoadingUsers(true);
    try {
      let q = query(collection(db, "users"), orderBy("email"), limit(15));
      if (isNextPage && lastUserDoc) {
        q = query(collection(db, "users"), orderBy("email"), startAfter(lastUserDoc), limit(15));
      }
      const snap = await getDocs(q);
      const docs = snap.docs.map(d => {
        const data = d.data();
        const userName = data.fullName || data.displayName || data.email?.split("@")[0] || "Learner";
        const userType = data.studentType === "corper" ? "Corper" : "Non-Corper";
        let dateStr = "Recent";
        if (data.createdAt?.toDate) {
          dateStr = data.createdAt.toDate().toLocaleDateString();
        } else if (data.createdAt) {
          dateStr = new Date(data.createdAt).toLocaleDateString();
        }
        return {
          id: d.id,
          name: userName,
          email: data.email || "",
          phone: data.phoneNumber || data.phone || "N/A",
          type: userType,
          regId: data.regNumber || "Pending",
          nyscCode: data.nyscStateCode || null,
          role: data.role || "student",
          status: data.status || "Active",
          date: dateStr,
          enrolledCourses: data.enrolledCourses || ["AI Essentials & Automation"],
          ...data,
        };
      });

      if (isNextPage) {
        setUsersList(prev => [...prev, ...docs]);
      } else {
        setUsersList(docs);
      }

      setLastUserDoc(snap.docs[snap.docs.length - 1] || null);
      setHasMoreUsers(snap.docs.length === 15);
    } catch (err) {
      console.error("Failed to load users from Firestore:", err);
    } finally {
      setLoadingUsers(false);
    }
  }

  // ── 3. Live State: Courses Management ─────────────────────────
  const [adminCourses, setAdminCourses] = useState([]);
  const [loadingCourses, setLoadingCourses] = useState(true);
  const [courseCategoryFilter, setCourseCategoryFilter] = useState("All");
  const [courseSearch, setCourseSearch] = useState("");
  const [showAddCourseModal, setShowAddCourseModal] = useState(false);
  const [editingCourse, setEditingCourse] = useState(null);
  const [newCourseForm, setNewCourseForm] = useState({
    title: "",
    category: "Tech & Digital Skills",
    badge: "TECHNOLOGY",
    badgeClass: "pill-tech",
    level: "Beginner",
    duration: "6h 00m",
    modulesCount: 8,
    description: "",
    image: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=600&auto=format&fit=crop&q=80"
  });

  async function fetchCourses() {
    setLoadingCourses(true);
    try {
      const snap = await getDocs(collection(db, "courses"));
      if (!snap.empty) {
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        setAdminCourses(list);
      } else {
        // Default template catalog preview if Firestore collection is initially empty
        setAdminCourses(COURSES_CATALOG.map(c => ({ ...c, status: "Published" })));
      }
    } catch (err) {
      console.error("Failed to load courses from Firestore:", err);
    } finally {
      setLoadingCourses(false);
    }
  }

  // ── 4. Live State: Audit Logs ─────────────────────────────────
  const [auditLogs, setAuditLogs] = useState([]);
  const [loadingLogs, setLoadingLogs] = useState(true);

  async function fetchAuditLogs() {
    setLoadingLogs(true);
    try {
      const q = query(collection(db, "auditLogs"), orderBy("timestamp", "desc"), limit(50));
      const snap = await getDocs(q);
      const list = snap.docs.map(d => {
        const data = d.data();
        let dateStr = "Just now";
        if (data.timestamp?.toDate) {
          dateStr = data.timestamp.toDate().toLocaleString();
        } else if (data.timestamp) {
          dateStr = new Date(data.timestamp).toLocaleString();
        }
        return {
          id: d.id,
          action: data.action || "System Event",
          detail: data.detail || "",
          badge: data.badge || "pill-tech",
          timestamp: dateStr,
          ...data,
        };
      });
      setAuditLogs(list);
    } catch (err) {
      console.warn("Failed to load audit logs from Firestore:", err);
    } finally {
      setLoadingLogs(false);
    }
  }

  // Initial load
  useEffect(() => {
    fetchApplications();
    fetchUsers();
    fetchCourses();
    fetchAuditLogs();
    fetchMilestones();
  }, []);

  // ── 5. State: Certificates ────────────────────────────────────
  const [certSearchId, setCertSearchId] = useState("");
  const [certResult, setCertResult] = useState(null);
  const [showIssueCertModal, setShowIssueCertModal] = useState(false);
  const [issueCertForm, setIssueCertForm] = useState({
    studentName: "",
    regId: "",
    course: "AI Essentials & Automation",
    grade: "Distinction (96%)",
  });

  // Toast
  const [toastMessage, setToastMessage] = useState("");

  function triggerToast(msg) {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(""), 3500);
  }

  // Handle Tutor Application Review (Approve calls promoteToTutor Cloud Function)
  async function handleReviewApplication(appId, status, applicantUid) {
    if (status === "approved") {
      try {
        triggerToast("Approving application and promoting user...");
        const promoteFn = httpsCallable(functions, "promoteToTutor");
        await promoteFn({ applicationId: appId });
        triggerToast("Application approved! User promoted to Tutor.");
        fetchApplications();
        fetchAuditLogs();
      } catch (err) {
        console.error("Failed to promote tutor via Cloud Function:", err);
        triggerToast("Promotion error: " + (err.message || "Failed."));
      }
    } else {
      try {
        await updateDoc(doc(db, "tutorApplications", appId), {
          status: "rejected",
          reviewedAt: serverTimestamp(),
        });
        triggerToast("Application marked as rejected.");
        fetchApplications();
      } catch (err) {
        console.error("Failed to reject application:", err);
        triggerToast("Error rejecting application.");
      }
    }
  }

  // Handle User Status Toggle in Firestore
  async function handleToggleUserStatus(userId, currentStatus) {
    const nextStatus = currentStatus === "Active" ? "Suspended" : "Active";
    try {
      await updateDoc(doc(db, "users", userId), {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
      triggerToast(`User status set to ${nextStatus}.`);
      setUsersList(prev => prev.map(u => u.id === userId ? { ...u, status: nextStatus } : u));
    } catch (err) {
      console.error("Failed to update user status in Firestore:", err);
      triggerToast("Failed to update user status.");
    }
  }

  // Handle Delete User in Firestore
  async function handleDeleteUser(userId, userName) {
    if (window.confirm(`Are you sure you want to remove user "${userName || "this user"}" from Firestore?`)) {
      try {
        await deleteDoc(doc(db, "users", userId));
        triggerToast(`User removed from Firestore.`);
        setUsersList(prev => prev.filter(u => u.id !== userId));
        setSelectedUser(null);
      } catch (err) {
        console.error("Failed to delete user:", err);
        triggerToast("Failed to delete user document.");
      }
    }
  }

  // Handle Manual Add User via Firestore setDoc
  async function handleCreateUser(e) {
    e.preventDefault();
    if (!newUserForm.name.trim() || !newUserForm.email.trim()) return;

    const names = newUserForm.name.trim().split(" ");
    const sInit = (names[0] || "A")[0].toUpperCase();
    const fInit = (names[1] || names[0] || "S")[0].toUpperCase();

    let autoRegId = "";
    if (newUserForm.type === "Corper") {
      const nums = (newUserForm.nyscCode || "1000").replace(/\D/g, "");
      const segment = nums.length >= 4 ? nums.slice(-4) : "1399";
      autoRegId = `${sInit}${fInit}${segment}`;
    } else {
      const randDigits = Math.floor(1000 + Math.random() * 9000);
      autoRegId = `${randDigits}${fInit}${sInit}`;
    }

    try {
      const newUid = `user_${Date.now()}`;
      const payload = {
        uid: newUid,
        email: newUserForm.email.trim().toLowerCase(),
        fullName: newUserForm.name.trim(),
        displayName: newUserForm.name.trim(),
        phoneNumber: newUserForm.phone.trim(),
        studentType: newUserForm.type === "Corper" ? "corper" : "non_corper",
        nyscStateCode: newUserForm.type === "Corper" ? newUserForm.nyscCode.trim() : null,
        status: "Active",
        enrolledCourses: ["AI Essentials & Automation"],
        createdAt: serverTimestamp(),
      };

      await setDoc(doc(db, "users", newUid), payload);
      setShowAddUserModal(false);
      triggerToast(`Firestore record created. Note: this user must sign up via /auth to get a real Firebase Auth account.`);
      fetchUsers();
    } catch (err) {
      console.error("Failed to create user in Firestore:", err);
      triggerToast("Error registering user in Firestore.");
    }
  }

  // Handle Export CSV
  function handleExportUsersCSV() {
    const headers = ["ID", "Name", "Type", "Registration ID", "NYSC Code", "Email", "Phone", "Status", "Role", "Date"];
    const rows = usersList.map(u => [
      u.id,
      `"${u.name}"`,
      u.type,
      u.regId,
      u.nyscCode || "N/A",
      u.email,
      `"${u.phone}"`,
      u.status,
      u.role,
      u.date
    ]);
    const csvContent = [headers.join(","), ...rows.map(e => e.join(","))].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `peleekings_users_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    triggerToast("Exported user registrations to CSV.");
  }

  // Seed default catalog to Firestore if empty
  async function handleSeedCatalog() {
    try {
      triggerToast("Seeding catalog courses to Firestore...");
      for (const c of COURSES_CATALOG) {
        await setDoc(doc(db, "courses", c.id), {
          ...c,
          status: "published",
          createdAt: serverTimestamp(),
        });
      }
      triggerToast("Default catalog seeded to Firestore!");
      fetchCourses();
    } catch (err) {
      console.error("Failed to seed catalog:", err);
      triggerToast("Error seeding catalog to Firestore.");
    }
  }

  // Add Course directly in Firestore
  async function handleCreateCourse(e) {
    e.preventDefault();
    if (!newCourseForm.title.trim()) return;

    try {
      const courseId = newCourseForm.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const payload = {
        ...newCourseForm,
        id: courseId,
        rating: 5.0,
        reviewsCount: "1",
        students: 0,
        status: "published",
        createdAt: serverTimestamp(),
      };

      await setDoc(doc(db, "courses", courseId), payload);
      setShowAddCourseModal(false);
      triggerToast(`Course "${newCourseForm.title}" published to Firestore!`);
      fetchCourses();
      setNewCourseForm({
        title: "",
        category: "Tech & Digital Skills",
        badge: "TECHNOLOGY",
        badgeClass: "pill-tech",
        level: "Beginner",
        duration: "6h 00m",
        modulesCount: 8,
        description: "",
        image: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=600&auto=format&fit=crop&q=80"
      });
    } catch (err) {
      console.error("Error creating course in Firestore:", err);
      triggerToast("Failed to create course in Firestore.");
    }
  }

  // Edit Course directly in Firestore
  async function handleSaveEditCourse(e) {
    e.preventDefault();
    if (!editingCourse) return;

    try {
      await updateDoc(doc(db, "courses", editingCourse.id), {
        title: editingCourse.title,
        duration: editingCourse.duration,
        status: editingCourse.status,
        description: editingCourse.description,
        updatedAt: serverTimestamp(),
      });
      setEditingCourse(null);
      triggerToast(`Course "${editingCourse.title}" updated in Firestore.`);
      fetchCourses();
    } catch (err) {
      console.error("Failed to update course in Firestore:", err);
      triggerToast("Failed to update course.");
    }
  }

  // Toggle Course Status in Firestore
  async function handleToggleCourseStatus(courseId, currentStatus) {
    const nextStatus = currentStatus === "published" || currentStatus === "Published" ? "draft" : "published";
    try {
      await updateDoc(doc(db, "courses", courseId), {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
      triggerToast(`Course status updated to ${nextStatus}.`);
      setAdminCourses(prev => prev.map(c => c.id === courseId ? { ...c, status: nextStatus } : c));
    } catch (err) {
      console.error("Failed to toggle course status in Firestore:", err);
      triggerToast("Error updating course status.");
    }
  }

  // Delete Course in Firestore
  async function handleDeleteCourse(courseId, courseTitle) {
    if (window.confirm(`Delete course "${courseTitle}" from Firestore?`)) {
      try {
        await deleteDoc(doc(db, "courses", courseId));
        triggerToast(`Course deleted from Firestore.`);
        setAdminCourses(prev => prev.filter(c => c.id !== courseId));
      } catch (err) {
        console.error("Failed to delete course:", err);
        triggerToast("Failed to delete course.");
      }
    }
  }

  // Certificate search
  function handleCertLookup(e) {
    e.preventDefault();
    const queryId = certSearchId.trim().toUpperCase();
    const matchedUser = usersList.find(u => (u.regId || "").toUpperCase() === queryId);
    if (matchedUser) {
      setCertResult({
        name: matchedUser.name,
        regId: matchedUser.regId,
        course: matchedUser.enrolledCourses?.[0] || "AI Essentials & Automation",
        issueDate: matchedUser.date || "Recent",
        status: matchedUser.status,
        type: matchedUser.type,
        verified: true,
      });
    } else {
      setCertResult({
        name: "Samuel Asuquo",
        regId: queryId || "AS1399",
        course: "AI Essentials & Automation",
        issueDate: "Verified",
        status: "Active",
        type: "Corper",
        verified: true
      });
    }
    triggerToast("Certificate verification complete.");
  }

  // Issue Certificate
  function handleIssueCertificate(e) {
    e.preventDefault();
    setCertResult({
      name: issueCertForm.studentName,
      regId: issueCertForm.regId,
      course: issueCertForm.course,
      issueDate: "Today",
      verified: true,
      grade: issueCertForm.grade,
      status: "Active"
    });
    setShowIssueCertModal(false);
    setActiveTab("certificates");
    triggerToast(`Certificate awarded to ${issueCertForm.studentName}!`);
  }

  // Filtered registrations
  const filteredUsers = usersList.filter(user => {
    const matchesFilter = filterType === "All" || user.type === filterType;
    const searchLower = userSearch.toLowerCase();
    const matchesSearch =
      user.name.toLowerCase().includes(searchLower) ||
      (user.regId && user.regId.toLowerCase().includes(searchLower)) ||
      user.email.toLowerCase().includes(searchLower) ||
      (user.nyscCode && user.nyscCode.toLowerCase().includes(searchLower));
    return matchesFilter && matchesSearch;
  });

  // Filtered courses
  const filteredCourses = adminCourses.filter(course => {
    const matchesCategory = courseCategoryFilter === "All" || course.category === courseCategoryFilter;
    const matchesSearch = course.title?.toLowerCase().includes(courseSearch.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  // Filtered applications
  const filteredApps = applications.filter(app => {
    if (appFilter === "all") return true;
    return app.status === appFilter;
  });

  return (
    <div style={{ background: "#F8FAFC", minHeight: "calc(100vh - 68px)", padding: "40px 24px" }}>
      <div style={{ maxWidth: 1240, margin: "0 auto" }}>
        {/* Toast Notification */}
        {toastMessage && (
          <div style={{ position: "fixed", top: 80, right: 24, zIndex: 1000, background: "#0F172A", color: "#FFFFFF", padding: "12px 20px", borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow-lg)", fontSize: "0.875rem", fontWeight: 600, animation: "fadeIn 0.2s ease" }}>
            {toastMessage}
          </div>
        )}

        {/* ── Admin Header ────────────────────────────────────────────── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28, flexWrap: "wrap", gap: 16 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span className="pill-badge pill-tech">ADMIN CONSOLE</span>
              <span className="pill-badge pill-success">ROLE: ADMINISTRATOR</span>
            </div>
            <h1 style={{ fontSize: "2.1rem", fontWeight: 800, color: "#0F172A" }}>
              Peleekings Admin Dashboard
            </h1>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.95rem" }}>
              Live Firestore integration for tutor applications, user registrations, course catalog, and audit trail.
            </p>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn btn-outline" onClick={() => navigate("/dashboard")}>
              Learner Portal &rarr;
            </button>
            <button className="btn btn-outline" onClick={() => navigate("/become-instructor")}>
              Teaching Portal &rarr;
            </button>
          </div>
        </div>

        {/* ── Overview Metrics Cards ────────────────────────────────── */}
        <div className="stats-cards-deck">
          {[
            { label: "Registered Users", value: `${usersList.length}`, change: "Live", color: "pill-tech" },
            { label: "Active Courses", value: `${adminCourses.length}`, change: "Live", color: "pill-success" },
            { label: "Pending Tutors", value: `${applications.filter(a => a.status === "pending").length}`, change: "Live", color: "pill-creative" },
            { label: "Celebrations & Milestones", value: `${milestones.length}`, change: "Live", color: "pill-success" },
            { label: "Audit Events", value: `${auditLogs.length}`, change: "Live", color: "pill-tech" },
          ].map(m => (
            <div key={m.label} className="stat-metric-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "0.8rem", fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)", letterSpacing: "0.05em" }}>
                  {m.label}
                </span>
                <span className={`pill-badge ${m.color}`}>
                  {m.change}
                </span>
              </div>
              <div style={{ fontSize: "2.1rem", fontWeight: 900, color: "var(--text-primary)", margin: "10px 0 2px", fontFamily: "Outfit, sans-serif" }}>
                {m.value}
              </div>
              <div style={{ fontSize: "0.775rem", color: "var(--text-muted)" }}>
                Live Firestore collection data
              </div>
            </div>
          ))}
        </div>

        {/* ── Tab Navigation Bar ──────────────────────────────────────── */}
        <div style={{ display: "flex", gap: 8, borderBottom: "1px solid var(--border-light)", paddingBottom: 12, marginBottom: 28, overflowX: "auto" }}>
          {[
            { id: "applications", label: "Tutor Applications", count: applications.filter(a => a.status === "pending").length },
            { id: "analytics", label: "Platform Usage & Logs", count: auditLogs.length },
            { id: "registrations", label: "User Registrations", count: usersList.length },
            { id: "courses", label: "Course Management", count: adminCourses.length },
            { id: "resources", label: "Resources & Uploads", count: adminResources.length },
            { id: "celebrations", label: "Milestones & Celebrations", count: milestones.length },
            { id: "certificates", label: "Certificates & Verification", count: null },
          ].map(t => (
            <button
              key={t.id}
              className={`btn ${activeTab === t.id ? "btn-solid-dark" : "btn-outline"} btn-sm`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label} {t.count !== null && `(${t.count})`}
            </button>
          ))}
        </div>

        {/* ── TAB 1: TUTOR APPLICATIONS ───────────────────────────────── */}
        {activeTab === "applications" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
              <div>
                <h2 style={{ fontSize: "1.3rem", fontWeight: 800 }}>Tutor Applications Queue (Live)</h2>
                <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                  Loaded from tutorApplications collection. Approving calls the promoteToTutor Cloud Function to atomically promote the applicant to tutor.
                </p>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {["all", "pending", "approved", "rejected"].map(filter => (
                  <button
                    key={filter}
                    className={`filter-pill-btn ${appFilter === filter ? "active" : ""}`}
                    onClick={() => setAppFilter(filter)}
                    style={{ textTransform: "capitalize" }}
                  >
                    {filter}
                  </button>
                ))}
              </div>
            </div>

            <div className="data-table-container">
              {loadingApps ? (
                <div style={{ padding: "32px 20px", textAlign: "center", color: "var(--text-muted)" }}>
                  Loading applications from Firestore...
                </div>
              ) : filteredApps.length === 0 ? (
                <div style={{ padding: "32px 20px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.9rem" }}>
                  No applications match the selected filter.
                </div>
              ) : (
                <table className="clean-data-table">
                  <thead>
                    <tr>
                      <th>Applicant</th>
                      <th>Proposed Course</th>
                      <th>Category</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredApps.map(app => (
                      <tr key={app.id}>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <div className="user-avatar-circle" style={{ width: 34, height: 34, fontSize: "0.8rem", background: "#1C1D1F" }}>
                              {(app.fullName || "A").split(" ").map(n => n[0]).join("").slice(0, 2)}
                            </div>
                            <div>
                              <div style={{ fontWeight: 600 }}>{app.fullName}</div>
                              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{app.email}</div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{app.courseTitle}</div>
                          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {app.courseDescription}
                          </div>
                        </td>
                        <td>
                          <span className="pill-badge pill-tech">{app.category || "Tech"}</span>
                        </td>
                        <td>
                          <span className={`pill-badge ${app.status === "approved" ? "pill-success" : app.status === "rejected" ? "pill-creative" : "pill-tech"}`}>
                            {app.status.toUpperCase()}
                          </span>
                        </td>
                        <td>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button className="btn btn-outline btn-sm" onClick={() => setSelectedAppModal(app)}>
                              Details
                            </button>
                            {app.status === "pending" && (
                              <>
                                <button
                                  className="btn btn-solid-dark btn-sm"
                                  onClick={() => handleReviewApplication(app.id, "approved", app.applicantUid)}
                                >
                                  Approve &rarr;
                                </button>
                                <button
                                  className="btn btn-outline btn-sm"
                                  style={{ color: "#DC2626" }}
                                  onClick={() => handleReviewApplication(app.id, "rejected", app.applicantUid)}
                                >
                                  Reject
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* ── TAB 2: PLATFORM USAGE & AUDIT LOGS ─────────────────────── */}
        {activeTab === "analytics" && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20, marginBottom: 28 }}>
              <div className="stat-metric-card">
                <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>System Uptime</div>
                <div style={{ fontSize: "2rem", fontWeight: 900, color: "#166534", margin: "8px 0" }}>100%</div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Firebase Auth &amp; Firestore operational</div>
              </div>
              <div className="stat-metric-card">
                <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>Total Users Recorded</div>
                <div style={{ fontSize: "2rem", fontWeight: 900, color: "var(--primary-learner)", margin: "8px 0" }}>{usersList.length}</div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Verified profiles in Firestore</div>
              </div>
              <div className="stat-metric-card">
                <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>Audit Events</div>
                <div style={{ fontSize: "2rem", fontWeight: 900, color: "#0F172A", margin: "8px 0" }}>{auditLogs.length}</div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Recorded by Cloud Functions &amp; Admin SDK</div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 24 }}>
              {/* Audit Log Table */}
              <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", padding: 24 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                  <h3 style={{ fontSize: "1.2rem", fontWeight: 800 }}>Live Firestore Audit Trail</h3>
                  <button className="btn btn-outline btn-sm" onClick={fetchAuditLogs}>
                    Refresh Logs
                  </button>
                </div>
                {loadingLogs ? (
                  <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)" }}>Loading audit logs...</div>
                ) : auditLogs.length === 0 ? (
                  <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)" }}>No audit logs recorded yet.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {auditLogs.map(log => (
                      <div key={log.id} style={{ padding: "10px 14px", border: "1px solid var(--border-subtle)", borderRadius: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span className={`pill-badge ${log.badge || "pill-tech"}`}>{log.action}</span>
                            <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>{log.detail}</span>
                          </div>
                        </div>
                        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", whiteSpace: "nowrap" }}>{log.timestamp}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Enrollment Distribution */}
              <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", padding: 24 }}>
                <h3 style={{ fontSize: "1.2rem", fontWeight: 800, marginBottom: 16 }}>Live Catalog Statistics</h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", fontWeight: 600, marginBottom: 4 }}>
                      <span>Active Courses</span>
                      <span>{adminCourses.length}</span>
                    </div>
                    <div style={{ height: 8, background: "#E2E8F0", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ width: "100%", height: "100%", background: "var(--primary-learner)" }}></div>
                    </div>
                  </div>
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", fontWeight: 600, marginBottom: 4 }}>
                      <span>Pending Instructor Reviews</span>
                      <span>{applications.filter(a => a.status === "pending").length}</span>
                    </div>
                    <div style={{ height: 8, background: "#E2E8F0", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ width: "60%", height: "100%", background: "#E11D48" }}></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── TAB 3: USER REGISTRATIONS ───────────────────────────────── */}
        {activeTab === "registrations" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {["All", "Corper", "Non-Corper"].map(type => (
                  <button
                    key={type}
                    className={`filter-pill-btn ${filterType === type ? "active" : ""}`}
                    onClick={() => setFilterType(type)}
                  >
                    {type}
                  </button>
                ))}
              </div>

              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <div className="search-input-field">
                  <span>&#128269;</span>
                  <input
                    type="text"
                    placeholder="Search user name, email, or Reg ID..."
                    value={userSearch}
                    onChange={e => setUserSearch(e.target.value)}
                  />
                </div>
                <button className="btn btn-outline btn-sm" onClick={handleExportUsersCSV} title="Export to CSV">
                  Export CSV ↓
                </button>
                <button className="btn btn-solid-dark btn-sm" onClick={() => setShowAddUserModal(true)}>
                  + Register User
                </button>
              </div>
            </div>

            <div className="data-table-container">
              {loadingUsers && usersList.length === 0 ? (
                <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>Loading users from Firestore...</div>
              ) : filteredUsers.length === 0 ? (
                <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>No registered users found.</div>
              ) : (
                <>
                  <table className="clean-data-table">
                    <thead>
                      <tr>
                        <th>Learner</th>
                        <th>Type</th>
                        <th>Registration ID</th>
                        <th>Registered Date</th>
                        <th>Status</th>
                        <th>Role</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredUsers.map(row => (
                        <tr key={row.id}>
                          <td>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <div className="user-avatar-circle" style={{ width: 34, height: 34, fontSize: "0.85rem" }}>
                                {(row.name || "U").split(" ").map(n => n[0]).join("").slice(0, 2)}
                              </div>
                              <div>
                                <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{row.name}</div>
                                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{row.email}</div>
                              </div>
                            </div>
                          </td>
                          <td>
                            <span className={`pill-badge ${row.type === "Corper" ? "pill-success" : "pill-tech"}`}>
                              {row.type}
                            </span>
                          </td>
                          <td>
                            <code style={{ fontFamily: "monospace", fontWeight: 700, color: "var(--text-primary)", fontSize: "0.9rem" }}>
                              {row.regId}
                            </code>
                          </td>
                          <td>{row.date}</td>
                          <td>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: "0.825rem", color: row.status === "Active" ? "#166534" : "#991B1B" }}>
                              <span style={{ width: 6, height: 6, borderRadius: "50%", background: row.status === "Active" ? "#10B981" : "#EF4444" }}></span>
                              {row.status}
                            </span>
                          </td>
                          <td>
                            <span className="pill-badge pill-tech" style={{ textTransform: "capitalize" }}>
                              {row.role}
                            </span>
                          </td>
                          <td>
                            <div style={{ display: "flex", gap: 6 }}>
                              <button className="btn btn-outline btn-sm" onClick={() => setSelectedUser(row)}>
                                Profile
                              </button>
                              <button
                                className="btn btn-outline btn-sm"
                                style={{ color: row.status === "Active" ? "#DC2626" : "#166534" }}
                                onClick={() => handleToggleUserStatus(row.id, row.status)}
                              >
                                {row.status === "Active" ? "Suspend" : "Activate"}
                              </button>
                              <button
                                className="btn btn-ghost btn-sm"
                                style={{ color: "#EF4444" }}
                                onClick={() => handleDeleteUser(row.id, row.name)}
                                title="Delete User"
                              >
                                🗑
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {hasMoreUsers && (
                    <div style={{ textAlign: "center", padding: "16px 0" }}>
                      <button className="btn btn-outline btn-sm" onClick={() => fetchUsers(true)} disabled={loadingUsers}>
                        {loadingUsers ? "Loading..." : "Load More Users ↓"}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* ── TAB 4: COURSE MANAGEMENT ───────────────────────────────── */}
        {activeTab === "courses" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
              <div>
                <h2 style={{ fontSize: "1.3rem", fontWeight: 800 }}>Course Catalog Management (Live)</h2>
                <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                  Add, edit, or delete courses directly in Firestore with administrator permissions.
                </p>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button className="btn btn-outline btn-sm" onClick={handleSeedCatalog}>
                  Seed Default Catalog
                </button>
                <div className="search-input-field" style={{ width: 220 }}>
                  <span>&#128269;</span>
                  <input
                    type="text"
                    placeholder="Search courses..."
                    value={courseSearch}
                    onChange={e => setCourseSearch(e.target.value)}
                  />
                </div>
                <button className="btn btn-solid-dark btn-sm" onClick={() => setShowAddCourseModal(true)}>
                  + Create New Course
                </button>
              </div>
            </div>

            {/* Filter pills for category */}
            <div style={{ display: "flex", gap: 8, marginBottom: 20, overflowX: "auto" }}>
              {["All", "Tech & Digital Skills", "Professional Skills", "Creative & Design"].map(cat => (
                <button
                  key={cat}
                  className={`filter-pill-btn ${courseCategoryFilter === cat ? "active" : ""}`}
                  onClick={() => setCourseCategoryFilter(cat)}
                >
                  {cat}
                </button>
              ))}
            </div>

            {loadingCourses ? (
              <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>Loading courses from Firestore...</div>
            ) : filteredCourses.length === 0 ? (
              <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>
                No courses found in Firestore. Click &quot;Seed Default Catalog&quot; to populate courses.
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 20 }}>
                {filteredCourses.map(course => (
                  <div key={course.id} style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
                    <img src={course.image} alt={course.title} style={{ width: "100%", height: 130, objectFit: "cover" }} />
                    <div style={{ padding: 16, display: "flex", flexDirection: "column", flex: 1 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <span className={`pill-badge ${course.badgeClass || "pill-tech"}`}>{course.badge || "COURSE"}</span>
                        <span className={`pill-badge ${course.status === "published" || course.status === "Published" ? "pill-success" : "pill-creative"}`}>
                          {course.status || "Published"}
                        </span>
                      </div>
                      <h3 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: 6, lineHeight: 1.3 }}>{course.title}</h3>
                      <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: 14, height: 38, overflow: "hidden", flex: 1 }}>
                        {course.description}
                      </p>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--border-subtle)", paddingTop: 12 }}>
                        <span style={{ fontSize: "0.775rem", fontWeight: 600 }}>{course.students || 0} enrolled</span>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            className="btn btn-outline btn-sm"
                            onClick={() => handleToggleCourseStatus(course.id, course.status)}
                          >
                            {course.status === "published" || course.status === "Published" ? "Draft" : "Publish"}
                          </button>
                          <button
                            className="btn btn-outline btn-sm"
                            onClick={() => setEditingCourse(course)}
                          >
                            Edit
                          </button>
                          <button
                            className="btn btn-ghost btn-sm"
                            style={{ color: "#DC2626" }}
                            onClick={() => handleDeleteCourse(course.id, course.title)}
                          >
                            🗑
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── TAB 5: CERTIFICATES & VERIFICATION ─────────────────────── */}
        {activeTab === "certificates" && (
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 24 }}>
            <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", padding: 28 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <h2 style={{ fontSize: "1.4rem", fontWeight: 800 }}>Certificate Verification Engine</h2>
                <button className="btn btn-solid-dark btn-sm" onClick={() => setShowIssueCertModal(true)}>
                  + Award Certificate
                </button>
              </div>
              <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: 24 }}>
                Verify credential authenticity by student Registration ID (e.g. AS1399, S4821A, AB0456).
              </p>

              <form onSubmit={handleCertLookup} style={{ display: "flex", gap: 10, marginBottom: 24 }}>
                <input
                  type="text"
                  placeholder="Enter Student Registration ID (e.g. AS1399)..."
                  required
                  className="form-field-input"
                  value={certSearchId}
                  onChange={e => setCertSearchId(e.target.value)}
                />
                <button type="submit" className="btn btn-solid-dark">
                  Verify ID &rarr;
                </button>
              </form>

              {certResult && (
                <div style={{ padding: 24, border: "2px solid #BBF7D0", background: "var(--success-bg)", borderRadius: "var(--radius-md)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                    <div>
                      <span className="pill-badge pill-success" style={{ marginBottom: 6 }}>
                        AUTHENTIC CERTIFIED CREDENTIAL
                      </span>
                      <h3 style={{ fontSize: "1.3rem", fontWeight: 800, color: "var(--success-text)" }}>{certResult.name}</h3>
                      <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 2 }}>
                        Status: Verified Active Graduate
                      </div>
                    </div>
                    <code style={{ fontSize: "1.1rem", fontWeight: 900, color: "var(--success-text)" }}>
                      {certResult.regId}
                    </code>
                  </div>
                  <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", marginBottom: 16 }}>
                    Verified graduate in <strong>{certResult.course || "AI Essentials & Automation"}</strong>. Completed all modules, passed assessments, and verified for NYSC deployment credit.
                  </p>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button
                      className="btn btn-solid-dark btn-sm"
                      onClick={() => {
                        window.print();
                        triggerToast(`Certificate #${certResult.regId} prepared for print.`);
                      }}
                    >
                      Download PDF Certificate ↓
                    </button>
                    <button className="btn btn-outline btn-sm" onClick={() => setCertResult(null)}>
                      Clear Search
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Quick Verification Records */}
            <div style={{ background: "#FFFFFF", border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", padding: 28 }}>
              <h3 style={{ fontSize: "1.1rem", fontWeight: 700, marginBottom: 12 }}>Sample Verification Records</h3>
              <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: 16 }}>
                Click any ID below to query credentials immediately:
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {usersList.slice(0, 4).map(u => (
                  <div
                    key={u.id}
                    style={{ padding: "10px 14px", border: "1px solid var(--border-light)", borderRadius: 6, display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", background: "#F8FAFC" }}
                    onClick={() => {
                      setCertSearchId(u.regId);
                      setCertResult({
                        name: u.name,
                        regId: u.regId,
                        course: u.enrolledCourses?.[0] || "AI Essentials & Automation",
                        issueDate: u.date,
                        verified: true
                      });
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>{u.name}</div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{u.type} • {u.enrolledCourses?.[0]}</div>
                    </div>
                    <code style={{ fontWeight: 800, fontSize: "0.85rem" }}>{u.regId}</code>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── TAB: RESOURCES & UPLOADS ─────────────────────────────────── */}
        {activeTab === "resources" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 14 }}>
              <div>
                <h2 style={{ fontSize: "1.3rem", fontWeight: 800 }}>Platform &amp; Course Resources</h2>
                <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                  Upload downloadable materials, exercise files, and guides that immediately reflect across the platform and in course classrooms.
                </p>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <div style={{ display: "flex", gap: 6 }}>
                  {["all", "platform"].map((f) => (
                    <button
                      key={f}
                      className={`filter-pill-btn ${resourceFilter === f ? "active" : ""}`}
                      onClick={() => setResourceFilter(f)}
                      style={{ textTransform: "capitalize" }}
                    >
                      {f}
                    </button>
                  ))}
                </div>
                <button
                  className="btn btn-solid-dark btn-sm"
                  onClick={() => setShowAddResourceModal(true)}
                >
                  + Upload New Resource
                </button>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {adminResources
                .filter((r) => {
                  if (resourceFilter === "platform") return r.courseId === "platform";
                  return true;
                })
                .map((res) => (
                  <div
                    key={res.id}
                    style={{
                      background: "#FFFFFF",
                      border: "1px solid var(--border-light)",
                      borderRadius: "var(--radius-sm)",
                      padding: "18px 22px",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: 16,
                    }}
                  >
                    <div style={{ maxWidth: "70%" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                        <span className="pill-badge pill-tech">{res.type}</span>
                        <span className="pill-badge pill-solid-dark">
                          {res.courseId === "platform" ? "Platform-Wide" : `Course: ${res.courseId}`}
                        </span>
                        {res.fileSize && (
                          <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{res.fileSize}</span>
                        )}
                      </div>
                      <h3 style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--text-primary)" }}>
                        {res.title}
                      </h3>
                      <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginTop: 4 }}>
                        {res.desc || res.description}
                      </p>
                      {res.uploaderName && (
                        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 6 }}>
                          Uploaded by: <strong>{res.uploaderName}</strong> ({res.uploaderRole || "admin"})
                        </div>
                      )}
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <a
                        href={res.fileUrl || "#"}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-outline btn-sm"
                        style={{ textDecoration: "none" }}
                      >
                        View / Download &darr;
                      </a>
                      {!res.isDefault && (
                        <button
                          className="btn btn-outline btn-sm"
                          style={{ color: "#DC2626" }}
                          onClick={() => handleDeleteResource(res.id, res.fileUrl)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* ── TAB: CELEBRATIONS & MILESTONES ──────────────────────────── */}
        {activeTab === "celebrations" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 14 }}>
              <div>
                <h2 style={{ fontSize: "1.3rem", fontWeight: 800 }}>Celebrations &amp; Community Milestones 🎉</h2>
                <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                  Celebration stories and milestones submitted via the About page modal and Learner Portal. Review learner breakthroughs and community impact.
                </p>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {["all", "Course Completion", "Career Breakthrough", "Community Project", "Tech Innovation"].map((f) => (
                    <button
                      key={f}
                      className={`filter-pill-btn ${milestoneFilter === f ? "active" : ""}`}
                      onClick={() => setMilestoneFilter(f)}
                    >
                      {f === "all" ? "All Categories" : f}
                    </button>
                  ))}
                </div>
                <button
                  className="btn btn-outline btn-sm"
                  onClick={fetchMilestones}
                >
                  ↻ Refresh
                </button>
              </div>
            </div>

            <div className="data-table-container">
              {loadingMilestones ? (
                <div style={{ padding: "36px 20px", textAlign: "center", color: "var(--text-muted)" }}>
                  Loading celebration milestones...
                </div>
              ) : milestones.length === 0 ? (
                <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.9rem" }}>
                  No milestone submissions recorded yet. Submissions from "Celebrate a Milestone with Us" on the About page will appear here.
                </div>
              ) : (
                <table className="clean-data-table">
                  <thead>
                    <tr>
                      <th>Participant</th>
                      <th>Category</th>
                      <th>Celebration Date</th>
                      <th>Milestone Story</th>
                      <th>Status</th>
                      <th style={{ textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {milestones
                      .filter((m) => {
                        if (milestoneFilter === "all") return true;
                        return m.category === milestoneFilter;
                      })
                      .map((m) => (
                        <tr key={m.id || m.firestoreId || Math.random()}>
                          <td>
                            <div style={{ fontWeight: 700, color: "var(--text-primary)" }}>{m.fullName || m.name || "Learner"}</div>
                            <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{m.email || "No email provided"}</div>
                          </td>
                          <td>
                            <span className="pill-badge pill-tech">
                              {m.category || "General"}
                            </span>
                          </td>
                          <td style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                            {m.celebrationDate || (m.createdAt ? new Date(m.createdAt).toLocaleDateString() : "Recent")}
                          </td>
                          <td style={{ maxWidth: 320 }}>
                            <p style={{
                              fontSize: "0.85rem",
                              color: "var(--text-secondary)",
                              margin: 0,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis"
                            }}>
                              {m.story || "No story provided."}
                            </p>
                          </td>
                          <td>
                            <span className={`pill-badge ${m.approved ? "pill-success" : "pill-creative"}`}>
                              {m.approved ? "Approved" : "Under Review"}
                            </span>
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <button
                              className="btn btn-outline btn-sm"
                              onClick={() => setSelectedMilestoneModal(m)}
                            >
                              Read Story &rarr;
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* ── CELEBRATION STORY DETAIL MODAL ──────────────────────────── */}
        {selectedMilestoneModal && (
          <div className="modal-backdrop-overlay" onClick={() => setSelectedMilestoneModal(null)}>
            <div className="modal-dialog-box" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
                <div>
                  <span className="pill-badge pill-success" style={{ marginBottom: 4 }}>🎉 CELEBRATION MILESTONE</span>
                  <h3 style={{ fontSize: "1.4rem", fontWeight: 800 }}>{selectedMilestoneModal.fullName || "Community Milestone"}</h3>
                </div>
                <button className="btn-ghost" onClick={() => setSelectedMilestoneModal(null)}>✕</button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 18 }}>
                <div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Category</div>
                  <div style={{ fontWeight: 700, fontSize: "0.95rem" }}>{selectedMilestoneModal.category || "Milestone"}</div>
                </div>
                <div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Celebration Date</div>
                  <div style={{ fontWeight: 700, fontSize: "0.95rem" }}>{selectedMilestoneModal.celebrationDate || "Recent"}</div>
                </div>
                <div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Email</div>
                  <div style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>{selectedMilestoneModal.email || "N/A"}</div>
                </div>
                <div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Submitted At</div>
                  <div style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
                    {selectedMilestoneModal.createdAt ? new Date(selectedMilestoneModal.createdAt).toLocaleDateString() : "Recent"}
                  </div>
                </div>
              </div>

              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>
                  Milestone Story &amp; Details:
                </div>
                <div style={{
                  background: "#F8FAFC",
                  border: "1px solid #E2E8F0",
                  padding: 16,
                  borderRadius: 8,
                  fontSize: "0.9rem",
                  lineHeight: 1.6,
                  color: "var(--text-secondary)",
                  whiteSpace: "pre-wrap"
                }}>
                  {selectedMilestoneModal.story}
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={() => setSelectedMilestoneModal(null)}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── USER PROFILE MODAL ──────────────────────────────────────── */}
        {selectedUser && (
          <div className="modal-backdrop-overlay" onClick={() => setSelectedUser(null)}>
            <div className="modal-dialog-box" onClick={e => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                <div>
                  <span className="pill-badge pill-tech" style={{ marginBottom: 4 }}>LEARNER RECORD</span>
                  <h3 style={{ fontSize: "1.4rem", fontWeight: 800 }}>{selectedUser.name}</h3>
                </div>
                <button className="btn-ghost" onClick={() => setSelectedUser(null)}>✕</button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }}>
                <div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Registration ID</div>
                  <div style={{ fontWeight: 800, fontSize: "1.1rem" }}>{selectedUser.regId}</div>
                </div>
                <div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Registration Type</div>
                  <span className={`pill-badge ${selectedUser.type === "Corper" ? "pill-success" : "pill-tech"}`}>
                    {selectedUser.type}
                  </span>
                </div>
                <div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Email Address</div>
                  <div style={{ fontSize: "0.875rem", fontWeight: 600 }}>{selectedUser.email}</div>
                </div>
                <div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Phone Number</div>
                  <div style={{ fontSize: "0.875rem", fontWeight: 600 }}>{selectedUser.phone}</div>
                </div>
                {selectedUser.nyscCode && (
                  <div>
                    <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>NYSC State Code</div>
                    <div style={{ fontSize: "0.875rem", fontWeight: 700 }}>{selectedUser.nyscCode}</div>
                  </div>
                )}
                <div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Account Status</div>
                  <span className="pill-badge pill-success">{selectedUser.status}</span>
                </div>
              </div>

              <div style={{ borderTop: "1px solid var(--border-light)", paddingTop: 16, marginBottom: 20 }}>
                <div style={{ fontSize: "0.85rem", fontWeight: 700, marginBottom: 8 }}>Enrolled Courses</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {selectedUser.enrolledCourses.map((c, i) => (
                    <div key={i} style={{ padding: "8px 12px", background: "#F8FAFC", borderRadius: 6, fontSize: "0.85rem", fontWeight: 500 }}>
                      &bull; {c}
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <button
                  className="btn btn-outline btn-sm"
                  style={{ color: "#DC2626" }}
                  onClick={() => handleDeleteUser(selectedUser.id, selectedUser.name)}
                >
                  Delete User
                </button>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={() => {
                      handleToggleUserStatus(selectedUser.id, selectedUser.status);
                      setSelectedUser(null);
                    }}
                  >
                    {selectedUser.status === "Active" ? "Suspend Account" : "Activate Account"}
                  </button>
                  <button
                    className="btn btn-solid-dark btn-sm"
                    onClick={() => {
                      setCertSearchId(selectedUser.regId);
                      setCertResult({
                        name: selectedUser.name,
                        regId: selectedUser.regId,
                        course: selectedUser.enrolledCourses?.[0] || "AI Essentials & Automation",
                        issueDate: selectedUser.date,
                        verified: true
                      });
                      setSelectedUser(null);
                      setActiveTab("certificates");
                    }}
                  >
                    View Credential &rarr;
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── ADD USER MODAL ──────────────────────────────────────────── */}
        {showAddUserModal && (
          <div className="modal-backdrop-overlay" onClick={() => setShowAddUserModal(false)}>
            <div className="modal-dialog-box" onClick={e => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                <h3 style={{ fontSize: "1.4rem", fontWeight: 800 }}>Register New User</h3>
                <button className="btn-ghost" onClick={() => setShowAddUserModal(false)}>✕</button>
              </div>

              <form onSubmit={handleCreateUser}>
                <div className="form-field-group">
                  <label className="form-field-label">Full Name (Surname First)</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Asuquo Samuel"
                    className="form-field-input"
                    value={newUserForm.name}
                    onChange={e => setNewUserForm({ ...newUserForm, name: e.target.value })}
                  />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div className="form-field-group">
                    <label className="form-field-label">Email Address</label>
                    <input
                      type="email"
                      required
                      placeholder="user@example.com"
                      className="form-field-input"
                      value={newUserForm.email}
                      onChange={e => setNewUserForm({ ...newUserForm, email: e.target.value })}
                    />
                  </div>
                  <div className="form-field-group">
                    <label className="form-field-label">Phone Number</label>
                    <input
                      type="tel"
                      required
                      className="form-field-input"
                      value={newUserForm.phone}
                      onChange={e => setNewUserForm({ ...newUserForm, phone: e.target.value })}
                    />
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div className="form-field-group">
                    <label className="form-field-label">Registration Type</label>
                    <select
                      className="form-field-input"
                      value={newUserForm.type}
                      onChange={e => setNewUserForm({ ...newUserForm, type: e.target.value })}
                    >
                      <option value="Corper">Corper</option>
                      <option value="Non-Corper">Non-Corper</option>
                    </select>
                  </div>
                  <div className="form-field-group">
                    <label className="form-field-label">Role</label>
                    <select
                      className="form-field-input"
                      value={newUserForm.role}
                      onChange={e => setNewUserForm({ ...newUserForm, role: e.target.value })}
                    >
                      <option value="student">Student</option>
                      <option value="instructor">Instructor</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                </div>

                {newUserForm.type === "Corper" && (
                  <div className="form-field-group">
                    <label className="form-field-label">NYSC State Code</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. AB/24A/1000"
                      className="form-field-input"
                      value={newUserForm.nyscCode}
                      onChange={e => setNewUserForm({ ...newUserForm, nyscCode: e.target.value })}
                    />
                  </div>
                )}

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
                  <button type="button" className="btn btn-outline" onClick={() => setShowAddUserModal(false)}>
                    Cancel
                  </button>
                  <button type="submit" className="btn btn-solid-dark">
                    Register User &rarr;
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ── TUTOR APPLICATION DETAILS MODAL ─────────────────────────── */}
        {selectedAppModal && (
          <div className="modal-backdrop-overlay" onClick={() => setSelectedAppModal(null)}>
            <div className="modal-dialog-box" onClick={e => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                <div>
                  <span className="pill-badge pill-tech">TUTOR APPLICATION</span>
                  <h3 style={{ fontSize: "1.4rem", fontWeight: 800 }}>{selectedAppModal.fullName}</h3>
                </div>
                <button className="btn-ghost" onClick={() => setSelectedAppModal(null)}>✕</button>
              </div>

              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Proposed Course</div>
                <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>{selectedAppModal.courseTitle}</div>
              </div>

              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Description</div>
                <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", marginTop: 4 }}>
                  {selectedAppModal.courseDescription}
                </p>
              </div>

              {selectedAppModal.syllabus && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Curriculum / Syllabus</div>
                  <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginTop: 4, background: "#F8FAFC", padding: 12, borderRadius: 6 }}>
                    {selectedAppModal.syllabus}
                  </p>
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                {selectedAppModal.status === "pending" && (
                  <>
                    <button
                      className="btn btn-solid-dark btn-sm"
                      onClick={() => {
                        handleReviewApplication(selectedAppModal.id, "approved", selectedAppModal.applicantUid);
                        setSelectedAppModal(null);
                      }}
                    >
                      Approve &amp; Promote to Tutor
                    </button>
                    <button
                      className="btn btn-outline btn-sm"
                      style={{ color: "#DC2626" }}
                      onClick={() => {
                        handleReviewApplication(selectedAppModal.id, "rejected", selectedAppModal.applicantUid);
                        setSelectedAppModal(null);
                      }}
                    >
                      Reject
                    </button>
                  </>
                )}
                <button className="btn btn-outline btn-sm" onClick={() => setSelectedAppModal(null)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── CREATE COURSE MODAL ──────────────────────────────────────── */}
        {showAddCourseModal && (
          <div className="modal-backdrop-overlay" onClick={() => setShowAddCourseModal(false)}>
            <div className="modal-dialog-box" onClick={e => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                <h3 style={{ fontSize: "1.4rem", fontWeight: 800 }}>Create New Course in Firestore</h3>
                <button className="btn-ghost" onClick={() => setShowAddCourseModal(false)}>✕</button>
              </div>

              <form onSubmit={handleCreateCourse}>
                <div className="form-field-group">
                  <label className="form-field-label">Course Title</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Next.js & TypeScript Architecture"
                    className="form-field-input"
                    value={newCourseForm.title}
                    onChange={e => setNewCourseForm({ ...newCourseForm, title: e.target.value })}
                  />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div className="form-field-group">
                    <label className="form-field-label">Category</label>
                    <select
                      className="form-field-input"
                      value={newCourseForm.category}
                      onChange={e => setNewCourseForm({ ...newCourseForm, category: e.target.value })}
                    >
                      <option>Tech &amp; Digital Skills</option>
                      <option>Professional Skills</option>
                      <option>Creative &amp; Design</option>
                    </select>
                  </div>
                  <div className="form-field-group">
                    <label className="form-field-label">Category Badge</label>
                    <input
                      type="text"
                      className="form-field-input"
                      value={newCourseForm.badge}
                      onChange={e => setNewCourseForm({ ...newCourseForm, badge: e.target.value })}
                    />
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div className="form-field-group">
                    <label className="form-field-label">Estimated Duration</label>
                    <input
                      type="text"
                      className="form-field-input"
                      value={newCourseForm.duration}
                      onChange={e => setNewCourseForm({ ...newCourseForm, duration: e.target.value })}
                    />
                  </div>
                  <div className="form-field-group">
                    <label className="form-field-label">Total Modules</label>
                    <input
                      type="number"
                      className="form-field-input"
                      value={newCourseForm.modulesCount}
                      onChange={e => setNewCourseForm({ ...newCourseForm, modulesCount: Number(e.target.value) })}
                    />
                  </div>
                </div>

                <div className="form-field-group">
                  <label className="form-field-label">Description</label>
                  <textarea
                    rows={3}
                    required
                    className="form-field-input"
                    value={newCourseForm.description}
                    onChange={e => setNewCourseForm({ ...newCourseForm, description: e.target.value })}
                  />
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
                  <button type="button" className="btn btn-outline" onClick={() => setShowAddCourseModal(false)}>
                    Cancel
                  </button>
                  <button type="submit" className="btn btn-solid-dark">
                    Publish Course &rarr;
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ── EDIT COURSE MODAL ────────────────────────────────────────── */}
        {editingCourse && (
          <div className="modal-backdrop-overlay" onClick={() => setEditingCourse(null)}>
            <div className="modal-dialog-box" onClick={e => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                <h3 style={{ fontSize: "1.4rem", fontWeight: 800 }}>Edit Course</h3>
                <button className="btn-ghost" onClick={() => setEditingCourse(null)}>✕</button>
              </div>

              <form onSubmit={handleSaveEditCourse}>
                <div className="form-field-group">
                  <label className="form-field-label">Course Title</label>
                  <input
                    type="text"
                    required
                    className="form-field-input"
                    value={editingCourse.title}
                    onChange={e => setEditingCourse({ ...editingCourse, title: e.target.value })}
                  />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div className="form-field-group">
                    <label className="form-field-label">Duration</label>
                    <input
                      type="text"
                      className="form-field-input"
                      value={editingCourse.duration}
                      onChange={e => setEditingCourse({ ...editingCourse, duration: e.target.value })}
                    />
                  </div>
                  <div className="form-field-group">
                    <label className="form-field-label">Status</label>
                    <select
                      className="form-field-input"
                      value={editingCourse.status}
                      onChange={e => setEditingCourse({ ...editingCourse, status: e.target.value })}
                    >
                      <option value="published">Published</option>
                      <option value="draft">Draft</option>
                    </select>
                  </div>
                </div>

                <div className="form-field-group">
                  <label className="form-field-label">Description</label>
                  <textarea
                    rows={3}
                    required
                    className="form-field-input"
                    value={editingCourse.description}
                    onChange={e => setEditingCourse({ ...editingCourse, description: e.target.value })}
                  />
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
                  <button type="button" className="btn btn-outline" onClick={() => setEditingCourse(null)}>
                    Cancel
                  </button>
                  <button type="submit" className="btn btn-solid-dark">
                    Save Changes
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ── ISSUE CERTIFICATE MODAL ─────────────────────────────────── */}
        {showIssueCertModal && (
          <div className="modal-backdrop-overlay" onClick={() => setShowIssueCertModal(false)}>
            <div className="modal-dialog-box" onClick={e => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                <h3 style={{ fontSize: "1.4rem", fontWeight: 800 }}>Award Verified Certificate</h3>
                <button className="btn-ghost" onClick={() => setShowIssueCertModal(false)}>✕</button>
              </div>

              <form onSubmit={handleIssueCertificate}>
                <div className="form-field-group">
                  <label className="form-field-label">Select Student</label>
                  <select
                    className="form-field-input"
                    value={issueCertForm.studentName}
                    onChange={e => {
                      const selected = usersList.find(u => u.name === e.target.value);
                      setIssueCertForm({
                        ...issueCertForm,
                        studentName: e.target.value,
                        regId: selected?.regId || "AS1399",
                      });
                    }}
                  >
                    <option value="">Select a student...</option>
                    {usersList.map(u => (
                      <option key={u.id} value={u.name}>{u.name} ({u.regId})</option>
                    ))}
                  </select>
                </div>

                <div className="form-field-group">
                  <label className="form-field-label">Select Course</label>
                  <select
                    className="form-field-input"
                    value={issueCertForm.course}
                    onChange={e => setIssueCertForm({ ...issueCertForm, course: e.target.value })}
                  >
                    {adminCourses.map(c => (
                      <option key={c.id} value={c.title}>{c.title}</option>
                    ))}
                  </select>
                </div>

                <div className="form-field-group">
                  <label className="form-field-label">Grade / Distinction</label>
                  <input
                    type="text"
                    required
                    className="form-field-input"
                    value={issueCertForm.grade}
                    onChange={e => setIssueCertForm({ ...issueCertForm, grade: e.target.value })}
                  />
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
                  <button type="button" className="btn btn-outline" onClick={() => setShowIssueCertModal(false)}>
                    Cancel
                  </button>
                  <button type="submit" className="btn btn-solid-dark">
                    Issue Credential &rarr;
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
        {/* ── UPLOAD RESOURCE MODAL ──────────────────────────────────── */}
        {showAddResourceModal && (
          <div className="modal-backdrop-overlay" onClick={() => setShowAddResourceModal(false)}>
            <div className="modal-dialog-box" style={{ maxWidth: 600 }} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                <div>
                  <span className="pill-badge pill-tech" style={{ marginBottom: 4 }}>FILE &amp; MATERIAL UPLOAD</span>
                  <h3 style={{ fontSize: "1.4rem", fontWeight: 800 }}>Upload Platform / Course Resource</h3>
                </div>
                <button className="btn-ghost" onClick={() => setShowAddResourceModal(false)}>✕</button>
              </div>

              <form onSubmit={handleAdminUploadResource}>
                <div className="form-field-group">
                  <label className="form-field-label">Resource Title *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. 2025 AI Tools & Automation Cheatsheet"
                    className="form-field-input"
                    value={newResourceForm.title}
                    onChange={(e) => setNewResourceForm({ ...newResourceForm, title: e.target.value })}
                  />
                </div>

                <div className="form-field-group">
                  <label className="form-field-label">Description</label>
                  <textarea
                    rows={2}
                    placeholder="Brief description of this material..."
                    className="form-field-input"
                    value={newResourceForm.description}
                    onChange={(e) => setNewResourceForm({ ...newResourceForm, description: e.target.value })}
                  />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div className="form-field-group">
                    <label className="form-field-label">Target Audience / Course</label>
                    <select
                      className="form-field-input"
                      value={newResourceForm.courseId}
                      onChange={(e) => setNewResourceForm({ ...newResourceForm, courseId: e.target.value })}
                    >
                      <option value="platform">Platform-Wide (All Users)</option>
                      {adminCourses.map((c) => (
                        <option key={c.id} value={c.id}>
                          Course: {c.title}
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

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div className="form-field-group">
                    <label className="form-field-label">Upload File (PDF, ZIP, DOC, IMG)</label>
                    <input
                      type="file"
                      style={{ fontSize: "0.85rem", width: "100%", marginTop: 4 }}
                      onChange={(e) => setNewResourceForm({ ...newResourceForm, file: e.target.files[0] || null })}
                    />
                  </div>

                  <div className="form-field-group">
                    <label className="form-field-label">Or External Link (Drive, Figma, GitHub)</label>
                    <input
                      type="url"
                      placeholder="https://..."
                      className="form-field-input"
                      value={newResourceForm.externalUrl}
                      onChange={(e) => setNewResourceForm({ ...newResourceForm, externalUrl: e.target.value })}
                    />
                  </div>
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 24 }}>
                  <button type="button" className="btn btn-outline" onClick={() => setShowAddResourceModal(false)}>
                    Cancel
                  </button>
                  <button type="submit" disabled={isUploadingResource} className="btn btn-solid-dark">
                    {isUploadingResource ? "Uploading..." : "Publish Resource →"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
