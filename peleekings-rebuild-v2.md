# Peleekings — Rebuild Sequence v2 (Fresh Project)

Everything learned from the first build is baked into this sequence rather than patched on afterward:
- Design tokens locked in Stage 1 — purple `#5624D0` (learner side) and charcoal `#1C1D1F` (tutor side) from the start, so no blue-accent leftovers can ever creep in.
- Module/curriculum structure is part of content from the beginning — nothing gets flat notes/tests/assignments that need restructuring later.
- Corper/non-corper is a button selector (not a toggle) with the green reg-code confirmation panel, from the first sign-up screen.
- Routing is one simple rule from day one — no sessionStorage flags, no "Access Denied" dead ends.
- Course analytics is built alongside the Teaching Portal, not left as an unbuilt schema field.

---

## Stage 1 — Design Foundation + Auth + Users

> Build a full-stack web app called Peleekings — an e-learning platform. Set up Firebase (Firestore, Auth with email/password, Cloud Storage).
>
> **Design tokens (set these globally before building any screen)**:
> - Learner-side accent: purple `#5624D0`. Tutor-side accent: charcoal `#1C1D1F`.
> - Cards: white background, `1px solid #E5E5E5` border, `12px` radius, no shadow.
> - Inputs: `1px solid #E5E5E5` border, `8px` radius, label above the field (not placeholder-only).
> - Primary buttons: solid accent color, white text, `8px` radius, no border.
> - Font: Inter or similar clean sans-serif throughout.
> - Do not use any blue other than `#5624D0` anywhere in the app.
>
> **Sign-up form**:
> - Fields: surname, first name, email, password.
> - Corper status as two selectable buttons side by side: "Corper" and "Non-Corper" — selected one filled purple, unselected one white with border. Selecting "Corper" reveals an NYSC State Code field (format AB/23A/1399).
> - On submit, create a `users/{uid}` doc: `fullName`, `surname`, `firstName`, `email`, `role` (default `"student"`), `studentType` (`"corper"`/`"non_corper"`), `nyscStateCode` (or null), `regNumber` (null for now), `portraitUrl` (null), `createdAt`, `status` (default `"active"`).
>
> **Registration number Cloud Function**: trigger right after user creation.
> - Corper: surname initial + first-name initial (uppercase) + numeric segment of `nyscStateCode` (e.g. "AB/23A/1399" → "1399"), giving e.g. `AS1399`. Check uniqueness; append a letter suffix (A, B, C...) on collision.
> - Non-corper: random 4-digit number + first-name initial + surname initial, e.g. `1234FA`. Check uniqueness; retry up to 10 times on collision.
> - Write the result to `regNumber` on the user doc.
>
> **After sign-up completes**: show a one-time green confirmation panel (before routing to the dashboard) — light green background `#EAF7EF`, label "Your Registration Code," the code large and bold in dark green `#1B7A43`, caption below in small gray text: "Generated automatically."
>
> **Login form**: standard email/password using Firebase Auth.
>
> **After login**: route based on `role` — for now (before other roles exist) just go to a simple dashboard showing the user's name, email, and reg number.

---

## Stage 2 — Courses, Modules, and Catalog

> Build the course and curriculum data model together, from the start.
>
> `courses/{courseId}`: `title`, `description`, `learningOutcomes`, `syllabus`, `tutorId` (null for now), `nextCourseId` (null or reference), `status` (`"draft"`/`"published"`), `createdAt`.
>
> `courses/{courseId}/modules/{moduleId}`: `title`, `order` (number), `createdAt`.
>
> `notes`, `tests`, `assignments` subcollections under each module's course — each doc includes `moduleId` and `order` (position within that module) from the start, in addition to their normal fields:
> - `notes`: `title`, `fileUrl`, `uploadedBy`, `createdAt`.
> - `tests`: `title`, `questions` (array of `{question, options[], correctIndex}`), `dueAt`, `createdAt`.
> - `assignments`: `title`, `instructions`, `attachmentUrl`, `dueAt`, `createdAt`.
>
> Manually add 2 sample courses, each with 2 modules, and 1-2 notes/tests/assignments per module, so there's real structured content to build against.
>
> **Catalog page**: list courses where `status == "published"` — card style per the design tokens (title, short excerpt, learning outcomes), "View course" to detail page.
>
> **Course detail page**: description, learning outcomes, a read-only preview of the module/lesson structure (titles only, no content access yet — that requires enrollment), and an "Enroll" button (non-functional until Stage 3).

