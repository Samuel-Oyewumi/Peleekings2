import {
  collection,
  getDocs,
  orderBy,
  query,
  Timestamp,
  where,
} from "firebase/firestore";
import { COURSES_CATALOG } from "../data/courses";

/**
 * Consistent far-future sentinel timestamp for announcements without an intended expiration.
 * Every valid announcement in Firestore must store a Firestore Timestamp in `expiresAt`.
 */
export const ANNOUNCEMENT_FAR_FUTURE_EXPIRES_AT_ISO = "9999-12-31T23:59:59.000Z";
export const ANNOUNCEMENT_FAR_FUTURE_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 0);
export const ANNOUNCEMENT_NO_EXPIRY_YEAR_THRESHOLD = 9000;

export function getFarFutureExpiresAtTimestamp() {
  return Timestamp.fromMillis(ANNOUNCEMENT_FAR_FUTURE_MS);
}

/**
 * Strictly parses an announcement's `expiresAt` field into epoch milliseconds.
 * Returns `null` if `expiresAt` is missing, null, empty-string, or malformed.
 */
export function parseStrictAnnouncementExpiresAtMs(expiresAt) {
  if (expiresAt === null || expiresAt === undefined || expiresAt === "") {
    return null;
  }
  if (typeof expiresAt === "number" || typeof expiresAt === "boolean") {
    return null;
  }
  if (typeof expiresAt?.toMillis === "function") {
    const ms = expiresAt.toMillis();
    return typeof ms === "number" && Number.isFinite(ms) ? ms : null;
  }
  if (typeof expiresAt?.toDate === "function") {
    const dt = expiresAt.toDate();
    const ms = dt instanceof Date ? dt.getTime() : NaN;
    return Number.isFinite(ms) ? ms : null;
  }
  if (
    typeof expiresAt === "object" &&
    typeof expiresAt.seconds === "number" &&
    Number.isFinite(expiresAt.seconds)
  ) {
    const nanos = typeof expiresAt.nanoseconds === "number" ? expiresAt.nanoseconds : 0;
    return expiresAt.seconds * 1000 + Math.floor(nanos / 1e6);
  }
  if (expiresAt instanceof Date) {
    const ms = expiresAt.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof expiresAt === "string") {
    const trimmed = expiresAt.trim();
    if (!/^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(trimmed)) {
      return null;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function isFarFutureExpiration(expiresAt) {
  const ms = parseStrictAnnouncementExpiresAtMs(expiresAt);
  if (ms === null) return false;
  const year = new Date(ms).getUTCFullYear();
  return year >= ANNOUNCEMENT_NO_EXPIRY_YEAR_THRESHOLD;
}

/**
 * Exact application query builders for learner and tutor announcements.
 * Every query explicitly constrains status == 'published' and expiresAt > nowTimestamp
 * to align with Firestore Security Rules.
 */
export function buildGlobalLearnerAnnouncementsQuery(
  dbInstance,
  nowTimestamp = Timestamp.now(),
  includeOrderBy = true
) {
  const constraints = [
    where("status", "==", "published"),
    where("audience", "in", ["all", "learners"]),
    where("expiresAt", ">", nowTimestamp),
  ];
  if (includeOrderBy) {
    constraints.push(orderBy("expiresAt", "asc"), orderBy("createdAt", "desc"));
  }
  return query(collection(dbInstance, "announcements"), ...constraints);
}

export function buildCourseLearnerAnnouncementsQuery(
  dbInstance,
  courseId,
  nowTimestamp = Timestamp.now(),
  includeOrderBy = true
) {
  const cleanCourseId = typeof courseId === "string" ? courseId.trim() : "";
  if (!cleanCourseId || cleanCourseId === "general" || cleanCourseId === "platform") {
    throw new Error("A valid courseId is required to query course announcements.");
  }
  const constraints = [
    where("status", "==", "published"),
    where("audience", "==", "course"),
    where("courseId", "==", cleanCourseId),
    where("expiresAt", ">", nowTimestamp),
  ];
  if (includeOrderBy) {
    constraints.push(orderBy("expiresAt", "asc"), orderBy("createdAt", "desc"));
  }
  return query(collection(dbInstance, "announcements"), ...constraints);
}

export function buildTutorAnnouncementsQuery(
  dbInstance,
  nowTimestamp = Timestamp.now(),
  includeOrderBy = true
) {
  const constraints = [
    where("status", "==", "published"),
    where("audience", "in", ["all", "tutors"]),
    where("expiresAt", ">", nowTimestamp),
  ];
  if (includeOrderBy) {
    constraints.push(orderBy("expiresAt", "asc"), orderBy("createdAt", "desc"));
  }
  return query(collection(dbInstance, "announcements"), ...constraints);
}

/**
 * Authoritative search course builder:
 * - Only includes courses that exist in Firestore with status === 'published'.
 * - Excludes courses marked deleting, deleted, unpublished, or otherwise unavailable.
 * - Uses static catalogue strictly for fallback display metadata on verified live course IDs.
 * - Never merges unrelated static catalogue entries into live search results.
 */
export function buildAuthoritativeSearchCourses(
  firestoreDocs,
  catalogDisplayMetadata = COURSES_CATALOG
) {
  if (!Array.isArray(firestoreDocs) || firestoreDocs.length === 0) {
    return [];
  }
  const displayMetaMap = new Map(
    (Array.isArray(catalogDisplayMetadata) ? catalogDisplayMetadata : [])
      .filter((c) => c && typeof c.id === "string" && c.id.trim() !== "")
      .map((c) => [c.id.trim(), c])
  );
  const liveCoursesMap = new Map();

  for (const docEntry of firestoreDocs) {
    if (!docEntry) continue;
    const rawId = typeof docEntry.id === "string" ? docEntry.id.trim() : "";
    if (!rawId || rawId === "general" || rawId === "platform") continue;

    const data = typeof docEntry.data === "function" ? docEntry.data() || {} : docEntry;
    if (
      data.status !== "published" ||
      data.deletionState ||
      data.deleted === true ||
      data.isDeleted === true ||
      data.available === false ||
      data.isAvailable === false
    ) {
      liveCoursesMap.delete(rawId);
      continue;
    }

    const displayMeta = displayMetaMap.get(rawId) || {};
    liveCoursesMap.set(rawId, {
      ...data,
      id: rawId,
      status: "published",
      title: data.title || displayMeta.title || "Course",
      description: data.description || displayMeta.description || "",
      category: data.category || displayMeta.category || "Tech & Digital Skills",
      badge: data.badge || data.category || displayMeta.badge || "Certificate",
      badgeClass: data.badgeClass || displayMeta.badgeClass || "pill-tech",
      rating: data.rating || displayMeta.rating || "4.8",
      duration: data.duration || displayMeta.duration || "Self-paced",
      level: data.level || displayMeta.level || "Beginner",
      image:
        data.image ||
        displayMeta.image ||
        "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=600&auto=format&fit=crop&q=80",
    });
  }

  return Array.from(liveCoursesMap.values());
}

/**
 * Normalizes, filters, and sorts learner dashboard announcements:
 * - Excludes drafts, non-published, expired, and missing/malformed expiration announcements.
 * - Allows general ('all', 'learners') announcements.
 * - Allows course-specific ('course') announcements ONLY when courseId is valid
 *   and present in authorizedCourseIds.
 * - Deduplicates by announcement ID and preserves pinned-first then newest-first sorting.
 */
export function filterAndSortLearnerAnnouncements(
  rawDocs,
  authorizedCourseIds = new Set(),
  nowMs = Date.now()
) {
  if (!Array.isArray(rawDocs) || rawDocs.length === 0) {
    return [];
  }
  const authorizedSet =
    authorizedCourseIds instanceof Set
      ? authorizedCourseIds
      : new Set(Array.isArray(authorizedCourseIds) ? authorizedCourseIds : []);

  const dedupedDocsMap = new Map();
  for (const d of rawDocs) {
    if (d && d.id && !dedupedDocsMap.has(d.id)) {
      dedupedDocsMap.set(d.id, d);
    }
  }

  return Array.from(dedupedDocsMap.values())
    .map((d) => {
      const data = typeof d.data === "function" ? d.data() || {} : d || {};
      let dateStr = "Recent";
      let sortTime = 0;
      if (data.createdAt?.toDate) {
        const dt = data.createdAt.toDate();
        dateStr = dt.toLocaleDateString();
        sortTime = dt.getTime();
      } else if (data.createdAt) {
        const dt = new Date(data.createdAt);
        if (!Number.isNaN(dt.getTime())) {
          dateStr = dt.toLocaleDateString();
          sortTime = dt.getTime();
        }
      }

      const expMs = parseStrictAnnouncementExpiresAtMs(data.expiresAt);
      const hasValidExpiresAt = expMs !== null;
      const isExpired = !hasValidExpiresAt || expMs <= nowMs;

      return {
        id: d.id,
        ...data,
        date: dateStr,
        _sortTime: sortTime,
        _hasValidExpiresAt: hasValidExpiresAt,
        _isExpired: isExpired,
      };
    })
    .filter((a) => {
      if (a.status !== "published") return false;
      if (!a._hasValidExpiresAt || a._isExpired) return false;
      if (!a.audience || a.audience === "all" || a.audience === "learners") return true;
      if (a.audience === "course") {
        const cid = typeof a.courseId === "string" ? a.courseId.trim() : "";
        if (!cid || cid === "general" || cid === "platform") return false;
        return authorizedSet.has(cid);
      }
      return false;
    })
    .sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return (b._sortTime || 0) - (a._sortTime || 0);
    });
}

/**
 * Executes the learner dashboard announcement queries (global + per-enrolled-course)
 * using the exact rule-aligned query structures.
 * Never silently converts a failed course query into an empty successful result:
 * any query failure is captured and reported in `error` and `failedCourseIds`.
 */
export async function fetchLearnerAnnouncementsFromFirestore({
  db: dbInstance,
  enrolledCourseIds = [],
  getDocsFn = getDocs,
  withQueryTimeout,
  nowTimestamp,
  nowMs = Date.now(),
}) {
  const runWithTimeout =
    typeof withQueryTimeout === "function" ? withQueryTimeout : (p) => p;
  const queryTs = nowTimestamp || Timestamp.fromMillis(nowMs);

  const validCourseIds = Array.from(
    new Set(
      (Array.isArray(enrolledCourseIds)
        ? enrolledCourseIds
        : Array.from(enrolledCourseIds || [])
      )
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter((id) => id && id !== "general" && id !== "platform")
    )
  );
  const enrolledSet = new Set(validCourseIds);

  let generalDocs = [];
  let globalQueryError = null;

  try {
    const q = buildGlobalLearnerAnnouncementsQuery(dbInstance, queryTs, true);
    const snap = await runWithTimeout(getDocsFn(q), 5000);
    generalDocs = snap?.docs || [];
  } catch (err) {
    const isIndexError =
      err?.code === "failed-precondition" ||
      /index/i.test(String(err?.message || ""));
    if (isIndexError) {
      try {
        const fallbackQ = buildGlobalLearnerAnnouncementsQuery(dbInstance, queryTs, false);
        const snap = await runWithTimeout(getDocsFn(fallbackQ), 5000);
        generalDocs = snap?.docs || [];
      } catch (fallbackErr) {
        globalQueryError = fallbackErr;
      }
    } else {
      globalQueryError = err;
    }
  }

  const failedCourseIds = [];
  const courseErrors = [];
  const courseSnaps = await Promise.all(
    validCourseIds.map(async (cid) => {
      try {
        const cq = buildCourseLearnerAnnouncementsQuery(dbInstance, cid, queryTs, true);
        return await runWithTimeout(getDocsFn(cq), 5000);
      } catch (err) {
        const isIndexError =
          err?.code === "failed-precondition" ||
          /index/i.test(String(err?.message || ""));
        if (isIndexError) {
          try {
            const fallbackCq = buildCourseLearnerAnnouncementsQuery(
              dbInstance,
              cid,
              queryTs,
              false
            );
            return await runWithTimeout(getDocsFn(fallbackCq), 5000);
          } catch (fallbackErr) {
            failedCourseIds.push(cid);
            courseErrors.push({ courseId: cid, error: fallbackErr });
            return null;
          }
        }
        failedCourseIds.push(cid);
        courseErrors.push({ courseId: cid, error: err });
        return null;
      }
    })
  );

  const combinedDocsMap = new Map();
  for (const d of generalDocs) {
    if (d?.id) combinedDocsMap.set(d.id, d);
  }
  for (const cSnap of courseSnaps) {
    for (const d of cSnap?.docs || []) {
      if (d?.id && !combinedDocsMap.has(d.id)) {
        combinedDocsMap.set(d.id, d);
      }
    }
  }

  const announcements = filterAndSortLearnerAnnouncements(
    Array.from(combinedDocsMap.values()),
    enrolledSet,
    nowMs
  );

  let errorMessage = null;
  if (globalQueryError && courseErrors.length > 0) {
    errorMessage = `Unable to load global and course announcements (${failedCourseIds.join(", ")}): ${globalQueryError?.message || "Query failed."}`;
  } else if (globalQueryError) {
    errorMessage = globalQueryError?.message || "Unable to load announcements right now.";
  } else if (courseErrors.length > 0) {
    const firstCourseErr = courseErrors[0].error?.message || "Course announcement query failed.";
    errorMessage = `Unable to load announcements for enrolled course(s) [${failedCourseIds.join(", ")}]: ${firstCourseErr}`;
  }

  return {
    announcements,
    error: errorMessage,
    failedCourseIds,
    hasError: Boolean(errorMessage),
  };
}
