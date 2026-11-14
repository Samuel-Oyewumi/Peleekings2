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
  orderBy,
  getDocs,
  serverTimestamp,
  arrayUnion,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { httpsCallable } from "firebase/functions";
import { db, storage, functions } from "../firebase";
import { COURSES_CATALOG } from "../data/courses";
import { getCurriculumForCourse } from "../data/courseCurricula";

const MAX_SUBMISSION_FILE_BYTES = 25 * 1024 * 1024; // 25MB matching storage.rules

function isAllowedSubmissionFile(file) {
  if (!file) return true;
  if (typeof file.size === "number" && file.size > MAX_SUBMISSION_FILE_BYTES) {
    return false;
  }
  const type = (file.type || "").toLowerCase();
  if (!type) return false;
  return (
    type.startsWith("image/") ||
    type === "application/pdf" ||
    type === "text/plain" ||
    /^application\/(zip|x-zip-compressed|x-zip)$/.test(type) ||
    /^application\/vnd\.openxmlformats-officedocument\..*/.test(type) ||
    /^application\/(msword|vnd\.ms-excel|vnd\.ms-powerpoint)$/.test(type)
  );
}

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
 * Helper to verify whether an enrollment record grants active classroom access.
 */
export function isEnrollmentAuthorized(enrollment) {
  return Boolean(enrollment && (enrollment.status === "active" || enrollment.status === "approved"));
}

/**
 * Request or activate enrollment for a user in a course via the server-authoritative
 * requestCourseEnrollment Cloud Function.
 * - Hands-on requests and courses with requiresApproval == true return status: "pending".
 * - Eligible published online courses that do not require approval return status: "active".
 * - Missing or unpublished courses are rejected.
 */