---

## Stage 3 — Enrollment + Progress Fields

> Add enrollment, with progress-tracking fields built in from the start.
>
> `enrollments/{uid}_{courseId}`: `uid`, `courseId`, `enrolledAt`, `status` (default `"active"`), `completedItemIds` (empty array by default), `progressPercent` (0 by default).
>
> "Enroll" button creates this doc. After enrolling: button becomes "Enrolled" (disabled), course appears on dashboard, catalog reflects "Enrolled" instead of the button. Clicking Enroll again on an already-enrolled course does nothing.

---

## Stage 4 — Student Curriculum View (Sidebar + Content Interaction)

> Build the student-facing curriculum experience as a sidebar layout — this only renders content for courses the student has an `enrollments` doc for; otherwise show "Enroll in this course to access its content."
>
> **Sidebar**: modules in order, each a collapsible section (expanded by default) listing its notes/tests/assignments in order. Each row has a checkmark: filled purple if the item's id is in `completedItemIds`, empty outline otherwise. Active/selected row: light purple background `#F3EEFC`, purple left border.
>
> **Main panel** (updates based on sidebar selection):
> - **Note**: shows title and a link/embed to `fileUrl`. A "Mark as read" button appends the note's id to `completedItemIds` if not already present.
> - **Test**: "Start Test" opens one-question-at-a-time with radio options, Next/Submit. On submit: calculate score, write to `testSubmissions` (`uid`, `courseId`, `testId`, `answers[]`, `score`, `submittedAt`), show score immediately, append the test's id to `completedItemIds`.
> - **Assignment**: shows instructions, due date, and a "Submit" button (or "Submitted"/graded state if already done). Submitting opens a file upload + optional comment, writing to `assignmentSubmissions` (`uid`, `courseId`, `assignmentId`, `fileUrl`, `grade: null`, `feedback: null`, `submittedAt`), and appends the assignment's id to `completedItemIds`. Once graded, show `grade` and `feedback`.
>
> Add a separate "Announcements" tab alongside the curriculum sidebar (not inside it) — `courses/{courseId}/announcements/{announcementId}`: `title`, `body`, `postedBy`, `createdAt`, newest first.
>
> **Progress recalculation**: whenever `completedItemIds` changes, recompute `progressPercent` = completed ÷ (total notes + tests + assignments across all modules in the course) × 100. Show this as a progress bar on the dashboard per enrolled course, and at the top of the curriculum sidebar.

---

## Stage 5 — Tutor Application + Admin Approval

> Build the tutor application flow, context-aware from the start (no separate patch needed later).
>
> **Application form** ("Apply to Teach"): portrait upload (Firebase Storage), full name, course title, course description, learning outcomes, syllabus, next course (optional). Requires the user to be logged in — if not, redirect to login/sign-up first, then return here automatically after auth completes (use a single `sessionStorage` flag `pendingTutorApply` for this one redirect purpose only — not for anything else).
>
> If arriving here logged out and going through sign-up: show "Create your account to apply as a tutor" as the heading instead of the default, with supporting text "You'll fill out your course details on the next step." Same fields as the normal sign-up form — no separate shorter form.
>
> On submit: create `tutorApplications/{applicationId}` — `applicantUid`, `fullName`, `portraitUrl`, `courseTitle`, `courseDescription`, `learningOutcomes`, `syllabus`, `nextCourseTitle`, `status` (default `"pending"`), `submittedAt`. Confirmation screen: "Your application is under review."
>
> **Admin review** (visible only if `role == "admin"` — set one test account manually): list pending applications with portrait, name, course title, Approve/Reject buttons.
> - Approve: `status: "approved"`, `reviewedAt`, flip applicant's `role` to `"tutor"`, create the `courses` doc from the application (`tutorId` set, `status: "draft"`).
> - Reject: `status: "rejected"`, `reviewedAt`. No course created.

