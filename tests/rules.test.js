import fs from "node:fs";
import path from "node:path";
import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from "@firebase/rules-unit-testing";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";
import {
  ref,
  uploadBytes,
  getBytes,
  deleteObject,
} from "firebase/storage";
import {
  getFarFutureExpiresAtTimestamp,
  buildGlobalLearnerAnnouncementsQuery,
  buildCourseLearnerAnnouncementsQuery,
  buildTutorAnnouncementsQuery,
} from "../src/utils/courseCatalogue";

const PROJECT_ID = "peleekings-lms-test";

describe("Peleekings LMS — Firestore & Storage Security Rules Suite", () => {
  let testEnv;

  beforeAll(async () => {
    const firestoreRules = fs.readFileSync(
      path.resolve(process.cwd(), "firestore.rules"),
      "utf8"
    );
    const storageRules = fs.readFileSync(
      path.resolve(process.cwd(), "storage.rules"),
      "utf8"
    );

    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: "127.0.0.1",
        port: 8080,
        rules: firestoreRules,
      },
      storage: {
        host: "127.0.0.1",
        port: 9199,
        rules: storageRules,
      },
    });
  });

  afterAll(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    await testEnv.clearStorage();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 1. PUBLIC CATALOG
  // ══════════════════════════════════════════════════════════════════════════
  describe("1. Public Catalog & Subcollection Protection", () => {
    beforeEach(async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const adminDb = context.firestore();
        await setDoc(doc(adminDb, "courses", "pub-course"), {
          id: "pub-course",
          title: "AI Essentials & Automation",
          status: "published",
          tutorId: "tutor_assigned",
          assignedTutors: ["tutor_assigned"],
        });
        await setDoc(doc(adminDb, "courses", "draft-course"), {
          id: "draft-course",
          title: "Unreleased Quantum Computing",
          status: "draft",
          tutorId: "tutor_assigned",
          assignedTutors: ["tutor_assigned"],
        });
        await setDoc(doc(adminDb, "courses", "pub-course", "modules", "m1"), {
          title: "Module 1: Foundations",
          order: 1,
        });
        await setDoc(doc(adminDb, "courses", "pub-course", "lessons", "l1"), {
          title: "Lesson 1: Intro",
          moduleId: "m1",
          order: 1,
        });
      });
    });

    it("allows unauthenticated guests to read published courses", async () => {
      const guestDb = testEnv.unauthenticatedContext().firestore();
      await assertSucceeds(getDoc(doc(guestDb, "courses", "pub-course")));
    });

    it("denies unauthenticated guests and ordinary learners from reading draft courses", async () => {
      const guestDb = testEnv.unauthenticatedContext().firestore();
      const learnerDb = testEnv.authenticatedContext("student_1").firestore();
      const unassignedTutorDb = testEnv
        .authenticatedContext("tutor_other", { tutor: true })
        .firestore();

      await assertFails(getDoc(doc(guestDb, "courses", "draft-course")));
      await assertFails(getDoc(doc(learnerDb, "courses", "draft-course")));
      await assertFails(getDoc(doc(unassignedTutorDb, "courses", "draft-course")));
    });

    it("allows admins and assigned tutors to read draft courses", async () => {
      const assignedTutorDb = testEnv
        .authenticatedContext("tutor_assigned", { tutor: true })
        .firestore();
      const adminDb = testEnv
        .authenticatedContext("admin_1", { admin: true })
        .firestore();

      await assertSucceeds(getDoc(doc(assignedTutorDb, "courses", "draft-course")));
      await assertSucceeds(getDoc(doc(adminDb, "courses", "draft-course")));
    });

    it("denies unauthenticated access to course curriculum subcollections", async () => {
      const guestDb = testEnv.unauthenticatedContext().firestore();
      await assertFails(
        getDoc(doc(guestDb, "courses", "pub-course", "modules", "m1"))
      );
      await assertFails(
        getDoc(doc(guestDb, "courses", "pub-course", "lessons", "l1"))
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. ENROLLMENT SECURITY
  // ══════════════════════════════════════════════════════════════════════════
  describe("2. Student Enrollment Security", () => {
    beforeEach(async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const adminDb = context.firestore();
        await setDoc(doc(adminDb, "courses", "pub-course"), {
          id: "pub-course",
          title: "AI Essentials & Automation",
          status: "published",
        });
      });
    });

    it("allows a student to create a pending enrollment request with progressPercent: 0 and no privileged fields", async () => {
      const studentDb = testEnv.authenticatedContext("student_1").firestore();
      await assertSucceeds(
        setDoc(doc(studentDb, "enrollments", "student_1_pub-course"), {
          uid: "student_1",
          courseId: "pub-course",
          status: "pending",
          progressPercent: 0,
          completedItemIds: [],
          enrolledAt: serverTimestamp(),
        })
      );
    });

    it("denies a student from self-activating enrollment with status: 'active' or 'approved'", async () => {
      const studentDb = testEnv.authenticatedContext("student_1").firestore();
      await assertFails(
        setDoc(doc(studentDb, "enrollments", "student_1_pub-course"), {
          uid: "student_1",
          courseId: "pub-course",
          status: "active",
          progressPercent: 0,
          completedItemIds: [],
        })
      );
      await assertFails(
        setDoc(doc(studentDb, "enrollments", "student_1_pub-course"), {
          uid: "student_1",
          courseId: "pub-course",
          status: "approved",
          progressPercent: 0,
          completedItemIds: [],
        })
      );
    });

    it("denies a student from injecting privileged payment or approval fields on enrollment creation", async () => {
      const studentDb = testEnv.authenticatedContext("student_1").firestore();
      await assertFails(
        setDoc(doc(studentDb, "enrollments", "student_1_pub-course"), {
          uid: "student_1",
          courseId: "pub-course",
          status: "pending",
          progressPercent: 0,
          isPaid: true,
          paymentStatus: "paid",
        })
      );
      await assertFails(
        setDoc(doc(studentDb, "enrollments", "student_1_pub-course"), {
          uid: "student_1",
          courseId: "pub-course",
          status: "pending",
          progressPercent: 0,
          approvedBy: "admin_1",
        })
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. CLASSROOM ACCESS
  // ══════════════════════════════════════════════════════════════════════════
  describe("3. Classroom Access & Learning Progress Updates", () => {
    beforeEach(async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const adminDb = context.firestore();
        await setDoc(doc(adminDb, "courses", "pub-course"), {
          id: "pub-course",
          title: "AI Essentials & Automation",
          status: "published",
        });
        await setDoc(doc(adminDb, "courses", "pub-course", "modules", "m1"), {
          title: "Module 1",
          order: 1,
        });
        await setDoc(doc(adminDb, "enrollments", "student_active_pub-course"), {
          uid: "student_active",
          courseId: "pub-course",
          status: "active",
          progressPercent: 0,
          completedItemIds: [],
        });
        await setDoc(doc(adminDb, "enrollments", "student_pending_pub-course"), {
          uid: "student_pending",
          courseId: "pub-course",
          status: "pending",
          progressPercent: 0,
          completedItemIds: [],
        });
      });
    });

    it("allows actively enrolled students to read course modules and update lesson progress (without progressPercent)", async () => {
      const activeStudentDb = testEnv
        .authenticatedContext("student_active")
        .firestore();

      await assertSucceeds(
        getDoc(doc(activeStudentDb, "courses", "pub-course", "modules", "m1"))
      );
      await assertSucceeds(
        updateDoc(doc(activeStudentDb, "enrollments", "student_active_pub-course"), {
          completedItemIds: ["ai_l1", "ai_l2"],
          lastAccessedLesson: "ai_l2",
          updatedAt: serverTimestamp(),
        })
      );
    });

    it("(a) denies a student from creating a testSubmission directly", async () => {
      const activeStudentDb = testEnv
        .authenticatedContext("student_active")
        .firestore();

      await assertFails(
        setDoc(doc(activeStudentDb, "testSubmissions", "student_active_t1"), {
          uid: "student_active",
          courseId: "pub-course",
          testId: "t1",
          answers: { 0: 1 },
          score: 100,
          status: "submitted",
        })
      );
    });

    it("(b) denies a student from writing progressPercent on enrollments", async () => {
      const activeStudentDb = testEnv
        .authenticatedContext("student_active")
        .firestore();

      await assertFails(
        updateDoc(doc(activeStudentDb, "enrollments", "student_active_pub-course"), {
          completedItemIds: ["ai_l1"],
          progressPercent: 100,
          updatedAt: serverTimestamp(),
        })
      );
    });

    it("(c) denies a student from reading testKeys", async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const adminDb = context.firestore();
        await setDoc(doc(adminDb, "courses", "pub-course", "testKeys", "t1"), {
          answers: [1, 2, 0],
          passingScore: 60,
        });
      });

      const activeStudentDb = testEnv
        .authenticatedContext("student_active")
        .firestore();

      await assertFails(
        getDoc(doc(activeStudentDb, "courses", "pub-course", "testKeys", "t1"))
      );
    });

    it("(d) allows an assigned tutor to read and write testKeys of their own course, but not another tutor's course", async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const adminDb = context.firestore();
        await setDoc(doc(adminDb, "courses", "tutor1-course"), {
          id: "tutor1-course",
          title: "Tutor 1 Course",
          status: "published",
          tutorId: "tutor_1",
          assignedTutors: ["tutor_1"],
        });
        await setDoc(doc(adminDb, "courses", "tutor2-course"), {
          id: "tutor2-course",
          title: "Tutor 2 Course",
          status: "published",
          tutorId: "tutor_2",
          assignedTutors: ["tutor_2"],
        });
        await setDoc(doc(adminDb, "courses", "tutor2-course", "testKeys", "t2"), {
          answers: [0, 1],
          passingScore: 60,
        });
      });

      const tutor1Db = testEnv
        .authenticatedContext("tutor_1", { tutor: true })
        .firestore();

      // Assigned tutor can write and read testKeys on their own course
      await assertSucceeds(
        setDoc(doc(tutor1Db, "courses", "tutor1-course", "testKeys", "t1"), {
          answers: [2, 1, 3],
          passingScore: 60,
        })
      );
      await assertSucceeds(
        getDoc(doc(tutor1Db, "courses", "tutor1-course", "testKeys", "t1"))
      );

      // Assigned tutor cannot read or write testKeys on another tutor's course
      await assertFails(
        getDoc(doc(tutor1Db, "courses", "tutor2-course", "testKeys", "t2"))
      );
      await assertFails(
        setDoc(doc(tutor1Db, "courses", "tutor2-course", "testKeys", "t2"), {
          answers: [0, 0],
          passingScore: 60,
        })
      );
    });

    it("denies pending students from reading classroom modules or updating progress", async () => {
      const pendingStudentDb = testEnv
        .authenticatedContext("student_pending")
        .firestore();

      await assertFails(
        getDoc(doc(pendingStudentDb, "courses", "pub-course", "modules", "m1"))
      );
      await assertFails(
        updateDoc(doc(pendingStudentDb, "enrollments", "student_pending_pub-course"), {
          completedItemIds: ["ai_l1"],
        })
      );
    });

    it("denies students from directly mutating their enrollment status to 'completed' or 'approved'", async () => {
      const activeStudentDb = testEnv
        .authenticatedContext("student_active")
        .firestore();
      const pendingStudentDb = testEnv
        .authenticatedContext("student_pending")
        .firestore();

      await assertFails(
        updateDoc(doc(activeStudentDb, "enrollments", "student_active_pub-course"), {
          status: "completed",
        })
      );
      await assertFails(
        updateDoc(doc(pendingStudentDb, "enrollments", "student_pending_pub-course"), {
          status: "approved",
        })
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. AUDIT LOGS LOCKDOWN
  // ══════════════════════════════════════════════════════════════════════════
  describe("4. Server-Controlled Audit Logs Lockdown", () => {
    beforeEach(async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const adminDb = context.firestore();
        await setDoc(doc(adminDb, "auditLogs", "log_1"), {
          action: "Course Created",
          detail: "Server audit record",
          adminUid: "admin_1",
        });
      });
    });

    it("denies direct client creation, update, or deletion on auditLogs for all clients including admins", async () => {
      const studentDb = testEnv.authenticatedContext("student_1").firestore();
      const tutorDb = testEnv
        .authenticatedContext("tutor_1", { tutor: true })
        .firestore();
      const adminDb = testEnv
        .authenticatedContext("admin_1", { admin: true })
        .firestore();

      // Client creation denied for all
      await assertFails(
        setDoc(doc(studentDb, "auditLogs", "forged_log"), { action: "Forged" })
      );
      await assertFails(
        setDoc(doc(tutorDb, "auditLogs", "forged_log"), { action: "Forged" })
      );
      await assertFails(
        setDoc(doc(adminDb, "auditLogs", "forged_log"), { action: "Forged" })
      );

      // Client update denied for all
      await assertFails(
        updateDoc(doc(adminDb, "auditLogs", "log_1"), { detail: "Tampered" })
      );

      // Client delete denied for all
      await assertFails(deleteDoc(doc(adminDb, "auditLogs", "log_1")));
    });

    it("allows reading auditLogs exclusively for verified admins", async () => {
      const guestDb = testEnv.unauthenticatedContext().firestore();
      const studentDb = testEnv.authenticatedContext("student_1").firestore();
      const tutorDb = testEnv
        .authenticatedContext("tutor_1", { tutor: true })
        .firestore();
      const adminDb = testEnv
        .authenticatedContext("admin_1", { admin: true })
        .firestore();

      await assertFails(getDoc(doc(guestDb, "auditLogs", "log_1")));
      await assertFails(getDoc(doc(studentDb, "auditLogs", "log_1")));
      await assertFails(getDoc(doc(tutorDb, "auditLogs", "log_1")));
      await assertSucceeds(getDoc(doc(adminDb, "auditLogs", "log_1")));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5. STORAGE PROTECTION
  // ══════════════════════════════════════════════════════════════════════════
  describe("5. Firebase Storage Access & Deletion Rules", () => {
    beforeEach(async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const adminDb = context.firestore();
        const adminStorage = context.storage();

        await setDoc(doc(adminDb, "courses", "pub-course"), {
          id: "pub-course",
          title: "AI Essentials",
          status: "published",
          tutorId: "tutor_assigned",
          assignedTutors: ["tutor_assigned"],
        });

        await setDoc(doc(adminDb, "enrollments", "student_active_pub-course"), {
          uid: "student_active",
          courseId: "pub-course",
          status: "active",
        });

        await setDoc(doc(adminDb, "enrollments", "student_pending_pub-course"), {
          uid: "student_pending",
          courseId: "pub-course",
          status: "pending",
        });

        const resourceRef = ref(
          adminStorage,
          "courses/pub-course/resources/handbook.pdf"
        );
        await uploadBytes(resourceRef, new Uint8Array([1, 2, 3, 4]), {
          contentType: "application/pdf",
        });
      });
    });

    it("allows only actively enrolled students (or course staff) to read course resources", async () => {
      const activeStudentStorage = testEnv
        .authenticatedContext("student_active")
        .storage();
      const pendingStudentStorage = testEnv
        .authenticatedContext("student_pending")
        .storage();
      const unenrolledStudentStorage = testEnv
        .authenticatedContext("student_other")
        .storage();

      await assertSucceeds(
        getBytes(ref(activeStudentStorage, "courses/pub-course/resources/handbook.pdf"))
      );
      await assertFails(
        getBytes(ref(pendingStudentStorage, "courses/pub-course/resources/handbook.pdf"))
      );
      await assertFails(
        getBytes(
          ref(unenrolledStudentStorage, "courses/pub-course/resources/handbook.pdf")
        )
      );
    });

    it("allows assigned tutors and admins to upload module materials under courses/{courseId}/{moduleId}/** and succeeds on deletion without evaluating request.resource", async () => {
      const assignedTutorStorage = testEnv
        .authenticatedContext("tutor_assigned", { tutor: true })
        .storage();
      const unassignedTutorStorage = testEnv
        .authenticatedContext("tutor_other", { tutor: true })
        .storage();
      const studentStorage = testEnv
        .authenticatedContext("student_active")
        .storage();
      const adminStorage = testEnv
        .authenticatedContext("admin_1", { admin: true })
        .storage();

      const fileBytes = new Uint8Array([10, 20, 30, 40]);
      const metadata = { contentType: "application/pdf" };

      // Unassigned tutor & student cannot upload module materials
      await assertFails(
        uploadBytes(
          ref(unassignedTutorStorage, "courses/pub-course/m1/slides.pdf"),
          fileBytes,
          metadata
        )
      );
      await assertFails(
        uploadBytes(
          ref(studentStorage, "courses/pub-course/m1/slides.pdf"),
          fileBytes,
          metadata
        )
      );

      // Assigned tutor and admin can upload module materials
      await assertSucceeds(
        uploadBytes(
          ref(assignedTutorStorage, "courses/pub-course/m1/slides.pdf"),
          fileBytes,
          metadata
        )
      );
      await assertSucceeds(
        uploadBytes(
          ref(adminStorage, "courses/pub-course/m1/admin_notes.pdf"),
          fileBytes,
          metadata
        )
      );

      // Deletion succeeds for assigned tutor and admin (where request.resource is null)
      await assertFails(
        deleteObject(ref(studentStorage, "courses/pub-course/m1/slides.pdf"))
      );
      await assertSucceeds(
        deleteObject(ref(assignedTutorStorage, "courses/pub-course/m1/slides.pdf"))
      );
      await assertSucceeds(
        deleteObject(ref(adminStorage, "courses/pub-course/m1/admin_notes.pdf"))
      );
    });

    it("denies all client writes to server-controlled operation collections (courseDeletions, tutorDeletionOperations, deletedUsers, accountStatusOperations, broadcasts, broadcastReservations, broadcasts/{id}/recipients)", async () => {
      const adminDb = testEnv.authenticatedContext("admin_1", { admin: true }).firestore();
      const studentDb = testEnv.authenticatedContext("student_active").firestore();

      for (const colName of [
        "courseDeletions",
        "tutorDeletionOperations",
        "deletedUsers",
        "accountStatusOperations",
        "broadcasts",
        "broadcastReservations",
      ]) {
        await assertFails(setDoc(doc(adminDb, colName, "op_1"), { state: "tampered" }));
        await assertFails(setDoc(doc(studentDb, colName, "op_1"), { state: "tampered" }));
      }

      // Broadcast per-recipient delivery subcollection denies all client writes and non-admin reads
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const seedDb = context.firestore();
        await setDoc(doc(seedDb, "broadcasts", "b_1", "recipients", "student_active"), {
          uid: "student_active",
          status: "delivered",
          attemptCount: 1,
        });
      });

      await assertFails(
        setDoc(doc(adminDb, "broadcasts", "b_1", "recipients", "student_active"), {
          status: "pending",
        })
      );
      await assertFails(
        setDoc(doc(studentDb, "broadcasts", "b_1", "recipients", "student_active"), {
          status: "pending",
        })
      );
      await assertFails(
        getDoc(doc(studentDb, "broadcasts", "b_1", "recipients", "student_active"))
      );
      await assertSucceeds(
        getDoc(doc(adminDb, "broadcasts", "b_1", "recipients", "student_active"))
      );
    });

    it("allows authenticated learners to read published announcements with a valid future or far-future Timestamp expiresAt and denies missing, null, empty-string, malformed, or draft announcements", async () => {
      const farFutureTs = getFarFutureExpiresAtTimestamp();

      await testEnv.withSecurityRulesDisabled(async (context) => {
        const adminDb = context.firestore();
        await setDoc(doc(adminDb, "announcements", "ann_pub_far_future"), {
          title: "Published Notice (No Explicit Expiry)",
          status: "published",
          audience: "learners",
          expiresAt: farFutureTs,
          createdAt: Timestamp.now(),
        });
        await setDoc(doc(adminDb, "announcements", "ann_draft"), {
          title: "Draft Notice",
          status: "draft",
          audience: "learners",
          expiresAt: farFutureTs,
          createdAt: Timestamp.now(),
        });
        await setDoc(doc(adminDb, "announcements", "ann_null_expiry"), {
          title: "Legacy Null Expiry Notice",
          status: "published",
          audience: "learners",
          expiresAt: null,
          createdAt: Timestamp.now(),
        });
        await setDoc(doc(adminDb, "announcements", "ann_empty_expiry"), {
          title: "Legacy Empty Expiry Notice",
          status: "published",
          audience: "learners",
          expiresAt: "",
          createdAt: Timestamp.now(),
        });
        await setDoc(doc(adminDb, "announcements", "ann_malformed_expiry"), {
          title: "Malformed Expiry Notice",
          status: "published",
          audience: "learners",
          expiresAt: "not-a-valid-timestamp",
          createdAt: Timestamp.now(),
        });
        await setDoc(doc(adminDb, "announcements", "ann_missing_expiry"), {
          title: "Missing Expiry Notice",
          status: "published",
          audience: "learners",
          createdAt: Timestamp.now(),
        });
      });

      const studentDb = testEnv.authenticatedContext("student_active").firestore();
      const adminDb = testEnv.authenticatedContext("admin_1", { admin: true }).firestore();

      // Valid far-future Timestamp succeeds for learner
      await assertSucceeds(getDoc(doc(studentDb, "announcements", "ann_pub_far_future")));

      // Draft, null, empty-string, malformed string, or missing expiresAt never bypass authorization
      await assertFails(getDoc(doc(studentDb, "announcements", "ann_draft")));
      await assertFails(getDoc(doc(studentDb, "announcements", "ann_null_expiry")));
      await assertFails(getDoc(doc(studentDb, "announcements", "ann_empty_expiry")));
      await assertFails(getDoc(doc(studentDb, "announcements", "ann_malformed_expiry")));
      await assertFails(getDoc(doc(studentDb, "announcements", "ann_missing_expiry")));

      // Unconstrained list query (without expiresAt > now) is rejected because it could match null/expired docs
      await assertFails(
        getDocs(
          query(
            collection(studentDb, "announcements"),
            where("status", "==", "published"),
            where("audience", "in", ["all", "learners"])
          )
        )
      );

      // Exact application query builder (which constrains status == 'published', audience, and expiresAt > now) succeeds
      const globalQuery = buildGlobalLearnerAnnouncementsQuery(
        { collection, query, where, orderBy, limit },
        studentDb,
        Timestamp.now()
      );
      const snap = await assertSucceeds(getDocs(globalQuery));
      if (snap?.docs) {
        const ids = snap.docs.map((d) => d.id);
        if (!ids.includes("ann_pub_far_future") || ids.length !== 1) {
          throw new Error(`Expected only ann_pub_far_future, got: ${ids.join(", ")}`);
        }
      }

      // Admin retains full read access to draft and legacy malformed records for remediation/management
      await assertSucceeds(getDoc(doc(adminDb, "announcements", "ann_draft")));
      await assertSucceeds(getDoc(doc(adminDb, "announcements", "ann_null_expiry")));
      await assertSucceeds(getDoc(doc(adminDb, "announcements", "ann_malformed_expiry")));
    });

    it("requires tutors to create courses with status == 'draft' and forbids tutors from changing course status or ownership fields on update", async () => {
      const tutorDb = testEnv
        .authenticatedContext("tutor_assigned", { tutor: true })
        .firestore();

      // Tutor cannot create a course directly as 'published'
      await assertFails(
        setDoc(doc(tutorDb, "courses", "tutor-pub-attempt"), {
          id: "tutor-pub-attempt",
          title: "Unreviewed Course",
          tutorId: "tutor_assigned",
          status: "published",
        })
      );

      // Tutor can create a course with status == 'draft'
      await assertSucceeds(
        setDoc(doc(tutorDb, "courses", "tutor-draft-ok"), {
          id: "tutor-draft-ok",
          title: "Draft Course",
          tutorId: "tutor_assigned",
          status: "draft",
        })
      );

      // Tutor can update course description, but cannot change status or tutorId
      await assertSucceeds(
        updateDoc(doc(tutorDb, "courses", "tutor-draft-ok"), {
          description: "Updated syllabus notes",
        })
      );
      await assertFails(
        updateDoc(doc(tutorDb, "courses", "tutor-draft-ok"), {
          status: "published",
        })
      );
      await assertFails(
        updateDoc(doc(tutorDb, "courses", "tutor-draft-ok"), {
          tutorId: "other_tutor",
        })
      );
    });

    it("denies tutors from reading other users' dailyActivity or milestones", async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const adminDb = context.firestore();
        await setDoc(doc(adminDb, "users", "student_active", "dailyActivity", "2026-11-15"), {
          minutes: 30,
        });
        await setDoc(doc(adminDb, "milestones", "m_student_1"), {
          uid: "student_active",
          milestoneType: "Completed Course",
        });
      });

      const tutorDb = testEnv
        .authenticatedContext("tutor_assigned", { tutor: true })
        .firestore();
      const ownerDb = testEnv.authenticatedContext("student_active").firestore();
      const adminDb = testEnv.authenticatedContext("admin_1", { admin: true }).firestore();

      await assertFails(
        getDoc(doc(tutorDb, "users", "student_active", "dailyActivity", "2026-11-15"))
      );
      await assertFails(getDoc(doc(tutorDb, "milestones", "m_student_1")));

      await assertSucceeds(
        getDoc(doc(ownerDb, "users", "student_active", "dailyActivity", "2026-11-15"))
      );
      await assertSucceeds(getDoc(doc(ownerDb, "milestones", "m_student_1")));
      await assertSucceeds(
        getDoc(doc(adminDb, "users", "student_active", "dailyActivity", "2026-11-15"))
      );
      await assertSucceeds(getDoc(doc(adminDb, "milestones", "m_student_1")));
    });

    it("enforces all 10 required announcement security scenarios using the exact application query structures", async () => {
      const nowMs = Date.now();
      const futureTimestamp = Timestamp.fromMillis(nowMs + 24 * 60 * 60 * 1000);
      const farFutureTimestamp = getFarFutureExpiresAtTimestamp();
      const expiredTimestamp = Timestamp.fromMillis(nowMs - 24 * 60 * 60 * 1000);
      const createdAt1 = Timestamp.fromMillis(nowMs - 120 * 1000);
      const createdAt2 = Timestamp.fromMillis(nowMs - 60 * 1000);

      await testEnv.withSecurityRulesDisabled(async (context) => {
        const seedDb = context.firestore();

        // Courses: published vs draft
        await setDoc(doc(seedDb, "courses", "course_live"), {
          id: "course_live",
          title: "Live Published Course",
          status: "published",
          tutorId: "tutor_assigned",
          assignedTutors: ["tutor_assigned"],
        });
        await setDoc(doc(seedDb, "courses", "course_unpublished"), {
          id: "course_unpublished",
          title: "Draft Course",
          status: "draft",
          tutorId: "tutor_assigned",
          assignedTutors: ["tutor_assigned"],
        });

        // Enrollments for course_live
        await setDoc(doc(seedDb, "enrollments", "student_active_course_live"), {
          uid: "student_active",
          courseId: "course_live",
          status: "active",
        });
        await setDoc(doc(seedDb, "enrollments", "student_approved_course_live"), {
          uid: "student_approved",
          courseId: "course_live",
          status: "approved",
        });
        await setDoc(doc(seedDb, "enrollments", "student_pending_course_live"), {
          uid: "student_pending",
          courseId: "course_live",
          status: "pending",
        });
        await setDoc(doc(seedDb, "enrollments", "student_revoked_course_live"), {
          uid: "student_revoked",
          courseId: "course_live",
          status: "revoked",
        });

        // Enrollment in unpublished course
        await setDoc(doc(seedDb, "enrollments", "student_active_course_unpublished"), {
          uid: "student_active",
          courseId: "course_unpublished",
          status: "active",
        });

        // Global learner announcement (unexpired)
        await setDoc(doc(seedDb, "announcements", "ann_global_valid"), {
          id: "ann_global_valid",
          title: "Global Learner Welcome",
          body: "Welcome to Peleekings LMS",
          status: "published",
          audience: "learners",
          expiresAt: farFutureTimestamp,
          createdAt: createdAt1,
        });

        // Multiple valid course announcements for course_live
        await setDoc(doc(seedDb, "announcements", "ann_course_live_valid_1"), {
          id: "ann_course_live_valid_1",
          title: "Live Course Workshop 1",
          body: "Live session starts at 4 PM",
          status: "published",
          audience: "course",
          courseId: "course_live",
          expiresAt: futureTimestamp,
          createdAt: createdAt1,
        });
        await setDoc(doc(seedDb, "announcements", "ann_course_live_valid_2"), {
          id: "ann_course_live_valid_2",
          title: "Live Course Workshop 2",
          body: "Project submission guidelines posted",
          status: "published",
          audience: "course",
          courseId: "course_live",
          expiresAt: farFutureTimestamp,
          createdAt: createdAt2,
        });

        // Expired course announcement
        await setDoc(doc(seedDb, "announcements", "ann_course_expired"), {
          id: "ann_course_expired",
          title: "Expired Course Notice",
          body: "This session already passed",
          status: "published",
          audience: "course",
          courseId: "course_live",
          expiresAt: expiredTimestamp,
          createdAt: createdAt1,
        });

        // Draft course announcement
        await setDoc(doc(seedDb, "announcements", "ann_course_draft"), {
          id: "ann_course_draft",
          title: "Draft Course Notice",
          body: "Unpublished draft",
          status: "draft",
          audience: "course",
          courseId: "course_live",
          expiresAt: farFutureTimestamp,
          createdAt: createdAt1,
        });

        // Malformed expiresAt course announcement
        await setDoc(doc(seedDb, "announcements", "ann_course_malformed"), {
          id: "ann_course_malformed",
          title: "Malformed Course Notice",
          body: "Invalid string expiresAt",
          status: "published",
          audience: "course",
          courseId: "course_live",
          expiresAt: "invalid-date-string",
          createdAt: createdAt1,
        });

        // Unpublished course announcement
        await setDoc(doc(seedDb, "announcements", "ann_course_unpublished_course"), {
          id: "ann_course_unpublished_course",
          title: "Notice for Unpublished Course",
          body: "Course is still in draft",
          status: "published",
          audience: "course",
          courseId: "course_unpublished",
          expiresAt: farFutureTimestamp,
          createdAt: createdAt1,
        });

        // Tutor announcement
        await setDoc(doc(seedDb, "announcements", "ann_tutor_only"), {
          id: "ann_tutor_only",
          title: "Faculty Grading Rubric Update",
          body: "For tutors only",
          status: "published",
          audience: "tutors",
          expiresAt: farFutureTimestamp,
          createdAt: createdAt2,
        });
      });

      const activeStudentDb = testEnv.authenticatedContext("student_active").firestore();
      const approvedStudentDb = testEnv.authenticatedContext("student_approved").firestore();
      const unenrolledStudentDb = testEnv.authenticatedContext("student_unenrolled").firestore();
      const pendingStudentDb = testEnv.authenticatedContext("student_pending").firestore();
      const revokedStudentDb = testEnv.authenticatedContext("student_revoked").firestore();
      const assignedTutorDb = testEnv
        .authenticatedContext("tutor_assigned", { tutor: true })
        .firestore();
      const adminDb = testEnv.authenticatedContext("admin_1", { admin: true }).firestore();

      const firestoreFns = { collection, query, where, orderBy, limit };
      const queryNowTs = Timestamp.now();

      // 1. Learner retrieves a published global announcement that has not expired using exact app query
      const globalSnap = await assertSucceeds(
        getDocs(buildGlobalLearnerAnnouncementsQuery(firestoreFns, activeStudentDb, queryNowTs))
      );
      if (globalSnap?.docs) {
        const ids = globalSnap.docs.map((d) => d.id);
        if (!ids.includes("ann_global_valid")) {
          throw new Error("Expected ann_global_valid in global learner query result");
        }
      }

      // 2 & 9. Authorized learners (active and approved) retrieve multiple published course announcements for an actively enrolled course using exact app query
      await assertSucceeds(getDoc(doc(activeStudentDb, "announcements", "ann_course_live_valid_1")));
      await assertSucceeds(getDoc(doc(approvedStudentDb, "announcements", "ann_course_live_valid_2")));

      const activeCourseSnap = await assertSucceeds(
        getDocs(
          buildCourseLearnerAnnouncementsQuery(
            firestoreFns,
            activeStudentDb,
            "course_live",
            queryNowTs
          )
        )
      );
      if (activeCourseSnap?.docs) {
        const ids = activeCourseSnap.docs.map((d) => d.id);
        if (
          !ids.includes("ann_course_live_valid_1") ||
          !ids.includes("ann_course_live_valid_2") ||
          ids.includes("ann_course_expired") ||
          ids.includes("ann_course_draft") ||
          ids.includes("ann_course_malformed")
        ) {
          throw new Error(`Unexpected course announcement IDs returned: ${ids.join(", ")}`);
        }
      }

      await assertSucceeds(
        getDocs(
          buildCourseLearnerAnnouncementsQuery(
            firestoreFns,
            approvedStudentDb,
            "course_live",
            queryNowTs
          )
        )
      );

      // 3. Learner cannot retrieve a course announcement for a course without enrollment
      await assertFails(getDoc(doc(unenrolledStudentDb, "announcements", "ann_course_live_valid_1")));
      await assertFails(
        getDocs(
          buildCourseLearnerAnnouncementsQuery(
            firestoreFns,
            unenrolledStudentDb,
            "course_live",
            queryNowTs
          )
        )
      );

      // 4. Pending enrollment does not grant access
      await assertFails(getDoc(doc(pendingStudentDb, "announcements", "ann_course_live_valid_1")));
      await assertFails(
        getDocs(
          buildCourseLearnerAnnouncementsQuery(
            firestoreFns,
            pendingStudentDb,
            "course_live",
            queryNowTs
          )
        )
      );

      // 5. Revoked enrollment does not grant access
      await assertFails(getDoc(doc(revokedStudentDb, "announcements", "ann_course_live_valid_1")));
      await assertFails(
        getDocs(
          buildCourseLearnerAnnouncementsQuery(
            firestoreFns,
            revokedStudentDb,
            "course_live",
            queryNowTs
          )
        )
      );

      // 6. Expired announcements cannot be retrieved
      await assertFails(getDoc(doc(activeStudentDb, "announcements", "ann_course_expired")));
      await assertFails(
        getDocs(
          query(
            collection(activeStudentDb, "announcements"),
            where("status", "==", "published"),
            where("audience", "==", "course"),
            where("courseId", "==", "course_live"),
            where("id", "==", "ann_course_expired")
          )
        )
      );

      // 7. Draft announcements cannot be retrieved by learners
      await assertFails(getDoc(doc(activeStudentDb, "announcements", "ann_course_draft")));
      await assertFails(
        getDocs(
          query(
            collection(activeStudentDb, "announcements"),
            where("status", "==", "draft"),
            where("audience", "==", "course"),
            where("courseId", "==", "course_live")
          )
        )
      );

      // 8. Missing or malformed expiration values do not bypass authorization
      await assertFails(getDoc(doc(activeStudentDb, "announcements", "ann_course_malformed")));

      // Announcement for an unpublished course denied even if learner has an enrollment record
      await assertFails(getDoc(doc(activeStudentDb, "announcements", "ann_course_unpublished_course")));
      await assertFails(
        getDocs(
          buildCourseLearnerAnnouncementsQuery(
            firestoreFns,
            activeStudentDb,
            "course_unpublished",
            queryNowTs
          )
        )
      );

      // 10. Tutors only receive announcement access explicitly authorized for their role, and administrators can read/manage all announcements
      await assertFails(getDoc(doc(activeStudentDb, "announcements", "ann_tutor_only")));
      await assertSucceeds(getDoc(doc(assignedTutorDb, "announcements", "ann_tutor_only")));
      const tutorSnap = await assertSucceeds(
        getDocs(buildTutorAnnouncementsQuery(firestoreFns, assignedTutorDb, queryNowTs))
      );
      if (tutorSnap?.docs) {
        const tutorIds = tutorSnap.docs.map((d) => d.id);
        if (!tutorIds.includes("ann_tutor_only")) {
          throw new Error("Expected ann_tutor_only in tutor announcement query result");
        }
      }

      await assertSucceeds(getDoc(doc(adminDb, "announcements", "ann_course_live_valid_1")));
      await assertSucceeds(getDoc(doc(adminDb, "announcements", "ann_course_expired")));
      await assertSucceeds(getDoc(doc(adminDb, "announcements", "ann_course_draft")));
      await assertSucceeds(getDoc(doc(adminDb, "announcements", "ann_course_malformed")));
      await assertSucceeds(getDocs(collection(adminDb, "announcements")));

      await assertSucceeds(
        setDoc(doc(adminDb, "announcements", "ann_admin_created"), {
          id: "ann_admin_created",
          title: "Admin Created Course Announcement",
          status: "draft",
          audience: "course",
          courseId: "course_live",
          expiresAt: farFutureTimestamp,
        })
      );
      await assertSucceeds(
        updateDoc(doc(adminDb, "announcements", "ann_admin_created"), {
          status: "published",
        })
      );
      await assertSucceeds(deleteDoc(doc(adminDb, "announcements", "ann_admin_created")));
    });
  });
});



