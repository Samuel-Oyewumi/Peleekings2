import fs from "node:fs";
import path from "node:path";
import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from "@firebase/rules-unit-testing";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
} from "firebase/firestore";
import {
  ref,
  uploadBytes,
  getBytes,
  deleteObject,
} from "firebase/storage";

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

    it("allows actively enrolled students to read course modules and update lesson progress", async () => {
      const activeStudentDb = testEnv
        .authenticatedContext("student_active")
        .firestore();

      await assertSucceeds(
        getDoc(doc(activeStudentDb, "courses", "pub-course", "modules", "m1"))
      );
      await assertSucceeds(
        updateDoc(doc(activeStudentDb, "enrollments", "student_active_pub-course"), {
          completedItemIds: ["ai_l1", "ai_l2"],
          progressPercent: 25,
          lastAccessedLesson: "ai_l2",
          updatedAt: serverTimestamp(),
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
          progressPercent: 15,
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
  });
});
