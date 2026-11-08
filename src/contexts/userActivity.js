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

const inMemoryDailyActivity = new Map();
const inMemoryUserActivity = new Map();

function getMemoryDailyActivity(uid) {
  if (!uid) return {};
  return inMemoryDailyActivity.get(uid) || {};
}

function saveMemoryDailyActivity(uid, data) {
  if (!uid) return;
  inMemoryDailyActivity.set(uid, data);
}

/**
 * Increment a user's daily activity minutes for today.
 * Persists directly to Firestore at: users/{uid}/dailyActivity/{YYYY-MM-DD}
 */
export async function incrementDailyActivity(uid, minutesToAdd = 1) {
  if (!uid) return;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // 1. In-memory update for instant UI feedback
  const memMap = getMemoryDailyActivity(uid);
  const updatedMinutes = (memMap[today] || 0) + minutesToAdd;
  memMap[today] = updatedMinutes;
  saveMemoryDailyActivity(uid, memMap);

  // 2. Dispatch immediate window event so open pages update in real-time
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("peleekings_activity_incremented", {
        detail: { uid, dateStr: today, minutes: updatedMinutes, minutesAdded: minutesToAdd },
      })
    );
  }

  // 3. Persist to Firestore
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
    console.error("Failed to update daily activity in Firestore:", err);
  }
}

/**
 * Get the last 7 days of learning activity for a user directly from Firestore.
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

  try {
    const fetchPromises = days.map((d) =>
      getDoc(doc(db, "users", uid, "dailyActivity", d.dateStr))
    );
    const snaps = await Promise.all(fetchPromises);
    snaps.forEach((snap, i) => {
      if (snap.exists()) {
        days[i].minutes = snap.data().minutes || 0;
      }
    });
  } catch (err) {
    console.warn("Notice: could not fetch weekly activity from Firestore:", err);
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

  // 2. Persist directly to Firestore: check existence first and only create if it doesn't exist
  // Using setDoc(..., {merge: true}) triggers an UPDATE on existing docs which violates strict update rules
  try {
    const existingSnap = await getDoc(enrollmentRef);
    if (!existingSnap.exists()) {
      await setDoc(enrollmentRef, newEnrollment);
    } else {
      return { id: enrollmentId, ...existingSnap.data() };
    }
  } catch (err) {
    console.error(`Firestore enrollment error for ${enrollmentId}:`, err);
    throw err;
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
    console.error(`Error fetching enrollment for ${enrollmentId}:`, err);
  }
  return null;
}

/**
 * Fetch all active enrollments for a user from Firestore.
 */
export async function getUserEnrollments(uid) {
  if (!uid) return [];
  try {
    const q = query(
      collection(db, "enrollments"),
      where("uid", "==", uid),
      where("status", "==", "active")
    );
    const snap = await getDocs(q);
    if (!snap.empty) {
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }
    return [];
  } catch (err) {
    console.error(`Error fetching Firestore enrollments for ${uid}:`, err);
    return [];
  }
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
      weeklyActivity: [],
      milestones: [],
      assignmentSubmissions: {},
    };
  }

  const cached = inMemoryUserActivity.get(userId);
  if (cached) return cached;

  return {
    enrolledCourses: [],
    completedLessons: {},
    weeklyActivity: [],
    milestones: [],
    assignmentSubmissions: {},
  };
}

export function saveUserActivity(userId, data) {
  if (!userId) return;
  inMemoryUserActivity.set(userId, data);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("peleekings_activity_updated", { detail: { userId, data } }));
  }
}

export async function submitUserMilestone(userId, milestone) {
  const newMilestone = {
    uid: userId || "guest",
    fullName: milestone.fullName || "Anonymous",
    milestoneType: milestone.milestoneType || "General Milestone",
    details: milestone.details || "",
    celebrationDate: milestone.celebrationDate || new Date().toISOString().split("T")[0],
    email: milestone.email || "",
    status: "submitted",
    submittedAt: serverTimestamp(),
  };

  const docRef = await addDoc(collection(db, "milestones"), newMilestone);
  const created = { id: docRef.id, ...newMilestone };

  // Update in-memory state for instant UI feedback
  try {
    const current = getUserActivity(userId);
    const updated = {
      ...current,
      milestones: [created, ...(current.milestones || [])],
    };
    saveUserActivity(userId, updated);
  } catch (err) {
    console.warn("Notice: could not update in-memory milestone cache:", err);
  }

  return created;
}

/**
 * Fetch all submitted milestones for Admin review (Firestore-only)
 */
export async function getAllMilestones() {
  try {
    const snap = await getDocs(query(collection(db, "milestones"), orderBy("submittedAt", "desc")));
    if (!snap.empty) {
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }
    return [];
  } catch (err) {
    console.warn("Notice: fetching milestones from Firestore:", err);
    return [];
  }
}