export async function enrollInCourse(uid, courseId, experienceType = "online", totalLessons = 1) {
  if (!uid || typeof uid !== "string" || !uid.trim()) {
    throw new Error("Authentication required to enroll in a course.");
  }
  if (
    !courseId ||
    typeof courseId !== "string" ||
    !courseId.trim() ||
    courseId === "general" ||
    courseId === "platform"
  ) {
    throw new Error("A valid courseId is required to enroll.");
  }

  const normalizedCourseId = courseId.trim();
  const normalizedExp = experienceType === "hands-on" ? "hands-on" : "online";
  const enrollmentId = `${uid}_${normalizedCourseId}`;

  const requestEnrollmentFn = httpsCallable(functions, "requestCourseEnrollment");
  const response = await requestEnrollmentFn({
    courseId: normalizedCourseId,
    experienceType: normalizedExp,
    totalLessons: Math.max(Number(totalLessons) || 0, 0),
  });

  const resultData = response?.data || {};
  const persistedEnrollment = resultData.enrollment || {
    id: resultData.enrollmentId || enrollmentId,
    uid,
    courseId: normalizedCourseId,
    experienceType: normalizedExp,
    status: resultData.status || (normalizedExp === "hands-on" ? "pending" : "active"),
    completedItemIds: [],
    progressPercent: 0,
    totalLessons: Math.max(Number(totalLessons) || 0, 0),
  };

  // Update in-memory activity cache after server confirmation
  try {
    const course = COURSES_CATALOG.find((item) => item.id === normalizedCourseId);
    const currentActivity = getUserActivity(uid);
    const existingIdx = (currentActivity.enrolledCourses || []).findIndex((c) => c.id === normalizedCourseId);
    const courseCard = {
      id: normalizedCourseId,
      title: persistedEnrollment.courseTitle || course?.title || normalizedCourseId,
      type: persistedEnrollment.experienceType === "hands-on" ? "Hands-on Practical" : "Online",
      status: persistedEnrollment.status || "pending",
      progress: persistedEnrollment.progressPercent || 0,
      currentModule: isEnrollmentAuthorized(persistedEnrollment)
        ? `${(persistedEnrollment.completedItemIds || []).length} lessons completed`
        : "Pending approval",
      image:
        course?.image ||
        "https://images.unsplash.com/photo-1677442136019-21780ecad995?w=500&auto=format&fit=crop&q=80",
      enrolledAt: new Date().toISOString(),
    };
    const nextList = [...(currentActivity.enrolledCourses || [])];
    if (existingIdx >= 0) {
      nextList[existingIdx] = courseCard;
    } else {
      nextList.unshift(courseCard);
    }
    saveUserActivity(uid, {
      ...currentActivity,
      enrolledCourses: nextList,
    });
  } catch (cacheErr) {
    console.warn("Notice: could not update local cache for enrollment:", cacheErr);
  }

  return persistedEnrollment;
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
 * Fetch enrollments for a user from Firestore.
 * By default returns both active/approved and pending enrollments so UI can show accurate status.
 */
export async function getUserEnrollments(uid, { activeOnly = false } = {}) {
  if (!uid) return [];
  try {
    const q = query(
      collection(db, "enrollments"),
      where("uid", "==", uid)
    );
    const snap = await getDocs(q);
    if (!snap.empty) {
      const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      return activeOnly ? all.filter((e) => isEnrollmentAuthorized(e)) : all;
    }
    return [];
  } catch (err) {
    console.error(`Error fetching Firestore enrollments for ${uid}:`, err);
    return [];
  }
}

/**
 * Toggle lesson/item completion and recompute progressPercent.
 * - Requires an active or approved enrollment in Firestore.
 * - Calculates unique canonical curriculum items across lessons, notes, assignments, and tests subcollections.
 * - Verifies lessonId belongs to the course's valid curriculum items before adding it.
 * - Filters out deleted/invalid item IDs from completedItemIds and caps progressPercent at 100%.
 * - Only uses enrollmentData.totalLessons || fallbackTotalLessons when Firestore curriculum subcollections are empty.
 */
export async function toggleLessonCompletion(uid, courseId, lessonId, fallbackTotalLessons = 8) {
  if (!uid || !courseId || !lessonId) {
    throw new Error("Missing uid, courseId, or lessonId.");
  }

  const enrollmentId = `${uid}_${courseId}`;
  const enrollmentRef = doc(db, "enrollments", enrollmentId);

  try {
    const enrollmentSnap = await getDoc(enrollmentRef);
    if (!enrollmentSnap.exists()) {
      throw new Error(`User ${uid} is not enrolled in course ${courseId}`);
    }

    const enrollmentData = enrollmentSnap.data();
    if (!isEnrollmentAuthorized(enrollmentData)) {
      throw new Error("Enrollment is not active. Active course access is required to update lesson progress.");
    }

    // 1. Query actual curriculum subcollections: lessons, notes, assignments, tests
    const [lessonsSnap, notesSnap, asnSnap, testsSnap] = await Promise.all([
      getDocs(collection(db, "courses", courseId, "lessons")).catch(() => ({ docs: [] })),
      getDocs(collection(db, "courses", courseId, "notes")).catch(() => ({ docs: [] })),
      getDocs(collection(db, "courses", courseId, "assignments")).catch(() => ({ docs: [] })),
      getDocs(collection(db, "courses", courseId, "tests")).catch(() => ({ docs: [] })),
    ]);

    const firestoreItemIds = new Set();
    (lessonsSnap.docs || []).forEach((d) => firestoreItemIds.add(d.id));
    (notesSnap.docs || []).forEach((d) => firestoreItemIds.add(d.id));
    (asnSnap.docs || []).forEach((d) => firestoreItemIds.add(d.id));
    (testsSnap.docs || []).forEach((d) => firestoreItemIds.add(d.id));

    const staticCurr = getCurriculumForCourse(courseId);
    const staticItemIds = new Set(
      (staticCurr?.modules || []).flatMap((m) => (m.lessons || []).map((l) => l.id)).filter(Boolean)
    );

    let validItemIds;
    let totalLessons;

    if (firestoreItemIds.size > 0) {
      validItemIds = firestoreItemIds;
      totalLessons = firestoreItemIds.size;
    } else if (staticItemIds.size > 0) {
      validItemIds = staticItemIds;
      totalLessons = enrollmentData.totalLessons || fallbackTotalLessons || staticItemIds.size;
    } else {
      validItemIds = null;
      totalLessons = enrollmentData.totalLessons || fallbackTotalLessons || 1;
    }

    const rawCompleted = Array.isArray(enrollmentData.completedItemIds)
      ? enrollmentData.completedItemIds
      : Array.isArray(enrollmentData.completedLessonIds)
        ? enrollmentData.completedLessonIds
        : [];

    // Retain only valid canonical item IDs for this course
    const currentCompleted = new Set(
      validItemIds ? rawCompleted.filter((id) => validItemIds.has(id)) : rawCompleted.filter(Boolean)
    );
    const isCompleted = currentCompleted.has(lessonId);

    if (!isCompleted && validItemIds && !validItemIds.has(lessonId)) {
      throw new Error(`Curriculum item '${lessonId}' does not belong to course '${courseId}'.`);
    }

    if (isCompleted) {
      currentCompleted.delete(lessonId);
    } else {
      currentCompleted.add(lessonId);
    }

    const updatedCompletedIds = Array.from(currentCompleted);
    const denominator = Math.max(Number(totalLessons) || 1, 1);
    const newProgressPercent = Math.min(
      100,
      Math.max(0, Math.round((updatedCompletedIds.length / denominator) * 100))
    );

    await updateDoc(enrollmentRef, {
      completedItemIds: updatedCompletedIds,
      progressPercent: newProgressPercent,
      updatedAt: serverTimestamp(),
    });

    if (!isCompleted) {
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
 * Helper: Verifies that a course exists and that a specific assignment or test belongs to that course.
 */
async function verifyCourseAndAssessment(courseId, itemId, itemType) {
  const courseRef = doc(db, "courses", courseId);
  const courseSnap = await getDoc(courseRef);
  if (!courseSnap.exists()) {
    throw new Error(`Course '${courseId}' does not exist.`);
  }
  const courseData = courseSnap.data() || {};

  const primaryCollection = itemType === "assignment" ? "assignments" : "tests";
  const [primarySnap, lessonSnap] = await Promise.all([
    getDoc(doc(db, "courses", courseId, primaryCollection, itemId)),
    getDoc(doc(db, "courses", courseId, "lessons", itemId)),
  ]);

  let existsInCourse = false;
  if (primarySnap.exists()) {
    existsInCourse = true;
  } else if (lessonSnap.exists() && lessonSnap.data()?.type === itemType) {
    existsInCourse = true;
  } else {
    const staticCurr = getCurriculumForCourse(courseId);
    const staticMatch = (staticCurr?.modules || [])
      .flatMap((m) => m.lessons || [])
      .find((l) => l.id === itemId && l.type === itemType);
    if (staticMatch) {
      existsInCourse = true;
    }
  }

  if (!existsInCourse) {
    throw new Error(
      `${itemType === "assignment" ? "Assignment" : "Test"} '${itemId}' does not exist in course '${courseId}'.`
    );
  }

  return courseData;
}

/**
 * Submit an assignment.
 * - Rejects missing courseId or "general" bypass.
 * - Verifies course existence, active/approved enrollment, and assignment membership BEFORE uploading to Storage or writing to Firestore.
 * - Client never sets grade or feedback (strictly rule-protected).
 */
export async function submitAssignment(uid, courseIdOrAssignment, assignmentIdOrData, maybeSubmissionData) {
  let courseId = "";
  let assignmentId = "";
  let submissionData = {};
  let courseTitle = null;

  if (maybeSubmissionData !== undefined) {
    courseId = typeof courseIdOrAssignment === "string" ? courseIdOrAssignment.trim() : "";
    assignmentId = typeof assignmentIdOrData === "string" ? assignmentIdOrData.trim() : "";
    submissionData = maybeSubmissionData || {};
  } else if (typeof courseIdOrAssignment === "object" && courseIdOrAssignment !== null) {
    assignmentId = typeof courseIdOrAssignment.id === "string" ? courseIdOrAssignment.id.trim() : "";
    courseId = typeof courseIdOrAssignment.courseId === "string" ? courseIdOrAssignment.courseId.trim() : "";
    courseTitle = courseIdOrAssignment.course || courseIdOrAssignment.courseTitle || null;
    submissionData = assignmentIdOrData || {};
  } else {
    assignmentId = typeof courseIdOrAssignment === "string" ? courseIdOrAssignment.trim() : "";
    submissionData = assignmentIdOrData || {};
    courseId = typeof submissionData.courseId === "string" ? submissionData.courseId.trim() : "";
  }

  if (!uid || typeof uid !== "string" || !uid.trim()) {
    throw new Error("Authentication required to submit an assignment.");
  }
  if (!courseId || courseId === "general" || courseId === "platform") {
    throw new Error("A valid courseId is required to submit an assignment.");
  }
  if (!assignmentId) {
    throw new Error("A valid assignmentId is required to submit an assignment.");
  }

  // 1. Verify active/approved enrollment in courseId BEFORE any Storage upload or Firestore write
  const enr = await getCourseEnrollment(uid, courseId);
  if (!isEnrollmentAuthorized(enr)) {
    throw new Error("Active course enrollment is required to submit assignments.");
  }

  // 2. Verify course exists and assignment belongs to courseId
  const courseData = await verifyCourseAndAssessment(courseId, assignmentId, "assignment");
  if (!courseTitle) {
    courseTitle = courseData.title || enr?.courseTitle || courseId;
  }

  // 3. Validate file size and content type before uploading to Storage
  if (submissionData.file) {
    if (typeof submissionData.file.size === "number" && submissionData.file.size > MAX_SUBMISSION_FILE_BYTES) {
      throw new Error("Submission file exceeds the maximum allowed size of 25MB.");
    }
    if (!isAllowedSubmissionFile(submissionData.file)) {
      throw new Error("Unsupported submission file format. Allowed formats: PDF, ZIP, DOCX/Office, TXT, and images.");
    }
  }

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

  // Client never sets grade, feedback, gradedAt, or gradedBy
  delete payload.grade;
  delete payload.feedback;
  delete payload.gradedAt;
  delete payload.gradedBy;

  try {
    await setDoc(submissionRef, payload, { merge: true });

    // Mark assignment as completed in enrollment and recompute progress
    try {
      const currentDone = new Set(enr.completedItemIds || []);
      if (!currentDone.has(assignmentId)) {
        await toggleLessonCompletion(uid, courseId, assignmentId);
      }
    } catch {
      try {
        await updateDoc(doc(db, "enrollments", `${uid}_${courseId}`), {
          completedItemIds: arrayUnion(assignmentId),
          updatedAt: serverTimestamp(),
        });
      } catch (enrErr) {
        console.warn("Notice: could not auto-mark assignment complete in enrollment:", enrErr);
      }
    }

    // Record in local activity cache so UI updates immediately
    try {
      const currentAct = getUserActivity(uid);
      saveUserActivity(uid, {
        ...currentAct,
        assignmentSubmissions: {
          ...(currentAct.assignmentSubmissions || {}),
          [assignmentId]: { id: submissionDocId, ...payload, submittedAt: new Date().toISOString() },
        },
      });
    } catch {
      // Ignore cache update error
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
 * - Rejects missing courseId or "general" bypass.
 * - Verifies course existence, active/approved enrollment, and test membership BEFORE writing to Firestore.
 * - Client never sets tutor grade or feedback.
 */
export async function submitTest(uid, courseIdOrTestId, testIdOrAnswers, maybeAnswers, calculatedScore = null) {
  let courseId = "";
  let testId = "";
  let answers = {};
  let score = calculatedScore;

  if (maybeAnswers !== undefined) {
    courseId = typeof courseIdOrTestId === "string" ? courseIdOrTestId.trim() : "";
    testId = typeof testIdOrAnswers === "string" ? testIdOrAnswers.trim() : "";
    answers = maybeAnswers || {};
  } else {
    throw new Error("A valid courseId and testId are required to submit a test.");
  }

  if (!uid || typeof uid !== "string" || !uid.trim()) {
    throw new Error("Authentication required to submit a test.");
  }
  if (!courseId || courseId === "general" || courseId === "platform") {
    throw new Error("A valid courseId is required to submit a test.");
  }
  if (!testId) {
    throw new Error("A valid testId is required to submit a test.");
  }

  // 1. Verify active/approved enrollment in courseId
  const enr = await getCourseEnrollment(uid, courseId);
  if (!isEnrollmentAuthorized(enr)) {
    throw new Error("Active course enrollment is required to submit tests.");
  }

  // 2. Verify course exists and test belongs to courseId
  await verifyCourseAndAssessment(courseId, testId, "test");

  const numericScore = typeof score === "number" && Number.isFinite(score)
    ? Math.min(100, Math.max(0, Math.round(score * 10) / 10))
    : 0;

  const submissionDocId = `${uid}_${testId}`;
  const submissionRef = doc(db, "testSubmissions", submissionDocId);

  const payload = {
    uid,
    courseId,
    testId,
    answers,
    score: numericScore,
    status: "submitted",
    submittedAt: serverTimestamp(),
  };

  delete payload.grade;
  delete payload.feedback;
  delete payload.gradedAt;
  delete payload.gradedBy;

  try {
    await setDoc(submissionRef, payload, { merge: true });

    // Mark test as completed in enrollment and recompute progress
    try {
      const currentDone = new Set(enr.completedItemIds || []);
      if (!currentDone.has(testId)) {
        await toggleLessonCompletion(uid, courseId, testId);
      }
    } catch {
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
