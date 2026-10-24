// User Activity & Learning Progress Service (Firestore-backed)
// Persists enrollments, completed lessons, progress, and submissions directly to Firestore

import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  addDoc,
  collection,
  query,
  where,
  getDocs,
  serverTimestamp,
  arrayUnion,
  arrayRemove,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage } from "../firebase";
import { COURSES_CATALOG } from "../data/courses";

// ── Daily Activity Tracking ────────────────────────────────────────────────

function getLocalDailyActivity(uid) {
  if (!uid || typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(`peleekings_daily_activity_${uid}`);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveLocalDailyActivity(uid, data) {
  if (!uid || typeof window === "undefined") return;
  try {
    localStorage.setItem(`peleekings_daily_activity_${uid}`, JSON.stringify(data));
  } catch {}
}

/**
 * Increment a user's daily activity minutes for today.
 * Stored locally for instant UI responsiveness and synced to Firestore at:
 * users/{uid}/dailyActivity/{YYYY-MM-DD}
 */
export async function incrementDailyActivity(uid, minutesToAdd = 1) {
  if (!uid) return;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // 1. Immediately update local storage
  const localMap = getLocalDailyActivity(uid);
  const updatedMinutes = (localMap[today] || 0) + minutesToAdd;
  localMap[today] = updatedMinutes;
  saveLocalDailyActivity(uid, localMap);

  // 2. Dispatch immediate window event so open pages (Dashboard, CoursePage) update in real-time
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("peleekings_activity_incremented", {
        detail: { uid, dateStr: today, minutes: updatedMinutes, minutesAdded: minutesToAdd },
      })
    );
  }

  // 3. Persist to Firestore in the background
  const dayRef = doc(db, "users", uid, "dailyActivity", today);
  try {
    await setDoc(
      dayRef,
      {
        date: today,
        minutes: updatedMinutes,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err) {
    console.warn("Notice: could not update daily activity in Firestore (synced to local cache):", err);
  }
}

/**
 * Get the last 7 days of learning activity for a user.
 * Prioritizes local tracking for zero-latency, reconciled with Firestore records.
 * Returns an array of {day, minutes, label, highlight, hours} objects for the chart.
 */
export async function getWeeklyActivityData(uid) {
  if (!uid) return null;

  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const dayLabel = d.toLocaleDateString("en-US", { weekday: "short" });
    days.push({ dateStr, dayLabel, minutes: 0 });
  }

  // Read local baseline first
  const localMap = getLocalDailyActivity(uid);
  days.forEach((d) => {
    if (localMap[d.dateStr]) {
      d.minutes = localMap[d.dateStr];
    }
  });

  // Reconcile with Firestore
  try {
    const fetchPromises = days.map((d) =>
      getDoc(doc(db, "users", uid, "dailyActivity", d.dateStr))
    );
    const snaps = await Promise.all(fetchPromises);
    let updatedLocal = false;
    snaps.forEach((snap, i) => {
      if (snap.exists()) {
        const fsMinutes = snap.data().minutes || 0;
        if (fsMinutes > days[i].minutes) {
          days[i].minutes = fsMinutes;
          localMap[days[i].dateStr] = fsMinutes;
          updatedLocal = true;
        } else if (days[i].minutes > fsMinutes) {
          // Push higher local minutes to Firestore to keep them in sync
          setDoc(doc(db, "users", uid, "dailyActivity", days[i].dateStr), {
            date: days[i].dateStr,
            minutes: days[i].minutes,
            updatedAt: serverTimestamp(),
          }, { merge: true }).catch(() => {});
        }
      } else if (days[i].minutes > 0) {
        // Doc didn't exist in Firestore yet, write it now
        setDoc(doc(db, "users", uid, "dailyActivity", days[i].dateStr), {
          date: days[i].dateStr,
          minutes: days[i].minutes,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }, { merge: true }).catch(() => {});
      }
    });
    if (updatedLocal) {
      saveLocalDailyActivity(uid, localMap);
    }
  } catch (err) {
    console.warn("Notice: could not fetch weekly activity from Firestore, using local data:", err);
  }

  const maxMinutes = Math.max(...days.map((d) => d.minutes), 1);
  const maxIdx = days.reduce((best, d, i) => (d.minutes > days[best].minutes ? i : best), 0);

  return days.map((d, i) => {
    const h = Math.floor(d.minutes / 60);
    const m = d.minutes % 60;
    const label = d.minutes === 0 ? "0m" : h > 0 ? `${h}h${m > 0 ? " " + m + "m" : ""}` : `${m}m`;
    return {
      day: d.dayLabel,
      hours: Math.max(6, Math.round((d.minutes / Math.max(maxMinutes, 1)) * 90)),
      minutes: d.minutes,
      label,
      highlight: i === maxIdx && d.minutes > 0,
    };
  });
}

/**
 * Enroll a user in a course.
 * Writes to enrollments/{uid}_{courseId} via setDoc with merge: true.
 * Synchronously updates the user's local activity cache so UI updates immediately.
 */
export async function enrollInCourse(uid, courseId, experienceType = "online", totalLessons = 1) {
  if (!uid || !courseId) return null;

  const course = COURSES_CATALOG.find((item) => item.id === courseId);
  const enrollmentId = `${uid}_${courseId}`;
  const enrollmentRef = doc(db, "enrollments", enrollmentId);

  const newEnrollment = {
    uid,
    courseId,
    courseTitle: course?.title || "Course",
    enrolledAt: serverTimestamp(),
    status: "active",
    experienceType: experienceType === "hands-on" ? "hands-on" : "online",
    completedItemIds: [],
    progressPercent: 0,
    totalLessons: Math.max(totalLessons, 1),
    currentModule: "Module 1",
    updatedAt: serverTimestamp(),
  };

  // 1. Instantly update local activity cache and notify all UI listeners
  try {
    const currentActivity = getUserActivity(uid);
    const existing = (currentActivity.enrolledCourses || []).find((c) => c.id === courseId);
    if (!existing) {
      const courseCard = {
        id: courseId,
        title: course?.title || courseId,
        type: experienceType === "hands-on" ? "Hands-on Practical" : "Online",
        progress: 0,
        currentModule: "0 lessons completed",
        image:
          course?.image ||
          "https://images.unsplash.com/photo-1677442136019-21780ecad995?w=500&auto=format&fit=crop&q=80",
        enrolledAt: new Date().toISOString(),
      };
      const updated = {
        ...currentActivity,
        enrolledCourses: [courseCard, ...(currentActivity.enrolledCourses || [])],
      };
      saveUserActivity(uid, updated);
    }
  } catch (cacheErr) {
    console.warn("Notice: could not update local cache for enrollment:", cacheErr);
  }

  // 2. Persist directly to Firestore in background (never blocks UI)
  try {
    setDoc(enrollmentRef, newEnrollment, { merge: true }).catch((err) => {
      console.warn(`Firestore enrollment sync notice for ${enrollmentId}:`, err);
    });
  } catch (err) {
    console.warn(`Firestore enrollment sync notice for ${enrollmentId}:`, err);
  }

  return { id: enrollmentId, ...newEnrollment };
}

/**
 * Fetch a specific enrollment document for a user.
 */
export async function getCourseEnrollment(uid, courseId) {
  if (!uid || !courseId) return null;
  const enrollmentId = `${uid}_${courseId}`;
  try {
    const snap = await getDoc(doc(db, "enrollments", enrollmentId));
    if (snap.exists()) {
      return { id: enrollmentId, ...snap.data() };
    }
  } catch (err) {
    console.warn(`Notice fetching enrollment for ${enrollmentId}:`, err);
  }

  // Fallback to local cache check so user is never locked out of classroom
  try {
    const local = getUserActivity(uid);
    const found = (local.enrolledCourses || []).find((c) => c.id === courseId);
    if (found) {
      return {
        id: enrollmentId,
        uid,
        courseId,
        status: "active",
        experienceType: found.type?.includes("Hands-on") ? "hands-on" : "online",
        progressPercent: found.progress || 0,
        completedItemIds: Object.keys(local.completedLessons || {}).filter((k) => local.completedLessons[k]),
      };
    }
  } catch {}

  return null;
}

/**
 * Fetch all active enrollments for a user from Firestore.
 */
export async function getUserEnrollments(uid) {
  if (!uid) return [];
  let firestoreList = [];
  try {
    const q = query(
      collection(db, "enrollments"),
      where("uid", "==", uid),
      where("status", "==", "active")
    );
    const snap = await getDocs(q);
    if (!snap.empty) {
      firestoreList = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }
  } catch (err) {
    console.warn(`Notice fetching Firestore enrollments for ${uid}:`, err);
  }

  // Always merge with local cache so user enrollments never disappear
  try {
    const local = getUserActivity(uid);
    const localCourses = local.enrolledCourses || [];
    const fsCourseIds = new Set(firestoreList.map((f) => f.courseId));

    for (const lc of localCourses) {
      if (!fsCourseIds.has(lc.id)) {
        firestoreList.push({
          id: `${uid}_${lc.id}`,
          courseId: lc.id,
          courseTitle: lc.title,
          experienceType: lc.type?.includes("Hands-on") ? "hands-on" : "online",
          progressPercent: lc.progress || 0,
          completedItemIds: [],
        });
      }
    }
  } catch {}

  return firestoreList;
}

/**
 * Toggle lesson/item completion and recompute progressPercent.
 * Uses arrayUnion / arrayRemove in Firestore and recomputes progress based on total items.
 */
export async function toggleLessonCompletion(uid, courseId, lessonId, fallbackTotalLessons = 8) {
  if (!uid || !courseId || !lessonId) return null;

  const enrollmentId = `${uid}_${courseId}`;
  const enrollmentRef = doc(db, "enrollments", enrollmentId);

  try {
    const enrollmentSnap = await getDoc(enrollmentRef);
    if (!enrollmentSnap.exists()) {
      throw new Error(`User ${uid} is not enrolled in course ${courseId}`);
    }

    const enrollmentData = enrollmentSnap.data();
    const currentCompleted = new Set(enrollmentData.completedItemIds || enrollmentData.completedLessonIds || []);
    const isCompleted = currentCompleted.has(lessonId);

    // Fetch real module/lesson count from courses/{courseId}/modules if present
    let totalLessons = 0;
    try {
      const modulesSnap = await getDocs(collection(db, "courses", courseId, "modules"));
      if (!modulesSnap.empty) {
        modulesSnap.forEach((mDoc) => {
          const mData = mDoc.data();
          if (Array.isArray(mData.lessons)) {
            totalLessons += mData.lessons.length;
          } else if (Array.isArray(mData.items)) {
            totalLessons += mData.items.length;
          }
        });
      }
    } catch (mErr) {
      console.warn("Could not query modules subcollection for lesson count:", mErr);
    }

    if (totalLessons === 0) {
      totalLessons = enrollmentData.totalLessons || fallbackTotalLessons || 8;
    }

    let updatedCompletedIds;
    let newProgressPercent;

    if (isCompleted) {
      currentCompleted.delete(lessonId);
      updatedCompletedIds = Array.from(currentCompleted);
      newProgressPercent = Math.max(0, Math.round((updatedCompletedIds.length / Math.max(totalLessons, 1)) * 100));

      await updateDoc(enrollmentRef, {
        completedItemIds: arrayRemove(lessonId),
        progressPercent: newProgressPercent,
        updatedAt: serverTimestamp(),
      });
    } else {
      currentCompleted.add(lessonId);
      updatedCompletedIds = Array.from(currentCompleted);
      newProgressPercent = Math.min(100, Math.round((updatedCompletedIds.length / Math.max(totalLessons, 1)) * 100));

      await updateDoc(enrollmentRef, {
        completedItemIds: arrayUnion(lessonId),
        progressPercent: newProgressPercent,
        updatedAt: serverTimestamp(),
      });
      // Award 5 minutes of active learning for completing a lesson
      incrementDailyActivity(uid, 5).catch(() => {});
    }

    return {
      completedItemIds: updatedCompletedIds,
      progressPercent: newProgressPercent,
    };
  } catch (err) {
    console.error("Failed to toggle lesson completion in Firestore:", err);
    throw err;
  }
}

/**
 * Submit an assignment.
 * Supports file uploads to Firebase Storage and writes submission record to assignmentSubmissions.
 * Client never sets grade or feedback (strictly rule-protected).
 */
export async function submitAssignment(uid, courseIdOrAssignment, assignmentIdOrData, maybeSubmissionData) {
  let courseId = "general";
  let assignmentId = "";
  let submissionData = {};
  let courseTitle = null;

  if (maybeSubmissionData !== undefined) {
    courseId = courseIdOrAssignment || "general";
    assignmentId = assignmentIdOrData;
    submissionData = maybeSubmissionData || {};
  } else if (typeof courseIdOrAssignment === "object" && courseIdOrAssignment !== null) {
    assignmentId = courseIdOrAssignment.id;
    courseId = courseIdOrAssignment.courseId || "general";
    courseTitle = courseIdOrAssignment.course || courseIdOrAssignment.courseTitle || null;
    submissionData = assignmentIdOrData || {};
  } else {
    assignmentId = courseIdOrAssignment;
    submissionData = assignmentIdOrData || {};
    courseId = submissionData.courseId || "general";
  }

  if (!uid || !assignmentId) throw new Error("Missing uid or assignmentId.");

  const submissionDocId = `${uid}_${assignmentId}`;
  const submissionRef = doc(db, "assignmentSubmissions", submissionDocId);

  let fileUrl = submissionData.fileUrl || null;
  let filePath = null;

  if (submissionData.file) {
    const safeName = submissionData.file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    filePath = `courses/${courseId}/submissions/${uid}/${submissionDocId}-${safeName}`;
    const storageRef = ref(storage, filePath);
    const uploadResult = await uploadBytes(storageRef, submissionData.file, {
      contentType: submissionData.file.type || "application/octet-stream",
    });
    fileUrl = await getDownloadURL(uploadResult.ref);
  }

  const payload = {
    uid,
    courseId,
    courseTitle,
    assignmentId,
    content: submissionData.content || submissionData.submissionContent || "",
    fileUrl,
    filePath,
    fileName: submissionData.file?.name || submissionData.fileName || null,
    fileSize: submissionData.file?.size || submissionData.fileSize || null,
    fileType: submissionData.file?.type || submissionData.fileType || null,
    projectLink: submissionData.projectLink || null,
    notes: submissionData.notes || null,
    studentName: submissionData.studentName || null,
    studentEmail: submissionData.studentEmail || null,
    status: "submitted",
    submittedAt: serverTimestamp(),
  };

  // Client never sets grade or feedback
  delete payload.grade;
  delete payload.feedback;

  try {
    await setDoc(submissionRef, payload, { merge: true });

    // Mark assignment as completed in enrollment
    if (courseId && courseId !== "general") {
      try {
        await updateDoc(doc(db, "enrollments", `${uid}_${courseId}`), {
          completedItemIds: arrayUnion(assignmentId),
          updatedAt: serverTimestamp(),
        });
      } catch (enrErr) {
        console.warn("Notice: could not auto-mark assignment complete in enrollment:", enrErr);
      }
    }

    // Award 10 minutes of active learning for assignment submission
    incrementDailyActivity(uid, 10).catch(() => {});

    return { id: submissionDocId, ...payload };
  } catch (err) {
    console.error("Error submitting assignment to Firestore:", err);
    throw err;
  }
}

/**
 * Fetch an assignment submission including any tutor-assigned grade/feedback.
 */
export async function getAssignmentSubmission(uid, assignmentId) {
  if (!uid || !assignmentId) return null;
  const submissionDocId = `${uid}_${assignmentId}`;
  try {
    const snap = await getDoc(doc(db, "assignmentSubmissions", submissionDocId));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  } catch (err) {
    console.warn("Error fetching assignment submission:", err);
    return null;
  }
}

/**
 * Submit a test/quiz.
 * Calculates score and records submission in testSubmissions.
 * Client never sets tutor grade or feedback.
 */
export async function submitTest(uid, courseIdOrTestId, testIdOrAnswers, maybeAnswers, calculatedScore = null) {
  let courseId = "general";
  let testId = "";
  let answers = {};
  let score = calculatedScore;

  if (maybeAnswers !== undefined) {
    courseId = courseIdOrTestId || "general";
    testId = testIdOrAnswers;
    answers = maybeAnswers || {};
  } else {
    testId = courseIdOrTestId;
    answers = testIdOrAnswers || {};
  }

  if (!uid || !testId) throw new Error("Missing uid or testId.");

  const submissionDocId = `${uid}_${testId}`;
  const submissionRef = doc(db, "testSubmissions", submissionDocId);

  const payload = {
    uid,
    courseId,
    testId,
    answers,
    score,
    status: "submitted",
    submittedAt: serverTimestamp(),
  };

  delete payload.grade;
  delete payload.feedback;

  try {
    await setDoc(submissionRef, payload, { merge: true });

    // Mark test as completed in enrollment
    if (courseId && courseId !== "general") {
      try {
        await updateDoc(doc(db, "enrollments", `${uid}_${courseId}`), {
          completedItemIds: arrayUnion(testId),
          updatedAt: serverTimestamp(),
        });
      } catch (enrErr) {
        console.warn("Notice: could not auto-mark test complete in enrollment:", enrErr);
      }
    }

    // Award 15 minutes of active learning for test completion
    incrementDailyActivity(uid, 15).catch(() => {});

    return { id: submissionDocId, ...payload };
  } catch (err) {
    console.error("Error submitting test to Firestore:", err);
    throw err;
  }
}

/**
 * Fetch a test submission including any tutor-assigned grade/feedback.
 */
export async function getTestSubmission(uid, testId) {
  if (!uid || !testId) return null;
  const submissionDocId = `${uid}_${testId}`;
  try {
    const snap = await getDoc(doc(db, "testSubmissions", submissionDocId));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  } catch (err) {
    console.warn("Error fetching test submission:", err);
    return null;
  }
}

/**
 * Fetch complete real-time activity for a user from Firestore.
 */
export async function fetchUserActivity(userId) {
  if (!userId) {
    return {
      enrolledCourses: [],
      completedLessons: {},
      weeklyActivity: null,
      milestones: [],
      assignmentSubmissions: {},
    };
  }

  try {
    const [enrollmentSnapshot, submissionSnapshot] = await Promise.all([
      getDocs(query(collection(db, "enrollments"), where("uid", "==", userId))),
      getDocs(query(collection(db, "assignmentSubmissions"), where("uid", "==", userId))),
    ]);

    const completedLessons = {};
    const enrolledCourses = enrollmentSnapshot.docs.map((item) => {
      const data = item.data();
      completedLessons[data.courseId] = data.completedItemIds || data.completedLessonIds || [];
      const catalog = COURSES_CATALOG.find((course) => course.id === data.courseId);
      const total = Math.max(data.totalLessons || 1, 1);
      const progress = Math.round(((data.completedItemIds || data.completedLessonIds || []).length / total) * 100);

      return {
        id: data.courseId,
        title: data.courseTitle || catalog?.title || "Course",
        image: catalog?.image || "https://images.unsplash.com/photo-1677442136019-21780ecad995?w=400",
        type: data.experienceType === "hands-on" ? "Hands-on" : "Online",
        progress,
        currentModule: data.currentModule || "Module 1",
        enrolledAt: data.enrolledAt,
      };
    });

    const assignmentSubmissions = {};
    submissionSnapshot.docs.forEach((item) => {
      const data = item.data();
      assignmentSubmissions[data.assignmentId] = { id: item.id, ...data };
    });

    return {
      enrolledCourses,
      completedLessons,
      assignmentSubmissions,
      milestones: [],
      weeklyActivity: null,
    };
  } catch (err) {
    console.warn("Error fetching user activity from Firestore:", err);
    return getUserActivity(userId);
  }
}

/**
 * Synchronous UI State Helper for instant render in Dashboard
 */
export function getUserActivity(userId) {
  if (!userId) {
    return {
      enrolledCourses: [],
      completedLessons: {},
      weeklyActivity: [
        { day: "Mon", hours: 45, label: "45m" },
        { day: "Tue", hours: 60, label: "1h" },
        { day: "Wed", hours: 30, label: "30m" },
        { day: "Thu", hours: 85, label: "1h 25m", highlight: true },
        { day: "Fri", hours: 40, label: "40m" },
        { day: "Sat", hours: 90, label: "1h 30m" },
        { day: "Sun", hours: 20, label: "20m" },
      ],
      milestones: [],
      assignmentSubmissions: {},
    };
  }

  try {
    const raw = localStorage.getItem(`peleekings_user_activity_${userId}`);
    if (raw) return JSON.parse(raw);
  } catch {}

  return {
    enrolledCourses: [],
    completedLessons: {},
    weeklyActivity: [
      { day: "Mon", hours: 45, label: "45m" },
      { day: "Tue", hours: 60, label: "1h" },
      { day: "Wed", hours: 30, label: "30m" },
      { day: "Thu", hours: 85, label: "1h 25m", highlight: true },
      { day: "Fri", hours: 40, label: "40m" },
      { day: "Sat", hours: 90, label: "1h 30m" },
      { day: "Sun", hours: 20, label: "20m" },
    ],
    milestones: [],
    assignmentSubmissions: {},
  };
}

export function saveUserActivity(userId, data) {
  if (!userId) return;
  try {
    localStorage.setItem(`peleekings_user_activity_${userId}`, JSON.stringify(data));
    window.dispatchEvent(new CustomEvent("peleekings_activity_updated", { detail: { userId, data } }));
  } catch (err) {
    console.warn("Failed to persist user activity cache:", err);
  }
}

export async function submitUserMilestone(userId, milestone) {
  const newMilestone = {
    id: `ms_${Date.now()}`,
    uid: userId || "guest",
    fullName: milestone.fullName || "Anonymous",
    milestoneType: milestone.milestoneType || "General Milestone",
    details: milestone.details || "",
    celebrationDate: milestone.celebrationDate || new Date().toISOString().split("T")[0],
    email: milestone.email || "",
    status: "submitted",
    createdAt: new Date().toISOString(),
  };

  // 1. Save to local storage cache for instant UI feedback
  try {
    const current = getUserActivity(userId);
    const updated = {
      ...current,
      milestones: [newMilestone, ...(current.milestones || [])],
    };
    saveUserActivity(userId, updated);

    // Also persist in global milestones array for admin viewing
    const allRaw = localStorage.getItem("peleekings_all_milestones");
    const allList = allRaw ? JSON.parse(allRaw) : [];
    localStorage.setItem("peleekings_all_milestones", JSON.stringify([newMilestone, ...allList]));
  } catch (err) {
    console.warn("Failed to cache milestone locally:", err);
  }

  // 2. Persist to Firestore milestones collection for Admin review
  try {
    const docRef = await addDoc(collection(db, "milestones"), {
      ...newMilestone,
      submittedAt: serverTimestamp(),
    });
    newMilestone.firestoreId = docRef.id;
  } catch (err) {
    console.warn("Notice: could not persist milestone to Firestore:", err);
  }

  return newMilestone;
}

/**
 * Fetch all submitted milestones for Admin review
 */
export async function getAllMilestones() {
  let list = [];
  try {
    const snap = await getDocs(query(collection(db, "milestones"), orderBy("submittedAt", "desc")));
    if (!snap.empty) {
      list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }
  } catch (err) {
    console.warn("Notice: fetching milestones from Firestore:", err);
  }

  // Merge with local storage cache so newly submitted milestones always appear
  try {
    const allRaw = localStorage.getItem("peleekings_all_milestones");
    if (allRaw) {
      const localList = JSON.parse(allRaw);
      const fsIds = new Set(list.map((m) => m.id || m.firestoreId));
      for (const loc of localList) {
        if (!fsIds.has(loc.id)) {
          list.push(loc);
        }
      }
    }
  } catch {}

  return list;
}
