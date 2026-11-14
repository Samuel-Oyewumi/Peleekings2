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
      onCall: (handler) => {
        const fn = async (req) => handler(req);
        fn.run = handler;
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
  deleteSubcollectionsRecursively,
  isAuthorizedCourseStoragePath,
  adminDeleteTutor,
  adminManageCourse,
} = functionsModule;

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
  let failListCollectionsForPaths = new Set();
  let disableListCollectionsMethod = false;
  let failStoragePrefixError = null;
  let failAuthDeleteError = null;

  function normalizePath(p) {
    return String(p || "").replace(/^\/+|\/+$/g, "");
  }

  function cloneValue(val) {
    if (val === null || val === undefined || typeof val !== "object") return val;
    if (Array.isArray(val)) return val.map(cloneValue);
    return { ...val };
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

  function createQuery(colPath, filters = [], limitCount = null) {
    const normalizedCol = normalizePath(colPath);
    const prefix = `${normalizedCol}/`;

    const queryObj = {
      where(field, op, value) {
        return createQuery(normalizedCol, [...filters, { field, op, value }], limitCount);
      },
      limit(n) {
        return createQuery(normalizedCol, filters, n);
      },
      async get() {
        const matchedDocs = [];
        for (const [docPath, docData] of docs.entries()) {
          if (!docPath.startsWith(prefix)) continue;
          const remainder = docPath.slice(prefix.length);
          // Direct child documents only (no slash in remainder)
          if (remainder.includes("/")) continue;

          const passes = filters.every(({ field, op, value }) => {
            const fieldVal = docData[field];
            if (op === "==") return fieldVal === value;
            if (op === "array-contains") {
              return Array.isArray(fieldVal) && fieldVal.includes(value);
            }
            return false;
          });

          if (passes) {
            const dRef = createDocRef(docPath);
            matchedDocs.push(createDocSnap(dRef));
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
        fromDate: (d) => d.toISOString(),
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
