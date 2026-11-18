import { createRequire } from "node:module";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  PASSWORD_MIN_LENGTH,
  checkPasswordRequirements,
  validatePasswordOrThrow,
} from "../src/utils/passwordPolicy";
import {
  lockBodyScroll,
  unlockBodyScroll,
  getActiveScrollLockCount,
  getSavedScrollPosition,
} from "../src/utils/scrollLock";
import {
  ANNOUNCEMENT_FAR_FUTURE_EXPIRES_AT_ISO,
  ANNOUNCEMENT_FAR_FUTURE_MS,
  getFarFutureExpiresAtTimestamp,
  parseStrictAnnouncementExpiresAtMs,
  isFarFutureExpiration,
  buildGlobalLearnerAnnouncementsQuery,
  buildCourseLearnerAnnouncementsQuery,
  buildTutorAnnouncementsQuery,
  fetchLearnerAnnouncementsFromFirestore,
  buildAuthoritativeSearchCourses,
  filterAndSortLearnerAnnouncements,
} from "../src/utils/courseCatalogue";
import {
  classifyAnnouncementExpirationRecord,
  runAnnouncementExpirationMigration,
} from "../scripts/migrate-announcement-expirations.js";

const require = createRequire(import.meta.url);
const Module = require("node:module");

// Provide lightweight v2 shims when loading functions/index.js in the root test runner
class MockHttpsError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "HttpsError";
    this.code = code;
    this.details = details;
  }
}

const originalModuleLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  if (request === "firebase-functions/v2/https") {
    return {
      HttpsError: MockHttpsError,
      onCall: (optsOrHandler, maybeHandler) => {
        const handler = typeof optsOrHandler === "function" ? optsOrHandler : maybeHandler;
        const options = typeof optsOrHandler === "object" && optsOrHandler !== null ? optsOrHandler : {};
        const fn = async (req) => handler(req);
        fn.run = handler;
        fn.__options = options;
        return fn;
      },
    };
  }
  if (request === "firebase-functions/v2/firestore") {
    return {
      onDocumentCreated: (_path, handler) => handler,
      onDocumentWritten: (_path, handler) => handler,
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const functionsModule = require("../functions/index.js");

const {
  __setTestBindings,
  validatePasswordPolicy,
  buildCorperCollisionSuffix,
  buildRegNumberCandidates,
  ensureUserRegNumber,
  allocateRegistrationCode,
  commitOperationsInBoundedBatches,
  deleteQueryInBoundedBatches,
  isAuthorizedCourseStoragePath,
  adminDeleteTutor,
  adminManageCourse,
  adminSetAccountStatus,
  requestCourseEnrollment,
  adminAssignCourseTutor,
  parseAndValidateAnnouncementExpiration,
  migrateAnnouncementExpirations,
  adminPublishAnnouncement,
  adminManageAnnouncement,
  adminSendNotification,
  adminSendBroadcast,
  submitTest,
  migrateTestKeys,
  requestCoursePublish,
  onEnrollmentWrite,
  onTestSubmissionWrite,
  onAssignmentSubmissionWrite,
} = functionsModule;

function createMockTimestamp(ms) {
  const numericMs = Number(ms);
  const seconds = Math.floor(numericMs / 1000);
  const nanoseconds = Math.max(0, Math.round((numericMs - seconds * 1000) * 1e6));
  return {
    seconds,
    nanoseconds,
    toDate: () => new Date(numericMs),
    toMillis: () => numericMs,
    valueOf: () => numericMs,
  };
}

function toComparableValue(val) {
  if (val && typeof val.toMillis === "function") {
    return val.toMillis();
  }
  if (val instanceof Date) {
    return val.getTime();
  }
  return val;
}

/**
 * Stateful in-memory Firestore, Auth, and Storage test harness for exercising the actual
 * production functions in `functions/index.js`.
 */
function createStatefulFirebaseHarness() {
  const docs = new Map(); // path -> plain object
  const authUsers = new Map(); // uid -> { uid, email, displayName, disabled, customClaims, tokensRevoked }
  const storageFiles = new Map(); // path -> Uint8Array/string
  const operationTimeline = [];
  const committedBatchSizes = [];

  const DELETE_SENTINEL = Symbol("DELETE_FIELD");
  class ArrayUnionOp {
    constructor(items) {
      this.items = items;
    }
  }
  class ArrayRemoveOp {
    constructor(items) {
      this.items = items;
    }
  }

  let failTransactionError = null;
  let failBatchOnCallNumber = null;
  let batchCommitCallCount = 0;
  let failSetDocPaths = new Set();
  let failListCollectionsForPaths = new Set();
  let disableListCollectionsMethod = false;
  let failStoragePrefixError = null;
  let failAuthDeleteError = null;
  let txChain = Promise.resolve();

  function normalizePath(p) {
    return String(p || "").replace(/^\/+|\/+$/g, "");
  }

  function cloneValue(val) {
    if (val === null || val === undefined || typeof val !== "object") return val;
    if (typeof val.toMillis === "function") {
      return createMockTimestamp(val.toMillis());
    }
    if (val instanceof Date) {
      return new Date(val.getTime());
    }
    if (Array.isArray(val)) return val.map(cloneValue);
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = cloneValue(v);
    }
    return out;
  }

  function applyFieldTransforms(existing = {}, incoming = {}, isMerge = true) {
    const base = isMerge ? { ...cloneValue(existing) } : {};
    for (const [k, v] of Object.entries(incoming)) {
      if (v === DELETE_SENTINEL) {
        delete base[k];
      } else if (v instanceof ArrayUnionOp) {
        const cur = Array.isArray(base[k]) ? [...base[k]] : [];
        for (const item of v.items) {
          if (!cur.includes(item)) cur.push(item);
        }
        base[k] = cur;
      } else if (v instanceof ArrayRemoveOp) {
        const cur = Array.isArray(base[k]) ? [...base[k]] : [];
        base[k] = cur.filter((item) => !v.items.includes(item));
      } else {
        base[k] = cloneValue(v);
      }
    }
    return base;
  }

  function createDocSnap(docRef) {
    const path = docRef.path;
    const exists = docs.has(path);
    const raw = exists ? cloneValue(docs.get(path)) : undefined;
    return {
      id: docRef.id,
      ref: docRef,
      exists,
      data: () => (exists ? cloneValue(raw) : undefined),
    };
  }

  function createDocRef(rawPath) {
    const path = normalizePath(rawPath);
    const segments = path.split("/");
    const id = segments[segments.length - 1];

    const ref = {
      id,
      path,
      collection(subName) {
        return createCollectionRef(`${path}/${subName}`);
      },
      async get() {
        return createDocSnap(ref);
      },
      async set(data, options = {}) {
        if (failSetDocPaths.has(path)) {
          throw new Error(`Simulated write failure on '${path}'`);
        }
        const merge = Boolean(options && options.merge);
        const current = docs.get(path) || {};
        docs.set(path, applyFieldTransforms(current, data, merge));
        operationTimeline.push(`firestore:set:${path}`);
      },
      async update(data) {
        if (!docs.has(path)) {
          throw new Error(`NOT_FOUND: Document '${path}' does not exist.`);
        }
        const current = docs.get(path) || {};
        docs.set(path, applyFieldTransforms(current, data, true));
        operationTimeline.push(`firestore:update:${path}`);
      },
      async delete() {
        docs.delete(path);
        operationTimeline.push(`firestore:delete:${path}`);
      },
    };

    if (!disableListCollectionsMethod) {
      ref.listCollections = async () => {
        if (failListCollectionsForPaths.has(path) || failListCollectionsForPaths.has("*")) {
          throw new Error(`Simulated listCollections() discovery failure at '${path}'`);
        }
        const prefix = `${path}/`;
        const subColNames = new Set();
        for (const key of docs.keys()) {
          if (key.startsWith(prefix)) {
            const remainder = key.slice(prefix.length);
            const firstSeg = remainder.split("/")[0];
            if (firstSeg) subColNames.add(firstSeg);
          }
        }
        return Array.from(subColNames).map((name) => createCollectionRef(`${path}/${name}`));
      };
    }

    return ref;
  }

  function createQuery(
    colPath,
    filters = [],
    limitCount = null,
    orderSpecs = [],
    startAfterCursor = null
  ) {
    const normalizedCol = normalizePath(colPath);
    const prefix = `${normalizedCol}/`;

    const queryObj = {
      __colPath: normalizedCol,
      __filters: filters,
      __limitCount: limitCount,
      __orderSpecs: orderSpecs,
      where(field, op, value) {
        return createQuery(
          normalizedCol,
          [...filters, { field, op, value }],
          limitCount,
          orderSpecs,
          startAfterCursor
        );
      },
      orderBy(field, direction = "asc") {
        return createQuery(
          normalizedCol,
          filters,
          limitCount,
          [...orderSpecs, { field, direction }],
          startAfterCursor
        );
      },
      startAfter(cursor) {
        return createQuery(
          normalizedCol,
          filters,
          limitCount,
          orderSpecs,
          cursor
        );
      },
      limit(n) {
        return createQuery(normalizedCol, filters, n, orderSpecs, startAfterCursor);
      },
      async get() {
        let matchedDocs = [];
        for (const [docPath, docData] of docs.entries()) {
          if (!docPath.startsWith(prefix)) continue;
          const remainder = docPath.slice(prefix.length);
          // Direct child documents only (no slash in remainder)
          if (remainder.includes("/")) continue;

          const passes = filters.every(({ field, op, value }) => {
            const rawFieldVal = docData[field];
            const fieldVal = toComparableValue(rawFieldVal);
            const targetVal = toComparableValue(value);

            if (op === "==") return fieldVal === targetVal;
            if (op === "!=") return fieldVal !== targetVal;
            if (op === "in") {
              return (
                Array.isArray(value) &&
                value.map(toComparableValue).includes(fieldVal)
              );
            }
            if (op === "array-contains") {
              return Array.isArray(rawFieldVal) && rawFieldVal.includes(value);
            }
            if (op === ">" || op === ">=" || op === "<" || op === "<=") {
              // Firestore inequality queries on a field only match documents where the field is of the same comparable type
              if (rawFieldVal === undefined || rawFieldVal === null) return false;
              if (typeof targetVal === "number" && typeof fieldVal !== "number") return false;
              if (op === ">") return fieldVal > targetVal;
              if (op === ">=") return fieldVal >= targetVal;
              if (op === "<") return fieldVal < targetVal;
              if (op === "<=") return fieldVal <= targetVal;
            }
            return false;
          });

          if (passes) {
            const dRef = createDocRef(docPath);
            matchedDocs.push(createDocSnap(dRef));
          }
        }

        if (Array.isArray(orderSpecs) && orderSpecs.length > 0) {
          matchedDocs.sort((a, b) => {
            for (const spec of orderSpecs) {
              const dir = spec.direction === "desc" ? -1 : 1;
              const aRaw = spec.field === "__name__" ? a.id : a.data()?.[spec.field];
              const bRaw = spec.field === "__name__" ? b.id : b.data()?.[spec.field];
              const aVal = toComparableValue(aRaw);
              const bVal = toComparableValue(bRaw);
              if (aVal === bVal) continue;
              return aVal > bVal ? dir : -dir;
            }
            return 0;
          });
        }

        if (startAfterCursor !== null && startAfterCursor !== undefined) {
          const cursorId =
            typeof startAfterCursor === "string"
              ? startAfterCursor
              : startAfterCursor?.id;
          if (cursorId) {
            const idx = matchedDocs.findIndex((d) => d.id === cursorId);
            if (idx >= 0) {
              matchedDocs = matchedDocs.slice(idx + 1);
            }
          }
        }

        const sliced =
          typeof limitCount === "number" && limitCount >= 0
            ? matchedDocs.slice(0, limitCount)
            : matchedDocs;

        return {
          empty: sliced.length === 0,
          size: sliced.length,
          docs: sliced,
        };
      },
    };

    return queryObj;
  }

  let autoDocSeq = 0;
  function createCollectionRef(rawColPath) {
    const colPath = normalizePath(rawColPath);
    const segments = colPath.split("/");
    const id = segments[segments.length - 1];
    const baseQuery = createQuery(colPath);

    return {
      id,
      path: colPath,
      doc(docId) {
        const resolvedId = docId || `auto_${++autoDocSeq}`;
        return createDocRef(`${colPath}/${resolvedId}`);
      },
      async add(data) {
        const dRef = this.doc();
        await dRef.set(data);
        return dRef;
      },
      where: baseQuery.where,
      orderBy: baseQuery.orderBy,
      startAfter: baseQuery.startAfter,
      limit: baseQuery.limit,
      get: baseQuery.get,
    };
  }

  const db = {
    collection(name) {
      return createCollectionRef(name);
    },
    batch() {
      const ops = [];
      return {
        set(ref, data, options) {
          ops.push({ type: "set", ref, data, options });
        },
        update(ref, data) {
          ops.push({ type: "update", ref, data });
        },
        delete(ref) {
          ops.push({ type: "delete", ref });
        },
        async commit() {
          batchCommitCallCount += 1;
          if (failBatchOnCallNumber && batchCommitCallCount === failBatchOnCallNumber) {
            throw new Error(`Simulated batch commit failure on batch #${batchCommitCallCount}`);
          }
          if (ops.length > 500) {
            throw new Error(`Firestore batch limit exceeded: ${ops.length} operations`);
          }
          committedBatchSizes.push(ops.length);
          operationTimeline.push(`firestore:batch_commit:${ops.length}`);
          for (const op of ops) {
            if (op.type === "set") {
              await op.ref.set(op.data, op.options);
            } else if (op.type === "update") {
              await op.ref.update(op.data);
            } else if (op.type === "delete") {
              await op.ref.delete();
            }
          }
        },
      };
    },
    async runTransaction(updateFn) {
      const executeTx = async () => {
        if (failTransactionError) {
          throw failTransactionError;
        }
        let hasWritten = false;
        const bufferedWrites = [];
        const tx = {
          async get(ref) {
            if (hasWritten) {
              throw new Error("Firestore transactions require all reads to be executed before all writes.");
            }
            return ref.get();
          },
          async getAll(...refs) {
            if (hasWritten) {
              throw new Error("Firestore transactions require all reads to be executed before all writes.");
            }
            return Promise.all(refs.map((r) => r.get()));
          },
          set(ref, data, options) {
            hasWritten = true;
            bufferedWrites.push(() => ref.set(data, options));
          },
          update(ref, data) {
            hasWritten = true;
            bufferedWrites.push(() => ref.update(data));
          },
          delete(ref) {
            hasWritten = true;
            bufferedWrites.push(() => ref.delete());
          },
        };

        const res = await updateFn(tx);
        for (const writeOp of bufferedWrites) {
          await writeOp();
        }
        return res;
      };

      const queued = txChain.then(executeTx, executeTx);
      txChain = queued.catch(() => {});
      return queued;
    },
  };

  const mockAdmin = {
    firestore: Object.assign(() => db, {
      FieldValue: {
        serverTimestamp: () => "SERVER_TIMESTAMP",
        delete: () => DELETE_SENTINEL,
        arrayUnion: (...items) => new ArrayUnionOp(items),
        arrayRemove: (...items) => new ArrayRemoveOp(items),
      },
      Timestamp: {
        fromDate: (d) => createMockTimestamp(d instanceof Date ? d.getTime() : new Date(d).getTime()),
        fromMillis: (ms) => createMockTimestamp(ms),
        now: () => createMockTimestamp(Date.now()),
      },
    }),
    auth() {
      return {
        async getUser(uid) {
          if (!authUsers.has(uid)) {
            const err = new Error(`There is no user record corresponding to the provided identifier: ${uid}`);
            err.code = "auth/user-not-found";
            throw err;
          }
          return cloneValue(authUsers.get(uid));
        },
        async updateUser(uid, updates) {
          if (!authUsers.has(uid)) {
            const err = new Error("User not found");
            err.code = "auth/user-not-found";
            throw err;
          }
          const cur = authUsers.get(uid);
          authUsers.set(uid, { ...cur, ...updates });
          operationTimeline.push(`auth:updateUser:${uid}`);
        },
        async setCustomUserClaims(uid, claims) {
          if (!authUsers.has(uid)) {
            const err = new Error("User not found");
            err.code = "auth/user-not-found";
            throw err;
          }
          const cur = authUsers.get(uid);
          authUsers.set(uid, { ...cur, customClaims: { ...claims } });
          operationTimeline.push(`auth:setCustomUserClaims:${uid}`);
        },
        async revokeRefreshTokens(uid) {
          if (!authUsers.has(uid)) {
            const err = new Error("User not found");
            err.code = "auth/user-not-found";
            throw err;
          }
          const cur = authUsers.get(uid);
          authUsers.set(uid, { ...cur, tokensRevoked: true });
          operationTimeline.push(`auth:revokeRefreshTokens:${uid}`);
        },
        async deleteUser(uid) {
          if (failAuthDeleteError) {
            operationTimeline.push(`auth:deleteUser:failed:${uid}`);
            throw failAuthDeleteError;
          }
          if (!authUsers.has(uid)) {
            const err = new Error("User not found");
            err.code = "auth/user-not-found";
            throw err;
          }
          authUsers.delete(uid);
          operationTimeline.push(`auth:deleteUser:${uid}`);
        },
      };
    },
    storage() {
      return {
        bucket() {
          return {
            async deleteFiles({ prefix }) {
              if (failStoragePrefixError) {
                throw failStoragePrefixError;
              }
              for (const key of Array.from(storageFiles.keys())) {
                if (key.startsWith(prefix)) {
                  storageFiles.delete(key);
                }
              }
              operationTimeline.push(`storage:deleteFiles:${prefix}`);
            },
            file(storagePath) {
              const clean = normalizePath(storagePath);
              return {
                async delete() {
                  if (failStoragePrefixError) {
                    throw failStoragePrefixError;
                  }
                  storageFiles.delete(clean);
                  operationTimeline.push(`storage:deleteFile:${clean}`);
                },
              };
            },
          };
        },
      };
    },
  };

  return {
    db,
    admin: mockAdmin,
    docs,
    authUsers,
    storageFiles,
    operationTimeline,
    committedBatchSizes,
    setFailTransactionError(err) {
      failTransactionError = err;
    },
    setFailBatchOnCallNumber(num) {
      failBatchOnCallNumber = num;
    },
    setFailSetDocPaths(paths) {
      failSetDocPaths = new Set(paths);
    },
    setFailListCollectionsForPaths(paths) {
      failListCollectionsForPaths = new Set(paths);
    },
    setDisableListCollectionsMethod(disabled) {
      disableListCollectionsMethod = Boolean(disabled);
    },
    setFailStoragePrefixError(err) {
      failStoragePrefixError = err;
    },
    setFailAuthDeleteError(err) {
      failAuthDeleteError = err;
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. PASSWORD VALIDATION POLICY (FRONTEND + BACKEND)
// ══════════════════════════════════════════════════════════════════════════════
describe("1. Password Validation Policy (Frontend & Cloud Functions)", () => {
  it("rejects 6-character password with a number in both frontend and backend validators", () => {
    const res = checkPasswordRequirements("abc123");
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(res.hasMinLength).toBe(false);
    expect(res.hasNumber).toBe(true);
    expect(res.isValid).toBe(false);
    expect(() => validatePasswordOrThrow("abc123")).toThrow(/at least 8 characters/i);
    expect(() => validatePasswordPolicy("abc123")).toThrow(/at least 8 characters/i);
  });

  it("rejects 8-character password without a number in both frontend and backend validators", () => {
    const res = checkPasswordRequirements("abcdefgh");
    expect(res.hasMinLength).toBe(true);
    expect(res.hasNumber).toBe(false);
    expect(res.isValid).toBe(false);
    expect(() => validatePasswordOrThrow("abcdefgh")).toThrow(/at least one number/i);
    expect(() => validatePasswordPolicy("abcdefgh")).toThrow(/at least one number/i);
  });

  it("accepts 8-character password with at least one number in both frontend and backend validators", () => {
    const res = checkPasswordRequirements("abcdefg1");
    expect(res.hasMinLength).toBe(true);
    expect(res.hasNumber).toBe(true);
    expect(res.isValid).toBe(true);
    expect(res.errorMessage).toBe("");
    expect(validatePasswordOrThrow("abcdefg1")).toBe(true);
    expect(validatePasswordPolicy("abcdefg1")).toBe(true);
  });

  it("never exposes the raw password in error messages", () => {
    const secret = "short1";
    try {
      validatePasswordOrThrow(secret);
    } catch (err) {
      expect(err.message).not.toContain(secret);
    }
    try {
      validatePasswordPolicy(secret);
    } catch (err) {
      expect(err.message).not.toContain(secret);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. REGISTRATION NUMBER ALLOCATION & OWNERSHIP VERIFICATION (ACTUAL FUNCTIONS)
// ══════════════════════════════════════════════════════════════════════════════
describe("2. Registration Code Generation, Multi-Round Contention & Ownership Verification", () => {
  let harness;

  beforeEach(() => {
    harness = createStatefulFirebaseHarness();
    __setTestBindings({ db: harness.db, admin: harness.admin });
  });

  it("preserves exact Corper and Non-Corper registration code formats via actual buildRegNumberCandidates", () => {
    expect(buildCorperCollisionSuffix(0)).toBe("");
    expect(buildCorperCollisionSuffix(1)).toBe("A");
    expect(buildCorperCollisionSuffix(26)).toBe("Z");
    expect(buildCorperCollisionSuffix(27)).toBe("AA");

    const corperRound0 = buildRegNumberCandidates(
      {
        surname: "Adeyemi",
        firstName: "Samuel",
        studentType: "corper",
        nyscStateCode: "AB/23A/1399",
      },
      12,
      0
    );
    expect(corperRound0.isCorper).toBe(true);
    expect(corperRound0.baseCode).toBe("AS1399");
    expect(corperRound0.candidates.slice(0, 3)).toEqual(["AS1399", "AS1399A", "AS1399B"]);

    const nonCorper = buildRegNumberCandidates({
      surname: "Oyewumi",
      firstName: "Bolu",
      studentType: "non_corper",
    });
    expect(nonCorper.isCorper).toBe(false);
    expect(nonCorper.candidates).toHaveLength(12);
    nonCorper.candidates.forEach((code) => {
      expect(code).toMatch(/^\d{4}BO$/);
    });
  });

  it("verifies existing regNumber ownership against regNumbers/{code} for Corper, Non-Corper, and PK-* formats, and repairs missing reservations atomically", async () => {
    // Case A: User doc has Corper code AS1399 and regNumbers/AS1399 is owned by the same uid
    harness.docs.set("users/student-1", {
      uid: "student-1",
      email: "s1@example.com",
      regNumber: "AS1399",
    });
    harness.docs.set("regNumbers/AS1399", {
      uid: "student-1",
      studentType: "corper",
    });

    const verifiedRes = await ensureUserRegNumber("student-1", {
      surname: "Adeyemi",
      firstName: "Samuel",
      studentType: "corper",
      nyscStateCode: "AB/23A/1399",
    });
    expect(verifiedRes).toEqual({
      regNumber: "AS1399",
      alreadyAssigned: true,
      verifiedOwnership: true,
      repairedMapping: false,
    });

    // Case B: User doc has Non-Corper code 4821KB but regNumbers/4821KB is missing -> repairs mapping
    harness.docs.set("users/student-2", {
      uid: "student-2",
      email: "s2@example.com",
      regNumber: "4821KB",
      studentType: "non_corper",
    });

    const repairedRes = await ensureUserRegNumber("student-2", {
      surname: "Bello",
      firstName: "Kemi",
      studentType: "non_corper",
    });
    expect(repairedRes).toEqual({
      regNumber: "4821KB",
      alreadyAssigned: true,
      verifiedOwnership: true,
      repairedMapping: true,
    });
    expect(harness.docs.get("regNumbers/4821KB")?.uid).toBe("student-2");
  });

  it("detects conflicting regNumber ownership (owned by another UID) and allocates a fresh verified code", async () => {
    // regNumbers/PK-REG-2026-9999 belongs to "owner-uid-original"
    harness.docs.set("regNumbers/PK-REG-2026-9999", {
      uid: "owner-uid-original",
      studentType: "non_corper",
    });

    // Another user ("impersonator-uid") has PK-REG-2026-9999 on their user doc or payload
    harness.docs.set("users/impersonator-uid", {
      uid: "impersonator-uid",
      regNumber: "PK-REG-2026-9999",
      surname: "Adeyemi",
      firstName: "Samuel",
      studentType: "corper",
      nyscStateCode: "LA/24B/4411",
    });

    const replacementRes = await ensureUserRegNumber(
      "impersonator-uid",
      {
        regNumber: "PK-REG-2026-9999",
        surname: "Adeyemi",
        firstName: "Samuel",
        studentType: "corper",
        nyscStateCode: "LA/24B/4411",
      },
      { updateUserDoc: true }
    );

    expect(replacementRes.regNumber).not.toBe("PK-REG-2026-9999");
    expect(replacementRes.regNumber).toBe("AS4411");
    expect(replacementRes.alreadyAssigned).toBe(false);
    expect(replacementRes.verifiedOwnership).toBe(true);
    expect(replacementRes.replacedConflictingRegNumber).toBe(true);

    // Original owner's reservation is untouched
    expect(harness.docs.get("regNumbers/PK-REG-2026-9999")?.uid).toBe("owner-uid-original");
    // Conflicting user received a new verified code in both regNumbers and users/{uid}
    expect(harness.docs.get("regNumbers/AS4411")?.uid).toBe("impersonator-uid");
    expect(harness.docs.get("users/impersonator-uid")?.regNumber).toBe("AS4411");
  });

  it("resolves multi-round collisions across >12 candidates and throws HttpsError('aborted') on persistence failure", async () => {
    // Pre-occupy all 12 candidates from Round 0 for AS1399
    const round0 = buildRegNumberCandidates(
      { surname: "Adeyemi", firstName: "Samuel", studentType: "corper", nyscStateCode: "AB/23A/1399" },
      12,
      0
    );
    round0.candidates.forEach((code, idx) => {
      harness.docs.set(`regNumbers/${code}`, { uid: `prior-user-${idx}` });
    });

    const allocated = await allocateRegistrationCode.run({
      auth: { uid: "corper-round-2", token: { email: "samuel@example.com" } },
      data: {
        surname: "Adeyemi",
        firstName: "Samuel",
        studentType: "corper",
        nyscStateCode: "AB/23A/1399",
      },
    });

    expect(allocated.regNumber).toBe("AS1399L");
    expect(allocated.alreadyAssigned).toBe(false);
    expect(harness.docs.get("regNumbers/AS1399L")?.uid).toBe("corper-round-2");
    expect(harness.docs.get("users/corper-round-2")?.regNumber).toBe("AS1399L");

    // Simulate Firestore transaction outage -> must throw HttpsError('aborted') and never return unpersisted fallback
    harness.setFailTransactionError(new Error("FIRESTORE_UNAVAILABLE"));
    await expect(
      ensureUserRegNumber("user-tx-fail", {
        surname: "Bello",
        firstName: "Tunde",
        studentType: "non_corper",
      })
    ).rejects.toThrow(/Unable to allocate a verified unique registration code/i);
    expect(harness.docs.has("users/user-tx-fail")).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. PERMANENT TUTOR DELETION CONSISTENCY & BOUNDED BATCHES (ACTUAL FUNCTIONS)
// ══════════════════════════════════════════════════════════════════════════════
describe("3. Permanent Tutor Deletion Consistency, Bounded Batches & Resumable Retries", () => {
  let harness;

  beforeEach(() => {
    harness = createStatefulFirebaseHarness();
    __setTestBindings({ db: harness.db, admin: harness.admin });
  });

  it("archives tutor metadata, processes >350 courses in bounded batches <=350, deletes Firestore user doc, and deletes Auth account LAST", async () => {
    harness.authUsers.set("tutor-main", {
      uid: "tutor-main",
      email: "grace@peleekings.com",
      displayName: "Grace Tutor",
      disabled: false,
      customClaims: { tutor: true, role: "tutor" },
    });
    harness.docs.set("users/tutor-main", {
      uid: "tutor-main",
      email: "grace@peleekings.com",
      fullName: "Grace Tutor",
      role: "tutor",
      regNumber: "PK-TUT-2026-0001",
    });
    harness.docs.set("users/tutor-co", {
      uid: "tutor-co",
      fullName: "Co Instructor",
      role: "tutor",
    });

    // Seed 365 courses (>350 batch boundary) + tutor application + private notifications + student academic records
    for (let i = 1; i <= 365; i++) {
      const cId = `course-${i}`;
      const assigned = i === 1 ? ["tutor-main", "tutor-co"] : ["tutor-main"];
      harness.docs.set(`courses/${cId}`, {
        id: cId,
        title: `Course ${i}`,
        tutorId: "tutor-main",
        tutorUid: "tutor-main",
        tutorName: "Grace Tutor",
        assignedTutors: assigned,
      });
    }
    harness.docs.set("tutorApplications/app-1", {
      applicantUid: "tutor-main",
      status: "approved",
    });
    harness.docs.set("users/tutor-main/notifications/n1", { title: "Welcome" });
    harness.docs.set("users/tutor-main/dailyActivity/2026-11-01", { minutes: 45 });

    // Historical student records that MUST be preserved
    harness.docs.set("enrollments/student-1_course-1", {
      uid: "student-1",
      courseId: "course-1",
      status: "active",
    });
    harness.docs.set("assignmentSubmissions/sub-1", {
      uid: "student-1",
      courseId: "course-1",
      grade: 95,
    });
    harness.docs.set("testSubmissions/test-sub-1", {
      uid: "student-1",
      courseId: "course-1",
      score: 88,
    });
    harness.docs.set("regNumbers/PK-TUT-2026-0001", {
      uid: "tutor-main",
    });

    const result = await adminDeleteTutor.run({
      auth: { uid: "admin-1", token: { admin: true } },
      data: {
        targetUid: "tutor-main",
        mode: "delete",
        reason: "Contract completed",
      },
    });

    expect(result.success).toBe(true);
    expect(result.deletionState).toBe("completed");
    expect(result.unassignedCourseIds).toHaveLength(365);
    expect(result.coursesNeedingReassignment).toHaveLength(364);

    // Verify bounded batches: every committed batch had <= 350 writes
    expect(harness.committedBatchSizes.length).toBeGreaterThanOrEqual(2);
    harness.committedBatchSizes.forEach((size) => {
      expect(size).toBeLessThanOrEqual(350);
    });

    // Verify strict ordering: Firestore archive + course updates + user doc deletion happened BEFORE Auth user deletion
    const archiveIdx = harness.operationTimeline.indexOf("firestore:set:deletedUsers/tutor-main");
    const userDocDeleteIdx = harness.operationTimeline.indexOf("firestore:delete:users/tutor-main");
    const authDeleteIdx = harness.operationTimeline.indexOf("auth:deleteUser:tutor-main");

    expect(archiveIdx).toBeGreaterThanOrEqual(0);
    expect(userDocDeleteIdx).toBeGreaterThan(archiveIdx);
    expect(authDeleteIdx).toBeGreaterThan(userDocDeleteIdx);

    // Verify final state
    expect(harness.docs.has("users/tutor-main")).toBe(false);
    expect(harness.authUsers.has("tutor-main")).toBe(false);
    expect(harness.docs.get("deletedUsers/tutor-main")?.deletionState).toBe("completed");
    expect(harness.docs.get("courses/course-1")?.tutorId).toBe("tutor-co");
    expect(harness.docs.get("courses/course-1")?.needsTutorReassignment).toBe(false);
    expect(harness.docs.get("courses/course-2")?.tutorId).toBeNull();
    expect(harness.docs.get("courses/course-2")?.needsTutorReassignment).toBe(true);

    // Student enrollments, submissions, and regNumbers reservation are preserved
    expect(harness.docs.get("enrollments/student-1_course-1")?.status).toBe("active");
    expect(harness.docs.get("assignmentSubmissions/sub-1")?.grade).toBe(95);
    expect(harness.docs.get("testSubmissions/test-sub-1")?.score).toBe(88);
    expect(harness.docs.get("regNumbers/PK-TUT-2026-0001")?.uid).toBe("tutor-main");
  });

  it("never deletes Auth user if Firestore batch fails, and resumes idempotently on retry if Auth deletion fails", async () => {
    harness.authUsers.set("tutor-retry", {
      uid: "tutor-retry",
      email: "retry@peleekings.com",
      displayName: "Retry Tutor",
      customClaims: { tutor: true, role: "tutor" },
    });
    harness.docs.set("users/tutor-retry", {
      uid: "tutor-retry",
      email: "retry@peleekings.com",
      fullName: "Retry Tutor",
      role: "tutor",
    });
    harness.docs.set("courses/course-r1", {
      id: "course-r1",
      title: "Resilient Systems",
      tutorId: "tutor-retry",
      tutorUid: "tutor-retry",
      assignedTutors: ["tutor-retry"],
    });

    // 1. Simulate Firestore batch failure during Stage 2 -> Auth user must NOT be deleted!
    harness.setFailBatchOnCallNumber(1);
    await expect(
      adminDeleteTutor.run({
        auth: { uid: "admin-1", token: { admin: true } },
        data: { targetUid: "tutor-retry", mode: "delete" },
      })
    ).rejects.toThrow(/Failed to unassign tutor courses/i);

    expect(harness.authUsers.has("tutor-retry")).toBe(true);
    expect(harness.docs.get("deletedUsers/tutor-retry")?.deletionState).toBe("failed");
    expect(harness.docs.get("deletedUsers/tutor-retry")?.failedStage).toBe(
      "unassign_courses_and_applications"
    );

    // 2. Clear Firestore batch error, but simulate transient Auth deleteUser failure in Stage 4
    harness.setFailBatchOnCallNumber(null);
    harness.setFailAuthDeleteError(new Error("TRANSIENT_AUTH_OUTAGE"));

    await expect(
      adminDeleteTutor.run({
        auth: { uid: "admin-1", token: { admin: true } },
        data: { targetUid: "tutor-retry", mode: "delete" },
      })
    ).rejects.toThrow(/TRANSIENT_AUTH_OUTAGE/);

    // Firestore user doc is now deleted and archived, while Auth deletion is pending retry
    expect(harness.docs.has("users/tutor-retry")).toBe(false);
    expect(harness.docs.get("deletedUsers/tutor-retry")?.deletionState).toBe("failed");
    expect(harness.docs.get("deletedUsers/tutor-retry")?.failedStage).toBe("delete_auth_user");
    expect(harness.authUsers.has("tutor-retry")).toBe(true);

    // 3. Retry after transient Auth error clears -> resumes from deletedUsers/tutor-retry and completes!
    harness.setFailAuthDeleteError(null);
    const retryRes = await adminDeleteTutor.run({
      auth: { uid: "admin-1", token: { admin: true } },
      data: { targetUid: "tutor-retry", mode: "delete" },
    });

    expect(retryRes.success).toBe(true);
    expect(retryRes.deletionState).toBe("completed");
    expect(harness.authUsers.has("tutor-retry")).toBe(false);
    expect(harness.docs.get("deletedUsers/tutor-retry")?.deletionState).toBe("completed");

    // 4. Subsequent call on already-completed deletion is an idempotent no-op
    const secondRetry = await adminDeleteTutor.run({
      auth: { uid: "admin-1", token: { admin: true } },
      data: { targetUid: "tutor-retry", mode: "delete" },
    });
    expect(secondRetry.success).toBe(true);
    expect(secondRetry.idempotentRetry).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. RECURSIVE COURSE DELETION, STORAGE GUARD & RESUMABLE STATE (ACTUAL FUNCTIONS)
// ══════════════════════════════════════════════════════════════════════════════
describe("4. Recursive Course Deletion, listCollections() Error Handling & Storage Path Guard", () => {
  let harness;

  beforeEach(() => {
    harness = createStatefulFirebaseHarness();
    __setTestBindings({ db: harness.db, admin: harness.admin });
  });

  it("restricts Storage cleanup strictly to the course's authorized prefixes", () => {
    expect(isAuthorizedCourseStoragePath("ai-101", "courses/ai-101/resources/syllabus.pdf")).toBe(true);
    expect(isAuthorizedCourseStoragePath("ai-101", "resources/ai-101/slides.pdf")).toBe(true);

    // Rejects cross-course paths, user portraits, platform root, and traversal attempts
    expect(isAuthorizedCourseStoragePath("ai-101", "courses/other-course/resources/syllabus.pdf")).toBe(false);
    expect(isAuthorizedCourseStoragePath("ai-101", "users/u1/portrait/avatar.png")).toBe(false);
    expect(isAuthorizedCourseStoragePath("ai-101", "courses/ai-101/../other-course/secret.pdf")).toBe(false);
    expect(isAuthorizedCourseStoragePath("platform", "resources/platform/doc.pdf")).toBe(false);
  });

  it("treats listCollections() discovery failures as real errors instead of silently falling back", async () => {
    harness.docs.set("courses/c-fail-list", {
      id: "c-fail-list",
      title: "Broken Discovery Course",
      status: "published",
    });
    harness.docs.set("courses/c-fail-list/modules/m1", { title: "Module 1" });
    harness.docs.set("courses/c-fail-list/modules/m1/customNested/n1", { note: "Deep child" });
    harness.docs.set("enrollments/student-1_c-fail-list", {
      uid: "student-1",
      courseId: "c-fail-list",
      status: "active",
    });

    // Inject listCollections() failure on nested document courses/c-fail-list/modules/m1
    harness.setFailListCollectionsForPaths(["courses/c-fail-list/modules/m1"]);

    await expect(
      adminManageCourse.run({
        auth: { uid: "admin-1", token: { admin: true } },
        data: { action: "delete", courseId: "c-fail-list" },
      })
    ).rejects.toThrow(/Subcollection discovery\/deletion failed|Simulated listCollections\(\) discovery failure/i);

    // Course document is NOT deleted and is locked in status: "deleting", deletionState: "failed"
    expect(harness.docs.get("courses/c-fail-list")?.status).toBe("deleting");
    expect(harness.docs.get("courses/c-fail-list")?.deletionState).toBe("failed");
    expect(harness.docs.get("courseDeletions/c-fail-list")?.deletionState).toBe("failed");
    // Student enrollment was immediately archived in Stage 2 so student lost active access right away
    expect(harness.docs.get("enrollments/student-1_c-fail-list")?.status).toBe("archived");
  });

  it("recursively deletes arbitrarily deep unknown subcollections in bounded batches <=350, skips unauthorized Storage paths, and resumes after failure", async () => {
    harness.docs.set("users/tutor-1", {
      uid: "tutor-1",
      role: "tutor",
      assignedCourses: ["c-deep", "c-keep"],
    });
    harness.docs.set("courses/c-deep", {
      id: "c-deep",
      title: "Deep Curriculum Course",
      status: "published",
      tutorId: "tutor-1",
      assignedTutors: ["tutor-1"],
    });

    // Deep nested subcollections including custom/unknown subcollection names:
    // courses/c-deep -> modules/m1 -> lessons/l1 -> discussionThreads/t1 -> replies/r1
    harness.docs.set("courses/c-deep/modules/m1", { title: "Module 1" });
    harness.docs.set("courses/c-deep/modules/m1/lessons/l1", { title: "Lesson 1" });
    harness.docs.set("courses/c-deep/modules/m1/lessons/l1/discussionThreads/t1", { topic: "Q&A" });
    harness.docs.set("courses/c-deep/modules/m1/lessons/l1/discussionThreads/t1/replies/r1", {
      text: "Nested reply",
    });

    // Seed 360 lessons to exercise bounded batching (<= 350 writes per batch)
    for (let i = 1; i <= 360; i++) {
      harness.docs.set(`courses/c-deep/lessons/lesson-${i}`, { title: `Lesson ${i}` });
    }

    // Course resources: one authorized Storage path, one unauthorized cross-course path
    harness.docs.set("courses/c-deep/resources/res-valid", {
      title: "Valid PDF",
      storagePath: "courses/c-deep/resources/valid.pdf",
    });
    harness.docs.set("courses/c-deep/resources/res-malicious", {
      title: "Cross-Course Ref",
      storagePath: "courses/c-keep/resources/do-not-delete.pdf",
    });

    harness.storageFiles.set("courses/c-deep/resources/valid.pdf", "PDF_BYTES");
    harness.storageFiles.set("courses/c-keep/resources/do-not-delete.pdf", "KEEP_BYTES");

    harness.docs.set("enrollments/s1_c-deep", {
      uid: "s1",
      courseId: "c-deep",
      status: "active",
    });
    harness.docs.set("assignmentSubmissions/sub-s1", {
      uid: "s1",
      courseId: "c-deep",
      grade: 91,
    });

    // 1. First attempt: simulate Storage failure -> aborts before subcollection/course doc deletion
    harness.setFailStoragePrefixError(new Error("STORAGE_BUCKET_TIMEOUT"));
    await expect(
      adminManageCourse.run({
        auth: { uid: "admin-1", token: { admin: true } },
        data: { action: "delete", courseId: "c-deep" },
      })
    ).rejects.toThrow(/STORAGE_BUCKET_TIMEOUT/);

    // Course immediately transitioned to status: "deleting" and enrollment is already archived
    expect(harness.docs.get("courses/c-deep")?.status).toBe("deleting");
    expect(harness.docs.get("enrollments/s1_c-deep")?.status).toBe("archived");

    // 2. Second attempt: clear Storage error -> resumes and completes full recursive deletion
    harness.setFailStoragePrefixError(null);
    const delRes = await adminManageCourse.run({
      auth: { uid: "admin-1", token: { admin: true } },
      data: { action: "delete", courseId: "c-deep" },
    });

    expect(delRes.success).toBe(true);
    expect(delRes.deletionState).toBe("completed");
    expect(delRes.deletedSubDocs).toBe(366); // 4 nested + 360 lessons + 2 resources
    expect(delRes.archivedEnrollmentsCount).toBe(1);
    expect(delRes.skippedUnauthorizedStoragePaths).toEqual([
      "courses/c-keep/resources/do-not-delete.pdf",
    ]);

    // Verify all batches respected <= 350 writes
    harness.committedBatchSizes.forEach((size) => {
      expect(size).toBeLessThanOrEqual(350);
    });

    // Verify course doc and all deep nested subcollection docs are completely gone
    expect(harness.docs.has("courses/c-deep")).toBe(false);
    expect(
      harness.docs.has("courses/c-deep/modules/m1/lessons/l1/discussionThreads/t1/replies/r1")
    ).toBe(false);

    // Authorized file was deleted, unauthorized cross-course file was preserved!
    expect(harness.storageFiles.has("courses/c-deep/resources/valid.pdf")).toBe(false);
    expect(harness.storageFiles.has("courses/c-keep/resources/do-not-delete.pdf")).toBe(true);

    // Tutor's assignedCourses had c-deep removed while preserving c-keep
    expect(harness.docs.get("users/tutor-1")?.assignedCourses).toEqual(["c-keep"]);

    // Student historical submission is preserved
    expect(harness.docs.get("assignmentSubmissions/sub-s1")?.grade).toBe(91);

    // 3. Third call on already-deleted course is idempotent
    const replayRes = await adminManageCourse.run({
      auth: { uid: "admin-1", token: { admin: true } },
      data: { action: "delete", courseId: "c-deep" },
    });
    expect(replayRes.success).toBe(true);
    expect(replayRes.idempotentRetry).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. MOBILE PROFILE SCROLL LOCK, NESTED SCROLLING & CLEANUP
// ══════════════════════════════════════════════════════════════════════════════
describe("5. Mobile Profile Scroll Lock, Direction Reversal & Position Restoration", () => {
  let mockBody;
  let mockDocEl;
  let listeners;
  let scrollToSpy;

  beforeEach(() => {
    while (getActiveScrollLockCount() > 0) {
      unlockBodyScroll();
    }
    listeners = {};
    mockBody = {
      style: {
        overflow: "",
        overscrollBehavior: "",
        position: "",
        top: "",
        left: "",
        right: "",
        width: "",
      },
      attributes: {},
      setAttribute(k, v) {
        this.attributes[k] = v;
      },
      removeAttribute(k) {
        delete this.attributes[k];
      },
    };
    mockDocEl = {
      style: {
        overflow: "",
        overscrollBehavior: "",
      },
      scrollTop: 340,
      scrollLeft: 0,
    };
    scrollToSpy = vi.fn();
    globalThis.window = {
      scrollY: 340,
      scrollX: 0,
      pageYOffset: 340,
      pageXOffset: 0,
      innerWidth: 375,
      scrollTo: scrollToSpy,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    globalThis.document = {
      body: mockBody,
      documentElement: mockDocEl,
      addEventListener(type, fn) {
        listeners[type] = fn;
      },
      removeEventListener(type) {
        delete listeners[type];
      },
    };
  });

  it("locks body with position:fixed at current scrollY and restores exact scroll position on unlock", () => {
    mockBody.style.overflow = "visible";
    const unlock = lockBodyScroll();

    expect(getActiveScrollLockCount()).toBe(1);
    expect(mockBody.style.overflow).toBe("hidden");
    expect(mockBody.style.overscrollBehavior).toBe("none");
    expect(mockBody.style.position).toBe("fixed");
    expect(mockBody.style.top).toBe("-340px");
    expect(mockBody.style.width).toBe("100%");
    expect(mockBody.attributes["data-scroll-locked"]).toBe("true");
    expect(getSavedScrollPosition()).toEqual({ x: 0, y: 340 });

    unlock();

    expect(getActiveScrollLockCount()).toBe(0);
    expect(mockBody.style.overflow).toBe("visible");
    expect(mockBody.style.position).toBe("");
    expect(mockBody.style.top).toBe("");
    expect(mockBody.attributes["data-scroll-locked"]).toBeUndefined();
    expect(scrollToSpy).toHaveBeenCalledWith(0, 340);
  });

  it("handles mid-drag direction reversal at boundary and nested scrollable elements inside locked profile modal", () => {
    const unlock = lockBodyScroll();

    const scrollableProfileNode = {
      scrollTop: 0,
      scrollHeight: 600,
      clientHeight: 300,
      getAttribute: (attr) => (attr === "data-scroll-lock-scrollable" ? "true" : null),
      parentElement: mockBody,
    };

    const nestedTextarea = {
      scrollTop: 20,
      scrollHeight: 150,
      clientHeight: 60,
      getAttribute: () => null,
      parentElement: scrollableProfileNode,
    };

    // Start touch at Y=200
    listeners.touchstart({ touches: [{ clientY: 200 }] });

    // 1. At top of profile (scrollTop=0), dragging finger down (Y=240, deltaY=+40) on profile body prevents overscroll
    const topOverscrollEvent = {
      target: scrollableProfileNode,
      touches: [{ clientY: 240 }],
      cancelable: true,
      preventDefault: vi.fn(),
    };
    listeners.touchmove(topOverscrollEvent);
    expect(topOverscrollEvent.preventDefault).toHaveBeenCalledTimes(1);

    // 2. Without lifting finger, user reverses direction and drags finger up (Y=210, incremental deltaY=-30) -> allowed!
    const reverseDragEvent = {
      target: scrollableProfileNode,
      touches: [{ clientY: 210 }],
      cancelable: true,
      preventDefault: vi.fn(),
    };
    listeners.touchmove(reverseDragEvent);
    expect(reverseDragEvent.preventDefault).not.toHaveBeenCalled();

    // 3. Even when profile container is at scrollTop=0, dragging down inside a scrolled nested textarea (scrollTop=20) is allowed!
    const nestedTextareaDragEvent = {
      target: nestedTextarea,
      touches: [{ clientY: 235 }],
      cancelable: true,
      preventDefault: vi.fn(),
    };
    listeners.touchmove(nestedTextareaDragEvent);
    expect(nestedTextareaDragEvent.preventDefault).not.toHaveBeenCalled();

    // 4. Wheel events outside scrollable container or at top boundary are prevented, while wheel down inside scrollable container is allowed
    const outsideWheelEvent = {
      target: mockBody,
      deltaY: 60,
      cancelable: true,
      preventDefault: vi.fn(),
    };
    listeners.wheel(outsideWheelEvent);
    expect(outsideWheelEvent.preventDefault).toHaveBeenCalledTimes(1);

    const boundaryWheelUpEvent = {
      target: scrollableProfileNode,
      deltaY: -40,
      cancelable: true,
      preventDefault: vi.fn(),
    };
    listeners.wheel(boundaryWheelUpEvent);
    expect(boundaryWheelUpEvent.preventDefault).toHaveBeenCalledTimes(1);

    const validWheelDownEvent = {
      target: scrollableProfileNode,
      deltaY: 40,
      cancelable: true,
      preventDefault: vi.fn(),
    };
    listeners.wheel(validWheelDownEvent);
    expect(validWheelDownEvent.preventDefault).not.toHaveBeenCalled();

    unlock();
  });

  it("handles repeated open/close cycles and overlapping locks safely", () => {
    const unlockProfile = lockBodyScroll();
    const unlockDrawer = lockBodyScroll();

    expect(getActiveScrollLockCount()).toBe(2);
    expect(mockBody.style.overflow).toBe("hidden");

    unlockDrawer();
    expect(getActiveScrollLockCount()).toBe(1);
    expect(mockBody.style.overflow).toBe("hidden");

    unlockProfile();
    expect(getActiveScrollLockCount()).toBe(0);
    expect(mockBody.style.overflow).toBe("");
    expect(scrollToSpy).toHaveBeenCalledWith(0, 340);
  });
});

// ============================================================================
// 6. FINAL PRODUCTION READINESS: COURSE DELETION CHECKPOINTS, RECURSIVE TUTOR
//    CLEANUP, ACCOUNT STATUS ROLLBACK, AND REGISTRATION NUMBER INTEGRITY
// ============================================================================
describe("6. Production Launch Readiness — Phase 2 & 3 Critical Verification", () => {
  let harness;

  beforeEach(() => {
    harness = createStatefulFirebaseHarness();
    __setTestBindings({ db: harness.db, admin: harness.admin });
  });

  it("never silently skips Storage cleanup when admin.storage or bucket methods are unavailable", async () => {
    const courseId = "course-unavail-storage";
    await harness.db.collection("courses").doc(courseId).set({
      title: "Storage Validation Course",
      status: "published",
    });

    // Simulate broken storage bucket without deleteFiles
    const brokenAdmin = {
      ...harness.admin,
      storage: () => ({
        bucket: () => ({}),
      }),
    };
    __setTestBindings({ db: harness.db, admin: brokenAdmin });

    await expect(
      adminManageCourse({
        auth: { uid: "admin_1", token: { admin: true } },
        data: { action: "delete", courseId },
      })
    ).rejects.toThrow(/Storage cleanup failed/i);

    const deletionSnap = await harness.db.collection("courseDeletions").doc(courseId).get();
    expect(deletionSnap.exists).toBe(true);
    expect(deletionSnap.data().deletionState).toBe("failed");
    expect(deletionSnap.data().failedStage).toBe("storage_cleanup");
    expect(deletionSnap.data().stages.storageCleanup).toBe(false);

    // Course document must remain in Firestore with status: "deleting"
    const courseSnap = await harness.db.collection("courses").doc(courseId).get();
    expect(courseSnap.exists).toBe(true);
    expect(courseSnap.data().status).toBe("deleting");
  });

  it("verifies completed stage checkpoints on retry and re-executes a stage if new uncleaned data is detected", async () => {
    const courseId = "course-checkpoint-verify";
    await harness.db.collection("courses").doc(courseId).set({
      title: "Checkpoint Verification Course",
      status: "deleting",
      deletionState: "failed",
    });
    // Pre-populate a prior courseDeletions doc claiming enrollmentArchival was already true
    await harness.db.collection("courseDeletions").doc(courseId).set({
      courseId,
      deletionState: "failed",
      failedStage: "storage_cleanup",
      stages: {
        enrollmentArchival: true,
        tutorAssignmentCleanup: true,
        storageCleanup: false,
        subcollectionDeletion: false,
        courseDocumentDeletion: false,
      },
    });
    // However, an unarchived active enrollment exists in Firestore
    await harness.db.collection("enrollments").doc(`student_99_${courseId}`).set({
      uid: "student_99",
      courseId,
      status: "active",
      courseDeleted: false,
    });

    const res = await adminManageCourse({
      auth: { uid: "admin_1", token: { admin: true } },
      data: { action: "delete", courseId },
    });

    expect(res.success).toBe(true);
    expect(res.stages).toEqual({
      enrollmentArchival: true,
      tutorAssignmentCleanup: true,
      storageCleanup: true,
      subcollectionDeletion: true,
      courseDocumentDeletion: true,
    });

    // Verify the unarchived enrollment was detected and archived instead of skipped
    const enrSnap = await harness.db.collection("enrollments").doc(`student_99_${courseId}`).get();
    expect(enrSnap.data().courseDeleted).toBe(true);
    expect(enrSnap.data().status).toBe("archived");
  });

  it("blocks course updates, status toggles, tutor assignments, and enrollments while course status is 'deleting'", async () => {
    const courseId = "course-deleting-locked";
    await harness.db.collection("courses").doc(courseId).set({
      title: "Locked Deleting Course",
      status: "deleting",
      deletionState: "deleting",
    });
    await harness.db.collection("users").doc("student_1").set({
      uid: "student_1",
      status: "active",
    });
    await harness.db.collection("users").doc("tutor_1").set({
      uid: "tutor_1",
      role: "tutor",
      status: "active",
    });
    harness.authUsers.set("tutor_1", {
      uid: "tutor_1",
      customClaims: { tutor: true },
    });

    // 1. Block course update
    await expect(
      adminManageCourse({
        auth: { uid: "admin_1", token: { admin: true } },
        data: { action: "update", courseId, courseData: { title: "Mutated Title" } },
      })
    ).rejects.toThrow(/deletion is in progress/i);

    // 2. Block course toggleStatus
    await expect(
      adminManageCourse({
        auth: { uid: "admin_1", token: { admin: true } },
        data: { action: "toggleStatus", courseId, courseData: { status: "published" } },
      })
    ).rejects.toThrow(/deletion is in progress/i);

    // 3. Block tutor assignment
    await expect(
      adminAssignCourseTutor({
        auth: { uid: "admin_1", token: { admin: true } },
        data: { courseId, tutorUid: "tutor_1", mode: "assign" },
      })
    ).rejects.toThrow(/deletion is in progress/i);

    // 4. Block student and admin enrollment requests
    await expect(
      requestCourseEnrollment({
        auth: { uid: "admin_1", token: { admin: true } },
        data: { courseId, experienceType: "online" },
      })
    ).rejects.toThrow(/currently being deleted/i);
  });

  it("recursively discovers and deletes arbitrary and nested private user subcollections during permanent tutor deletion", async () => {
    const tutorUid = "tutor_deep_subs";
    harness.authUsers.set(tutorUid, {
      uid: tutorUid,
      email: "deepsubs@peleekings.com",
      displayName: "Deep Subcollection Tutor",
      disabled: false,
      customClaims: { tutor: true },
    });

    await harness.db.collection("users").doc(tutorUid).set({
      uid: tutorUid,
      email: "deepsubs@peleekings.com",
      fullName: "Deep Subcollection Tutor",
      role: "tutor",
      regNumber: "PK-2026-8888",
      status: "active",
    });
    // Arbitrary nested subcollections under users/{tutorUid}
    await harness.db
      .collection("users")
      .doc(tutorUid)
      .collection("privateNotes")
      .doc("note-1")
      .set({ text: "Private draft" });
    await harness.db
      .collection("users")
      .doc(tutorUid)
      .collection("privateNotes")
      .doc("note-1")
      .collection("revisions")
      .doc("rev-1")
      .set({ diff: "v1" });
    await harness.db
      .collection("users")
      .doc(tutorUid)
      .collection("workspacePreferences")
      .doc("pref-1")
      .set({ theme: "light" });

    // Course assigned via instructorId
    await harness.db.collection("courses").doc("course-inst-1").set({
      title: "Instructor Assigned Course",
      instructorId: tutorUid,
      tutorId: tutorUid,
      assignedTutors: [tutorUid],
      status: "published",
    });

    const result = await adminDeleteTutor({
      auth: { uid: "admin_1", token: { admin: true } },
      data: { targetUid: tutorUid, mode: "delete" },
    });

    expect(result.success).toBe(true);
    expect(result.deletionState).toBe("completed");
    expect(harness.authUsers.has(tutorUid)).toBe(false);

    // Verify all nested private user subcollections were deleted
    expect(
      (await harness.db.collection("users").doc(tutorUid).collection("privateNotes").doc("note-1").get()).exists
    ).toBe(false);
    expect(
      (
        await harness.db
          .collection("users")
          .doc(tutorUid)
          .collection("privateNotes")
          .doc("note-1")
          .collection("revisions")
          .doc("rev-1")
          .get()
      ).exists
    ).toBe(false);
    expect(
      (await harness.db.collection("users").doc(tutorUid).collection("workspacePreferences").doc("pref-1").get()).exists
    ).toBe(false);

    // Verify instructorId, tutorId, and assignedTutors were cleared on course
    const courseSnap = await harness.db.collection("courses").doc("course-inst-1").get();
    expect(courseSnap.data().instructorId).toBeNull();
    expect(courseSnap.data().tutorId).toBeNull();
    expect(courseSnap.data().assignedTutors).toEqual([]);

    // Verify archive record exists in deletedUsers
    const archiveSnap = await harness.db.collection("deletedUsers").doc(tutorUid).get();
    expect(archiveSnap.exists).toBe(true);
    expect(archiveSnap.data().regNumber).toBe("PK-2026-8888");
  });

  it("rolls back Firebase Auth changes if Firestore commit fails in adminSetAccountStatus and prevents restoring tutor privileges to deactivated tutors", async () => {
    const uid = "user_status_consistency";
    harness.authUsers.set(uid, {
      uid,
      email: "user@peleekings.com",
      disabled: false,
      customClaims: { tutor: true, cohort: "2026B" },
    });
    await harness.db.collection("users").doc(uid).set({
      uid,
      email: "user@peleekings.com",
      role: "tutor",
      status: "active",
      disabled: false,
    });

    // 1. Simulate Firestore batch failure during suspension (batch #1)
    harness.setFailBatchOnCallNumber(1);
    await expect(
      adminSetAccountStatus({
        auth: { uid: "admin_1", token: { admin: true } },
        data: { targetUid: uid, status: "suspended" },
      })
    ).rejects.toThrow(/rolled back/i);

    // Verify Auth state was automatically rolled back to its original enabled state + claims
    const authAfterRollback = harness.authUsers.get(uid);
    expect(authAfterRollback.disabled).toBe(false);
    expect(authAfterRollback.customClaims).toEqual({ tutor: true, cohort: "2026B" });

    const opAfterRollback = await harness.db.collection("accountStatusOperations").doc(uid).get();
    expect(opAfterRollback.data().state).toBe("rolled_back");

    // 2. Now succeed on suspension and verify unrelated custom claims are preserved
    harness.setFailBatchOnCallNumber(null);
    const suspendRes = await adminSetAccountStatus({
      auth: { uid: "admin_1", token: { admin: true } },
      data: { targetUid: uid, status: "suspended" },
    });
    expect(suspendRes.success).toBe(true);
    expect(harness.authUsers.get(uid).disabled).toBe(true);
    expect(harness.authUsers.get(uid).customClaims).toEqual({
      admin: false,
      cohort: "2026B",
      role: "student",
      suspended: true,
      tutor: false,
    });

    // 3. Mark the user as a deactivated tutor and verify reactivation does NOT restore tutor claim or role
    await harness.db.collection("users").doc(uid).set(
      {
        tutorStatus: "deactivated",
        tutorDeactivationState: "completed",
        previousRole: "tutor",
      },
      { merge: true }
    );

    const reactivateRes = await adminSetAccountStatus({
      auth: { uid: "admin_1", token: { admin: true } },
      data: { targetUid: uid, status: "active" },
    });
    expect(reactivateRes.success).toBe(true);
    expect(reactivateRes.role).toBe("student");
    expect(harness.authUsers.get(uid).disabled).toBe(false);
    expect(harness.authUsers.get(uid).customClaims.tutor).toBe(false);
    expect(harness.authUsers.get(uid).customClaims.cohort).toBe("2026B");

    const userAfterReactivate = await harness.db.collection("users").doc(uid).get();
    expect(userAfterReactivate.data().role).toBe("student");
    expect(userAfterReactivate.data().status).toBe("active");
  });

  it("recovers existing authoritative regNumbers reservations and rejects unverified caller-supplied regNumber claims", async () => {
    // 1. User already has an authoritative reservation in regNumbers, but users/{uid}.regNumber is missing
    const uidExisting = "user_recover_reg";
    await harness.db.collection("regNumbers").doc("BA9900A").set({
      uid: uidExisting,
      regNumber: "BA9900A",
      studentType: "corper",
    });
    await harness.db.collection("users").doc(uidExisting).set({
      uid: uidExisting,
      fullName: "Adaobi Bamidele",
      studentType: "corper",
      nyscStateCode: "FC/26A/9900",
    });

    const recoveredResult = await ensureUserRegNumber(uidExisting, {
      fullName: "Adaobi Bamidele",
      studentType: "corper",
      nyscStateCode: "FC/26A/9900",
    });
    expect(recoveredResult.regNumber).toBe("BA9900A");
    expect(recoveredResult.alreadyAssigned).toBe(true);
    expect(recoveredResult.repairedMapping).toBe(true);
    const repairedUserSnap = await harness.db.collection("users").doc(uidExisting).get();
    expect(repairedUserSnap.data().regNumber).toBe("BA9900A");

    // 2. Unverified caller-supplied data.regNumber belonging to someone else or unreserved is rejected
    const uidSpoof = "user_spoof_reg";
    await harness.db.collection("users").doc(uidSpoof).set({
      uid: uidSpoof,
      fullName: "Chinedu Okeke",
      studentType: "corper",
      nyscStateCode: "LA/26B/4321",
    });

    const allocatedResult = await ensureUserRegNumber(uidSpoof, {
      fullName: "Chinedu Okeke",
      studentType: "corper",
      nyscStateCode: "LA/26B/4321",
      regNumber: "BA9900A", // Attempting to claim uidExisting's code
    });
    expect(allocatedResult.regNumber).not.toBe("BA9900A");
    expect(allocatedResult.regNumber).toMatch(/^(OC|CO)4321$/);

    // Verify ownership in regNumbers
    const spoofRegSnap = await harness.db.collection("regNumbers").doc(allocatedResult.regNumber).get();
    expect(spoofRegSnap.exists).toBe(true);
    expect(spoofRegSnap.data().uid).toBe(uidSpoof);
  });
});

// ============================================================================
// 7. SECURITY RULES & PRODUCTION CONFIGURATION INVARIANTS
// ============================================================================
describe("7. Security Rules & Production Configuration Invariants", () => {
  const fs = require("node:fs");
  const path = require("node:path");

  it("enforces strict server-only write lockdown and custom-claim RBAC in firestore.rules and storage.rules", () => {
    const firestoreRules = fs.readFileSync(path.resolve(process.cwd(), "firestore.rules"), "utf8");
    const storageRules = fs.readFileSync(path.resolve(process.cwd(), "storage.rules"), "utf8");

    // Custom claim verification
    expect(firestoreRules).toContain("request.auth.token.admin == true");
    expect(firestoreRules).toContain("request.auth.token.tutor == true");

    // Server-controlled collections deny client writes
    for (const colName of [
      "regNumbers",
      "auditLogs",
      "courseDeletions",
      "tutorDeletionOperations",
      "deletedUsers",
      "accountStatusOperations",
      "broadcasts",
    ]) {
      expect(firestoreRules).toContain(`match /${colName}/`);
    }

    // Announcements rules support both get and list queries without failing on null expiresAt
    expect(firestoreRules).toContain("match /announcements/{announcementId}");
    expect(firestoreRules).toContain("allow get: if isAdmin() || (");
    expect(firestoreRules).toContain("allow list: if isAdmin() || (");

    // Deleting courses are blocked from non-admin access/mutation
    expect(firestoreRules).toContain("status != 'deleting'");

    // Storage rules enforce size limits, content-type validation, and separate delete rules
    expect(storageRules).toContain("request.resource != null");
    expect(storageRules).toContain("isValidSize(5)");
    expect(storageRules).toContain("isValidSize(50)");
  });

  it("validates firebase.json, firestore.indexes.json, and .env.example production readiness", () => {
    const firebaseJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "firebase.json"), "utf8")
    );
    const indexesJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "firestore.indexes.json"), "utf8")
    );
    const envExample = fs.readFileSync(path.resolve(process.cwd(), ".env.example"), "utf8");

    expect(firebaseJson.firestore.rules).toBe("firestore.rules");
    expect(firebaseJson.firestore.indexes).toBe("firestore.indexes.json");
    expect(firebaseJson.storage.rules).toBe("storage.rules");
    expect(firebaseJson.hosting.public).toBe("dist");
    expect(firebaseJson.hosting.rewrites).toEqual([
      { source: "**", destination: "/index.html" },
    ]);

    expect(Array.isArray(indexesJson.indexes)).toBe(true);
    expect(indexesJson.indexes.length).toBeGreaterThanOrEqual(4);

    expect(envExample).toContain("VITE_FIREBASE_API_KEY=");
    expect(envExample).toContain("VITE_FIREBASE_PROJECT_ID=");
    expect(envExample).toContain("VITE_FIREBASE_APPCHECK_SITE_KEY=");
    expect(typeof allocateRegistrationCode.__options?.enforceAppCheck).toBe("boolean");
    expect(typeof requestCourseEnrollment.__options?.enforceAppCheck).toBe("boolean");
  });
});

// ============================================================================
// 8. ANNOUNCEMENTS LIFECYCLE & BROADCAST DELIVERY REMEDIATION
// ============================================================================
describe("8. Announcements Lifecycle & Broadcast Delivery Remediation", () => {
  let harness;

  beforeEach(() => {
    harness = createStatefulFirebaseHarness();
    __setTestBindings({
      db: harness.db,
      admin: harness.admin,
    });
  });

  it("supports creating, editing, unpublishing (draft), republishing, and deleting announcements via adminPublishAnnouncement / adminManageAnnouncement", async () => {
    const adminAuth = { uid: "admin_ann", token: { admin: true, email: "admin@peleekings.com" } };

    // 1. Create published announcement
    const createRes = await adminPublishAnnouncement({
      auth: adminAuth,
      data: {
        action: "create",
        title: "Welcome to Cohort 2026B",
        body: "Orientation starts Monday at 10:00 AM WAT.",
        category: "Academic",
        priority: "urgent",
        audience: "all_learners",
        pinned: true,
        status: "published",
      },
    });

    expect(createRes.success).toBe(true);
    expect(createRes.action).toBe("create");
    expect(createRes.status).toBe("published");
    const annId = createRes.announcementId;
    expect(annId).toBeTruthy();

    const snapAfterCreate = await harness.db.collection("announcements").doc(annId).get();
    expect(snapAfterCreate.exists).toBe(true);
    expect(snapAfterCreate.data().title).toBe("Welcome to Cohort 2026B");
    expect(snapAfterCreate.data().audience).toBe("learners");
    expect(snapAfterCreate.data().pinned).toBe(true);

    // 2. Edit announcement and toggle to draft via adminManageAnnouncement alias
    const unpublishRes = await adminManageAnnouncement({
      auth: adminAuth,
      data: {
        action: "unpublish",
        announcementId: annId,
      },
    });
    expect(unpublishRes.success).toBe(true);
    expect(unpublishRes.status).toBe("draft");
    expect((await harness.db.collection("announcements").doc(annId).get()).data().status).toBe("draft");

    // 3. Update title & body and republish
    const updateRes = await adminPublishAnnouncement({
      auth: adminAuth,
      data: {
        action: "update",
        announcementId: annId,
        title: "Welcome to Cohort 2026B (Updated)",
        body: "Orientation starts Monday at 11:00 AM WAT.",
        status: "published",
      },
    });
    expect(updateRes.success).toBe(true);
    expect(updateRes.status).toBe("published");
    const snapAfterUpdate = await harness.db.collection("announcements").doc(annId).get();
    expect(snapAfterUpdate.data().title).toBe("Welcome to Cohort 2026B (Updated)");

    // 4. Delete announcement
    const deleteRes = await adminPublishAnnouncement({
      auth: adminAuth,
      data: {
        action: "delete",
        announcementId: annId,
      },
    });
    expect(deleteRes.success).toBe(true);
    expect((await harness.db.collection("announcements").doc(annId).get()).exists).toBe(false);
  });

  it("delivers broadcasts to targeted recipients, persists broadcasts/{id} history, and prevents duplicate sends within 60s", async () => {
    const adminAuth = { uid: "admin_bc", token: { admin: true, email: "admin@peleekings.com" } };

    // Seed active learners, a suspended learner, and an active tutor
    await harness.db.collection("users").doc("learner_1").set({
      uid: "learner_1",
      role: "student",
      status: "active",
      disabled: false,
    });
    await harness.db.collection("users").doc("learner_2").set({
      uid: "learner_2",
      role: "student",
      status: "active",
      disabled: false,
    });
    await harness.db.collection("users").doc("learner_suspended").set({
      uid: "learner_suspended",
      role: "student",
      status: "suspended",
      disabled: true,
    });
    await harness.db.collection("users").doc("tutor_1").set({
      uid: "tutor_1",
      role: "tutor",
      status: "active",
      disabled: false,
    });

    // 1. Broadcast to all_learners
    const bcRes = await adminSendBroadcast({
      auth: adminAuth,
      data: {
        targetType: "all_learners",
        title: "Assessment Portal Open",
        message: "Your Week 4 assessments are now open for submission.",
        type: "academic",
        link: "/dashboard",
      },
    });

    expect(bcRes.success).toBe(true);
    expect(bcRes.recipientCount).toBe(2); // Excludes suspended learner & tutor
    expect(bcRes.sentCount).toBe(2);
    expect(bcRes.failedCount).toBe(0);
    expect(bcRes.deliveryStatus).toBe("completed");
    expect(bcRes.broadcastId).toBeTruthy();

    // Verify broadcast history record in broadcasts/{broadcastId}
    const bcSnap = await harness.db.collection("broadcasts").doc(bcRes.broadcastId).get();
    expect(bcSnap.exists).toBe(true);
    expect(bcSnap.data().sentCount).toBe(2);
    expect(bcSnap.data().targetType).toBe("all_learners");
    expect(bcSnap.data().deliveryStatus).toBe("completed");

    // Verify per-user notifications were created for active learners only
    const l1Notifs = await harness.db.collection("users").doc("learner_1").collection("notifications").get();
    const l2Notifs = await harness.db.collection("users").doc("learner_2").collection("notifications").get();
    const suspNotifs = await harness.db.collection("users").doc("learner_suspended").collection("notifications").get();
    expect(l1Notifs.size).toBe(1);
    expect(l2Notifs.size).toBe(1);
    expect(suspNotifs.size).toBe(0);

    // 2. Duplicate broadcast submission with same payload within 60s window is blocked
    await expect(
      adminSendNotification({
        auth: adminAuth,
        data: {
          targetType: "all_learners",
          title: "Assessment Portal Open",
          message: "Your Week 4 assessments are now open for submission.",
          type: "academic",
        },
      })
    ).rejects.toThrow(/duplicate broadcast/i);
  });

  it("gracefully falls back to individual delivery if a batch commit fails during adminSendNotification", async () => {
    const adminAuth = { uid: "admin_bc_fallback", token: { admin: true, email: "admin@peleekings.com" } };

    await harness.db.collection("users").doc("tutor_a").set({
      uid: "tutor_a",
      role: "tutor",
      status: "active",
      disabled: false,
    });
    await harness.db.collection("users").doc("tutor_b").set({
      uid: "tutor_b",
      role: "tutor",
      status: "active",
      disabled: false,
    });

    // Simulate batch commit failure on batch #1 so the function falls back to individual doc sets
    harness.setFailBatchOnCallNumber(1);

    const res = await adminSendNotification({
      auth: adminAuth,
      data: {
        targetType: "all_tutors",
        title: "Grading Deadline Reminder",
        message: "Please finalize all module grading by Friday 5 PM.",
        type: "system",
      },
    });

    expect(res.success).toBe(true);
    expect(res.sentCount).toBe(2);
    expect(res.failedCount).toBe(0);
    expect(res.deliveryStatus).toBe("completed");
  });

  it("exports separate onEnrollmentWrite, onTestSubmissionWrite, and onAssignmentSubmissionWrite triggers and skips enrollment recompute when only updatedAt or lastAccessedLesson changed", async () => {
    expect(typeof onEnrollmentWrite).toBe("function");
    expect(typeof onTestSubmissionWrite).toBe("function");
    expect(typeof onAssignmentSubmissionWrite).toBe("function");
    expect(functionsModule.onEnrollmentOrSubmissionWrite).toBeUndefined();

    const courseId = "course_trig_1";
    await harness.db.collection("courses").doc(courseId).set({
      id: courseId,
      title: "Trigger Test Course",
      status: "published",
    });
    await harness.db.collection("enrollments").doc("u1_course_trig_1").set({
      uid: "u1",
      courseId,
      status: "active",
      progressPercent: 20,
      completedItemIds: ["l1"],
      lastAccessedLesson: "l1",
      updatedAt: "t1",
    });

    // 1. Update where ONLY updatedAt and lastAccessedLesson changed -> should skip recompute
    harness.operationTimeline.length = 0;
    await onEnrollmentWrite({
      data: {
        before: {
          exists: true,
          data: () => ({
            uid: "u1",
            courseId,
            status: "active",
            progressPercent: 20,
            completedItemIds: ["l1"],
            lastAccessedLesson: "l1",
            updatedAt: "t1",
          }),
        },
        after: {
          exists: true,
          data: () => ({
            uid: "u1",
            courseId,
            status: "active",
            progressPercent: 20,
            completedItemIds: ["l1"],
            lastAccessedLesson: "l2",
            updatedAt: "t2",
          }),
        },
      },
    });
    expect(
      harness.operationTimeline.some((entry) => entry.includes(`courses/${courseId}/analytics/summary`))
    ).toBe(false);

    // 2. Update where completedItemIds changed -> should recompute progressPercent and analytics
    await harness.db.collection("courses").doc(courseId).collection("lessons").doc("l1").set({ title: "L1" });
    await harness.db.collection("courses").doc(courseId).collection("lessons").doc("l2").set({ title: "L2" });
    await harness.db.collection("courses").doc(courseId).collection("lessons").doc("l3").set({ title: "L3" });
    await harness.db.collection("courses").doc(courseId).collection("lessons").doc("l4").set({ title: "L4" });

    await onEnrollmentWrite({
      params: { docId: "u1_course_trig_1" },
      data: {
        before: {
          exists: true,
          data: () => ({
            uid: "u1",
            courseId,
            status: "active",
            progressPercent: 25,
            completedItemIds: ["l1"],
            lastAccessedLesson: "l1",
            updatedAt: "t1",
          }),
        },
        after: {
          exists: true,
          data: () => ({
            uid: "u1",
            courseId,
            status: "active",
            progressPercent: 25,
            completedItemIds: ["l1", "l2"],
            lastAccessedLesson: "l2",
            updatedAt: "t2",
          }),
        },
      },
    });
    expect(
      harness.operationTimeline.some((entry) => entry.includes(`courses/${courseId}/analytics/summary`))
    ).toBe(true);
    expect(harness.docs.get("enrollments/u1_course_trig_1")?.progressPercent).toBe(50);

    // 3. Subsequent trigger firing from the progressPercent write itself is skipped (no loop)
    harness.operationTimeline.length = 0;
    await onEnrollmentWrite({
      params: { docId: "u1_course_trig_1" },
      data: {
        before: {
          exists: true,
          data: () => ({
            uid: "u1",
            courseId,
            status: "active",
            progressPercent: 25,
            completedItemIds: ["l1", "l2"],
            lastAccessedLesson: "l2",
            updatedAt: "t2",
          }),
        },
        after: {
          exists: true,
          data: () => ({
            uid: "u1",
            courseId,
            status: "active",
            progressPercent: 50,
            completedItemIds: ["l1", "l2"],
            lastAccessedLesson: "l2",
            updatedAt: "t2",
          }),
        },
      },
    });
    expect(harness.operationTimeline.length).toBe(0);
  });

  it("strips correctIndex/explanation into testKeys on seedCatalog and migrateTestKeys, and scores submitTest server-side without returning the answer key", async () => {
    const adminAuth = { uid: "admin_1", token: { admin: true } };
    // 1. Seed a course with a test via seedCatalog
    const seedRes = await adminManageCourse({
      auth: adminAuth,
      data: {
        action: "seedCatalog",
        courses: [
          {
            id: "course-sec-test",
            title: "Security Testing 101",
            curriculum: {
              modules: [
                {
                  id: "m1",
                  title: "Module 1",
                  order: 1,
                  lessons: [
                    {
                      id: "quiz-1",
                      title: "Quiz 1",
                      type: "test",
                      passingScore: 60,
                      questions: [
                        {
                          question: "Q1?",
                          options: ["A", "B", "C", "D"],
                          correctIndex: 2,
                          explanation: "Secret explanation 1",
                        },
                        {
                          question: "Q2?",
                          options: ["W", "X", "Y", "Z"],
                          correctIndex: 1,
                          explanation: "Secret explanation 2",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    });
    expect(seedRes.success).toBe(true);

    // Verify courses/course-sec-test/tests/quiz-1 has NO correctIndex or explanation
    const storedTest = harness.docs.get("courses/course-sec-test/tests/quiz-1");
    expect(storedTest.questions).toHaveLength(2);
    expect(storedTest.questions[0].correctIndex).toBeUndefined();
    expect(storedTest.questions[0].explanation).toBeUndefined();

    // Verify courses/course-sec-test/testKeys/quiz-1 holds the answer key
    const storedKey = harness.docs.get("courses/course-sec-test/testKeys/quiz-1");
    expect(storedKey.answers).toEqual([2, 1]);
    expect(storedKey.passingScore).toBe(60);

    // 2. Test migrateTestKeys on an existing legacy test doc that still has correctIndex
    await harness.db.collection("courses").doc("course-sec-test").collection("tests").doc("legacy-quiz").set({
      title: "Legacy Quiz",
      type: "test",
      questions: [
        { question: "Legacy Q?", options: ["0", "1"], correctIndex: 1, explanation: "Legacy exp" },
      ],
    });
    const migRes = await migrateTestKeys({
      auth: adminAuth,
      data: { courseId: "course-sec-test" },
    });
    expect(migRes.success).toBe(true);
    expect(harness.docs.get("courses/course-sec-test/tests/legacy-quiz").questions[0].correctIndex).toBeUndefined();
    expect(harness.docs.get("courses/course-sec-test/testKeys/legacy-quiz").answers).toEqual([1]);

    // 3. Verify submitTest rejects unenrolled students and scores enrolled students server-side
    await harness.db.collection("users").doc("student_quiz").set({
      uid: "student_quiz",
      fullName: "Ada Lovelace",
      regNumber: "AL1234",
      status: "active",
    });

    await expect(
      submitTest({
        auth: { uid: "student_quiz", token: {} },
        data: { courseId: "course-sec-test", testId: "quiz-1", answers: { 0: 2, 1: 1 } },
      })
    ).rejects.toThrow(/enrollment/i);

    await harness.db.collection("enrollments").doc("student_quiz_course-sec-test").set({
      uid: "student_quiz",
      courseId: "course-sec-test",
      status: "active",
    });

    const attempt1 = await submitTest({
      auth: { uid: "student_quiz", token: {} },
      data: { courseId: "course-sec-test", testId: "quiz-1", answers: { 0: 2, 1: 0 } },
    });
    expect(attempt1).toEqual({ score: 50, passed: false, attempt: 1 });
    expect(attempt1.answers).toBeUndefined();

    const attempt2 = await submitTest({
      auth: { uid: "student_quiz", token: {} },
      data: { courseId: "course-sec-test", testId: "quiz-1", answers: { 0: 2, 1: 1 } },
    });
    expect(attempt2).toEqual({ score: 100, passed: true, attempt: 2 });

    const savedSubmission = harness.docs.get("testSubmissions/student_quiz_quiz-1");
    expect(savedSubmission).toMatchObject({
      uid: "student_quiz",
      courseId: "course-sec-test",
      testId: "quiz-1",
      score: 100,
      passed: true,
      attempt: 2,
      studentName: "Ada Lovelace",
      regNumber: "AL1234",
      status: "graded",
    });
  });

  it("allows assigned tutors to submit a draft course for review via requestCoursePublish and denies unassigned tutors", async () => {
    await harness.db.collection("courses").doc("tutor-draft-1").set({
      id: "tutor-draft-1",
      title: "Cloud Architecture 101",
      tutorId: "tutor_owner",
      assignedTutors: ["tutor_owner"],
      status: "draft",
    });

    // Unassigned tutor cannot request publish
    await expect(
      requestCoursePublish({
        auth: { uid: "tutor_other", token: { tutor: true } },
        data: { courseId: "tutor-draft-1" },
      })
    ).rejects.toThrow(/not an assigned tutor/i);

    // Assigned tutor sets status to pending_review and writes audit log
    const res = await requestCoursePublish({
      auth: { uid: "tutor_owner", token: { tutor: true } },
      data: { courseId: "tutor-draft-1" },
    });
    expect(res).toEqual({
      success: true,
      courseId: "tutor-draft-1",
      status: "pending_review",
    });
    expect(harness.docs.get("courses/tutor-draft-1")?.status).toBe("pending_review");
    expect(harness.docs.get("courses/tutor-draft-1")?.publishRequestedBy).toBe("tutor_owner");
  });

  it("enforces course-specific announcement validation on publish and filters/sorts learner announcements accurately", async () => {
    const adminAuth = { uid: "admin_ann_course", token: { admin: true } };

    // Publishing a course announcement for a non-existent or deleting course is rejected
    await expect(
      adminPublishAnnouncement({
        auth: adminAuth,
        data: {
          title: "Missing Course Notice",
          body: "Should fail",
          audience: "course",
          courseId: "non_existent_course",
        },
      })
    ).rejects.toThrow(/not found|deleting/i);

    await harness.db.collection("courses").doc("course_deleting").set({
      id: "course_deleting",
      title: "Deleting Course",
      status: "deleting",
    });

    await expect(
      adminPublishAnnouncement({
        auth: adminAuth,
        data: {
          title: "Deleting Course Notice",
          body: "Should fail",
          audience: "course",
          courseId: "course_deleting",
        },
      })
    ).rejects.toThrow(/not found|deleting/i);

    // Publishing for a valid course succeeds
    await harness.db.collection("courses").doc("course_valid").set({
      id: "course_valid",
      title: "Valid Published Course",
      status: "published",
    });

    const pubRes = await adminPublishAnnouncement({
      auth: adminAuth,
      data: {
        title: "Course Valid Workshop",
        body: "Starts tomorrow",
        audience: "course",
        courseId: "course_valid",
        pinned: true,
      },
    });
    expect(pubRes.success).toBe(true);

    // Verify learner announcement filtering & sorting helper
    const nowMs = Date.now();
    const rawAnnouncements = [
      {
        id: "a_general_older",
        title: "General Older",
        status: "published",
        audience: "all",
        pinned: false,
        createdAt: new Date(nowMs - 60000).toISOString(),
      },
      {
        id: "a_course_authorized_pinned",
        title: "Enrolled Course Pinned",
        status: "published",
        audience: "course",
        courseId: "course_valid",
        pinned: true,
        createdAt: new Date(nowMs - 120000).toISOString(),
      },
      {
        id: "a_course_unenrolled",
        title: "Unenrolled Course",
        status: "published",
        audience: "course",
        courseId: "course_other",
        pinned: true,
        createdAt: new Date(nowMs).toISOString(),
      },
      {
        id: "a_course_invalid_id",
        title: "Invalid Course ID",
        status: "published",
        audience: "course",
        courseId: "general",
        createdAt: new Date(nowMs).toISOString(),
      },
      {
        id: "a_expired",
        title: "Expired Notice",
        status: "published",
        audience: "learners",
        expiresAt: new Date(nowMs - 1000).toISOString(),
        createdAt: new Date(nowMs).toISOString(),
      },
      {
        id: "a_draft",
        title: "Draft Notice",
        status: "draft",
        audience: "learners",
        createdAt: new Date(nowMs).toISOString(),
      },
    ];

    const filteredForEnrolled = filterAndSortLearnerAnnouncements(
      rawAnnouncements,
      new Set(["course_valid"]),
      nowMs
    );
    expect(filteredForEnrolled.map((a) => a.id)).toEqual([
      "a_course_authorized_pinned",
      "a_general_older",
    ]);

    const filteredForUnenrolled = filterAndSortLearnerAnnouncements(
      rawAnnouncements,
      new Set(),
      nowMs
    );
    expect(filteredForEnrolled.length).toBe(2);
    expect(filteredForUnenrolled.map((a) => a.id)).toEqual(["a_general_older"]);
  });

  it("enforces search catalogue integrity: returns empty when Firestore is empty or contains only unpublished/deleting courses, and never leaks static catalogue courses", () => {
    const staticCatalog = [
      { id: "ai-fundamentals", title: "Static AI Fundamentals", badgeClass: "pill-ai", rating: "4.9" },
      { id: "ui-ux-mastery", title: "Static UI/UX Mastery", badgeClass: "pill-design", rating: "4.8" },
    ];

    // 1. Empty Firestore -> empty results (never returns staticCatalog)
    expect(buildAuthoritativeSearchCourses([], staticCatalog)).toEqual([]);
    expect(buildAuthoritativeSearchCourses(null, staticCatalog)).toEqual([]);

    // 2. Firestore contains only draft, deleting, deleted, or pending_review courses -> empty results
    const nonLiveDocs = [
      { id: "ai-fundamentals", data: () => ({ status: "draft", title: "Draft AI" }) },
      { id: "ui-ux-mastery", data: () => ({ status: "deleting", title: "Deleting UI" }) },
      { id: "c3", data: () => ({ status: "published", deletionState: "deleting", title: "Deleting State" }) },
      { id: "c4", data: () => ({ status: "published", deleted: true, title: "Deleted Flag" }) },
      { id: "c5", data: () => ({ status: "pending_review", title: "Pending Review" }) },
    ];
    expect(buildAuthoritativeSearchCourses(nonLiveDocs, staticCatalog)).toEqual([]);

    // 3. Firestore contains one published course matching static metadata + one custom published course
    const liveDocs = [
      { id: "ai-fundamentals", data: () => ({ status: "published", title: "Live AI Fundamentals" }) },
      { id: "custom-cloud-101", data: () => ({ status: "published", title: "Custom Cloud 101" }) },
      { id: "ui-ux-mastery", data: () => ({ status: "draft", title: "Unpublished UI/UX" }) },
    ];
    const results = buildAuthoritativeSearchCourses(liveDocs, staticCatalog);
    expect(results.map((c) => c.id)).toEqual(["ai-fundamentals", "custom-cloud-101"]);
    // Uses static display metadata fallback (badgeClass, rating) ONLY for verified published course
    expect(results[0].badgeClass).toBe("pill-ai");
    expect(results[0].rating).toBe("4.9");
    expect(results[0].title).toBe("Live AI Fundamentals");
  });

  it("paginates broadcasts beyond 500 recipients in bounded batches (<= 350 writes) across all audience types while excluding suspended and deleted accounts", async () => {
    const adminAuth = { uid: "admin_scale", token: { admin: true, email: "admin@peleekings.com" } };

    // Seed 620 active learners, 5 suspended learners, and 5 deleted learners (> 500 recipient threshold)
    for (let i = 1; i <= 620; i++) {
      const uid = `student_${String(i).padStart(4, "0")}`;
      harness.docs.set(`users/${uid}`, {
        uid,
        role: "student",
        status: "active",
        disabled: false,
      });
    }
    for (let i = 1; i <= 5; i++) {
      const uid = `student_susp_${i}`;
      harness.docs.set(`users/${uid}`, {
        uid,
        role: "student",
        status: "suspended",
        disabled: true,
      });
    }
    for (let i = 1; i <= 5; i++) {
      const uid = `student_del_${i}`;
      harness.docs.set(`users/${uid}`, {
        uid,
        role: "student",
        status: "active",
      });
      harness.docs.set(`deletedUsers/${uid}`, {
        uid,
        deletionState: "completed",
      });
    }

    harness.committedBatchSizes.length = 0;
    const res = await adminSendBroadcast({
      auth: adminAuth,
      data: {
        targetType: "all_learners",
        title: "Platform-Wide Semester Kickoff",
        message: "Welcome all 620+ active learners to the new semester!",
        idempotencyKey: "kickoff_620_learners",
      },
    });

    expect(res.success).toBe(true);
    expect(res.totalRecipients).toBe(620);
    expect(res.deliveredCount).toBe(620);
    expect(res.failedCount).toBe(0);
    expect(res.status).toBe("completed");

    // Verify bounded Firestore batches: 620 writes must be split into 2 batches of 350 and 270 (both <= 350)
    expect(harness.committedBatchSizes).toEqual([350, 270]);
    harness.committedBatchSizes.forEach((size) => {
      expect(size).toBeLessThanOrEqual(350);
    });

    // Verify first and 620th learner both received the notification, while suspended/deleted did not
    expect(
      harness.docs.has(`users/student_0001/notifications/bcast_${res.broadcastId}`)
    ).toBe(true);
    expect(
      harness.docs.has(`users/student_0620/notifications/bcast_${res.broadcastId}`)
    ).toBe(true);
    expect(
      harness.docs.has(`users/student_susp_1/notifications/bcast_${res.broadcastId}`)
    ).toBe(false);
    expect(
      harness.docs.has(`users/student_del_1/notifications/bcast_${res.broadcastId}`)
    ).toBe(false);

    // Also verify course-targeted broadcast validates course existence and filters out non-active enrollments & suspended users
    await expect(
      adminSendBroadcast({
        auth: adminAuth,
        data: {
          targetType: "course",
          courseId: "missing_course_999",
          title: "Course Notice",
          message: "Body",
        },
      })
    ).rejects.toThrow(/does not exist/i);

    await harness.db.collection("courses").doc("course_bcast_1").set({
      id: "course_bcast_1",
      title: "Broadcast Course",
      status: "published",
    });
    await harness.db.collection("enrollments").doc("student_0001_course_bcast_1").set({
      uid: "student_0001",
      courseId: "course_bcast_1",
      status: "active",
    });
    await harness.db.collection("enrollments").doc("student_0002_course_bcast_1").set({
      uid: "student_0002",
      courseId: "course_bcast_1",
      status: "approved",
    });
    await harness.db.collection("enrollments").doc("student_0003_course_bcast_1").set({
      uid: "student_0003",
      courseId: "course_bcast_1",
      status: "pending",
    });
    await harness.db.collection("enrollments").doc("student_susp_1_course_bcast_1").set({
      uid: "student_susp_1",
      courseId: "course_bcast_1",
      status: "active",
    });

    const courseBcastRes = await adminSendBroadcast({
      auth: adminAuth,
      data: {
        targetType: "course",
        courseId: "course_bcast_1",
        title: "Course Cohort Update",
        message: "Only active/approved eligible learners in course_bcast_1 receive this.",
      },
    });
    expect(courseBcastRes.totalRecipients).toBe(2);
    expect(courseBcastRes.deliveredCount).toBe(2);
  });

  it("prevents simultaneous duplicate broadcast submissions via atomic reservation while preserving retries and new idempotency keys", async () => {
    const adminAuth = { uid: "admin_concurrent", token: { admin: true, email: "admin@peleekings.com" } };

    await harness.db.collection("users").doc("u_conc_1").set({
      uid: "u_conc_1",
      role: "student",
      status: "active",
    });
    await harness.db.collection("users").doc("u_conc_2").set({
      uid: "u_conc_2",
      role: "student",
      status: "active",
    });

    // 1. Fire two simultaneous identical broadcast requests with the same idempotencyKey
    const [r1, r2] = await Promise.allSettled([
      adminSendBroadcast({
        auth: adminAuth,
        data: {
          targetType: "all_learners",
          title: "Concurrent Broadcast Test",
          message: "Fired simultaneously",
          idempotencyKey: "concurrent_key_1",
        },
      }),
      adminSendBroadcast({
        auth: adminAuth,
        data: {
          targetType: "all_learners",
          title: "Concurrent Broadcast Test",
          message: "Fired simultaneously",
          idempotencyKey: "concurrent_key_1",
        },
      }),
    ]);

    const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
    const rejected = [r1, r2].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason?.message).toMatch(/duplicate broadcast/i);

    // Recipient received exactly 1 notification, not 2
    const u1Notifs = await harness.db.collection("users").doc("u_conc_1").collection("notifications").get();
    expect(u1Notifs.size).toBe(1);

    // 2. Sending with a new idempotencyKey succeeds
    const rNewKey = await adminSendBroadcast({
      auth: adminAuth,
      data: {
        targetType: "all_learners",
        title: "Concurrent Broadcast Test",
        message: "Fired simultaneously",
        idempotencyKey: "concurrent_key_2",
      },
    });
    expect(rNewKey.success).toBe(true);

    // 3. Partial delivery failure & idempotent retry without duplicating already-processed recipients
    // Force batch #1 to fail so fallback runs per-user, and force u_conc_2's notification write to fail on attempt 1
    harness.setFailBatchOnCallNumber(1);
    // Find the deterministic reservation/broadcast ID by running attempt 1 where u_conc_2 fails
    const originalUserDoc = harness.db.collection;
    let failSecondUserOnce = true;
    const origSet = harness.docs.set.bind(harness.docs);
    harness.docs.set = (k, v) => {
      if (failSecondUserOnce && k.startsWith("users/u_conc_2/notifications/bcast_")) {
        throw new Error("Simulated per-recipient write error for u_conc_2");
      }
      return origSet(k, v);
    };

    let partialRes;
    try {
      partialRes = await adminSendBroadcast({
        auth: adminAuth,
        data: {
          targetType: "all_learners",
          title: "Retryable Broadcast",
          message: "Testing partial failure recovery",
          idempotencyKey: "retry_key_partial_1",
        },
      });
    } finally {
      failSecondUserOnce = false;
      harness.docs.set = origSet;
      harness.setFailBatchOnCallNumber(null);
    }

    expect(partialRes.status).toBe("partial_failure");
    expect(partialRes.deliveredCount).toBe(1);
    expect(partialRes.failedCount).toBe(1);

    // Verify u_conc_1 got the notification on attempt 1, u_conc_2 did not
    const bcastId = partialRes.broadcastId;
    expect(harness.docs.has(`users/u_conc_1/notifications/bcast_${bcastId}`)).toBe(true);
    expect(harness.docs.has(`users/u_conc_2/notifications/bcast_${bcastId}`)).toBe(false);

    // Now retry with the SAME idempotencyKey: should resume the same broadcastId, skip u_conc_1, and deliver to u_conc_2
    const retryRes = await adminSendBroadcast({
      auth: adminAuth,
      data: {
        targetType: "all_learners",
        title: "Retryable Broadcast",
        message: "Testing partial failure recovery",
        idempotencyKey: "retry_key_partial_1",
      },
    });

    expect(retryRes.broadcastId).toBe(bcastId);
    expect(retryRes.status).toBe("completed");
    expect(retryRes.totalRecipients).toBe(2);
    expect(retryRes.deliveredCount).toBe(2);
    expect(retryRes.failedCount).toBe(0);
    expect(harness.docs.has(`users/u_conc_2/notifications/bcast_${bcastId}`)).toBe(true);

    // Ensure u_conc_1 still has only 1 notification for this broadcast (no duplicate created on retry)
    const u1AllNotifs = await harness.db.collection("users").doc("u_conc_1").collection("notifications").get();
    const matchingBcastNotifs = u1AllNotifs.docs.filter((d) => d.data()?.broadcastId === bcastId);
    expect(matchingBcastNotifs).toHaveLength(1);
    void originalUserDoc;
  });
});