---

## Stage 6 — Login Tabs + Simple Routing

> Update the login screen with two tabs: "Student" and "Tutor" (default Student). Student tab has a sign-up link; Tutor tab has an "Apply to become a tutor" link instead.
>
> **Routing rule (the only rule — no other flags or bounce screens)**: after any successful login, read `role` from `users/{uid}` once, then route directly: `"student"` → Learner Portal dashboard. `"tutor"` or `"admin"` → Teaching Portal dashboard.
>
> If someone logs in via the Tutor tab but their role is `"student"`, don't block them — log them into the Learner Portal normally, with a small dismissible banner on their dashboard: "Want to teach on Peleekings? Apply here," linking to the application form.

---

## Stage 7 — Learner Portal / Teaching Portal Shells

> Split the app into two portal shells sharing the same Auth/Firestore backend.
>
> **Learner Portal**: existing header, catalog, course detail, dashboard, curriculum view. Accent: purple `#5624D0`.
>
> **Teaching Portal**: distinct header/nav — "Peleekings Teaching" branding, dark sidebar-style nav, accent charcoal `#1C1D1F`.
>
> Add "Switch to Learner view" inside the Teaching Portal, and "Go to Teaching Portal" inside the Learner Portal for approved tutors.

---

## Stage 8 — Teaching Portal: Content + Modules + Analytics

> Inside the Teaching Portal, build the tutor's course management screen, scoped to `courses.tutorId == current user's uid`.
>
> **Modules tab**: create/reorder modules for their course.
>
> **Notes/Announcements/Tests/Assignments tabs**: same as before, but uploading a note/test/assignment now requires picking which module and its order within that module. "Publish" toggle on the course overview flips `status` between draft/published.
>
> **Submissions view**: under each assignment, list all `assignmentSubmissions` for it — student name, file link, `grade` input, `feedback` field, "Save grade" button.
>
> **Analytics tab**: Cloud Function recomputes `courses/{courseId}/analytics/summary` on enrollment/submission writes — `enrollmentCount`, `avgTestScore`, `assignmentSubmissionRate`, `lastUpdated`. Screen shows four stat cards (Enrolled, Avg Test Score, Assignment Submission Rate, Modules count) plus a line chart of cumulative enrollments over time (derived from `enrollments.enrolledAt`, no separate time-series collection needed). Purple `#5624D0` for the chart line and highlighted numbers; everything else per the design tokens.

---

## Stage 9 — Notifications

> Add `users/{uid}/notifications/{notificationId}`: `type` (`"announcement"`/`"grade"`/`"application_status"`/`"new_content"`), `title`, `body`, `courseId` (optional), `read` (default false), `createdAt`.
>
> Trigger a notification write when: a tutor posts an announcement (→ all enrolled students), a tutor grades a submission (→ that student), an admin approves/rejects an application (→ the applicant), new content is added to a module a student is enrolled in (→ that student, `type: "new_content"`).
>
> Notification bell in both portal headers with unread-count badge; dropdown of recent notifications, unread ones visually distinct; clicking marks read and navigates to the course if `courseId` is set.

---

## Stage 10 — Landing Page

> Build the public landing page at `/`.
>
> Header: logo only. Hero: headline + subtext, then two large cards side by side — "I'm a Student" (purple, "Browse courses and start learning," links to Student login/signup) and "I'm a Tutor" (charcoal, "Apply to teach your own course," links to the Teach on Peleekings page, Stage 11). Featured courses row pulling from published courses, matching catalog card style. Minimal footer.
>
> No decorative filler sections.

---

## Stage 11 — Teach on Peleekings

> Dedicated marketing page, separate from the landing page and the application form.
>
> Header matches main landing page, "Teach on Peleekings" highlighted, primary button "Get started." Hero: "Turn what you know into a course," supporting sentence, "Get started" button → tutor application form. Three value-prop cards ("Reach real learners," "Your own dashboard," "Simple to get started"). Bottom CTA repeating "Get started."
>
> Update main landing page's "I'm a Tutor" card to point here instead of straight to login.
