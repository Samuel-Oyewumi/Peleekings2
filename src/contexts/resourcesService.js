// Resources Service for Peleekings (Firestore & Storage backed)
// Allows Admins and Tutors to upload platform and course resources that reflect across the platform

import {
  collection,
  doc,
  addDoc,
  getDocs,
  deleteDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { db, storage } from "../firebase";

export const DEFAULT_RESOURCES = [
  {
    id: "default-1",
    title: "2025 AI Tools & Automation Cheatsheet",
    desc: "Top 50 prompt frameworks, API patterns, and no-code connectors.",
    category: "Tech & Digital Skills",
    courseId: "ai-essentials",
    type: "PDF",
    fileSize: "2.4 MB",
    fileUrl: "https://images.unsplash.com/photo-1677442136019-21780ecad995?w=600",
    uploaderName: "Peleekings Academic Team",
    isDefault: true,
  },
  {
    id: "default-2",
    title: "NYSC Tech Skill Acceleration Guide",
    desc: "How corps members can build a freelance and remote career during service year.",
    category: "Professional Skills",
    courseId: "platform",
    type: "PDF",
    fileSize: "1.8 MB",
    fileUrl: "https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=600",
    uploaderName: "Samuel Asuquo (Admin)",
    isDefault: true,
  },
  {
    id: "default-3",
    title: "Figma UI/UX Starter Kit & Templates",
    desc: "Clean component library, typography scale, and color tokens.",
    category: "Creative & Design",
    courseId: "graphic-design",
    type: "Design File",
    fileSize: "8.1 MB",
    fileUrl: "https://images.unsplash.com/photo-1581291518655-9523c932edcf?w=600",
    uploaderName: "Lead Designer",
    isDefault: true,
  },
  {
    id: "default-4",
    title: "Computer Basics & Shortcuts Quick Reference",
    desc: "Master key shortcuts for Windows, file operations, and terminal basics.",
    category: "Tech & Digital Skills",
    courseId: "computer-basics",
    type: "PDF",
    fileSize: "1.2 MB",
    fileUrl: "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=600",
    uploaderName: "Peleekings Instructors",
    isDefault: true,
  },
];

/**
 * Fetch resources from Firestore.
 * Optionally filter by courseId ("platform", specific courseId, or "all").
 */
export async function getResources(courseId = null) {
  try {
    const resourcesCol = collection(db, "resources");
    let q;

    if (courseId && courseId !== "all") {
      const targetIds = Array.from(new Set([courseId, "platform"]));
      if (targetIds.length === 1) {
        q = query(resourcesCol, where("courseId", "==", targetIds[0]));
      } else {
        q = query(resourcesCol, where("courseId", "in", targetIds));
      }
    } else {
      q = query(resourcesCol, orderBy("createdAt", "desc"));
    }

    const snap = await getDocs(q);
    const firestoreItems = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // Filter defaults matching the request
    let filteredDefaults = DEFAULT_RESOURCES;
    if (courseId && courseId !== "all") {
      filteredDefaults = DEFAULT_RESOURCES.filter(
        (r) => r.courseId === courseId || r.courseId === "platform"
      );
    }

    const combined = [
      ...firestoreItems,
      ...filteredDefaults.filter((def) => !firestoreItems.some((f) => f.title === def.title)),
    ];

    return combined;
  } catch (err) {
    console.warn("Notice: querying Firestore resources:", err);
    if (courseId && courseId !== "all") {
      return DEFAULT_RESOURCES.filter((r) => r.courseId === courseId || r.courseId === "platform");
    }
    return DEFAULT_RESOURCES;
  }
}

/**
 * Upload a resource to Firebase Storage & Firestore (with 3.5s timeout fallback).
 * Accessible to Admins and Tutors.
 */
export async function uploadResource({
  file = null,
  title,
  description = "",
  category = "Tech & Digital Skills",
  courseId = "platform",
  externalUrl = "",
  user = null,
}) {
  if (!title || (!file && !externalUrl.trim())) {
    throw new Error("Please provide a resource title and either upload a file or enter a link.");
  }

  let downloadUrl = externalUrl.trim();
  let fileName = file ? file.name : title;
  let fileSize = "";
  let resourceType = "Document";

  if (file) {
    // Format file size
    if (file.size >= 1024 * 1024) {
      fileSize = `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
    } else {
      fileSize = `${Math.max(1, Math.round(file.size / 1024))} KB`;
    }

    // Determine type
    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith(".pdf")) resourceType = "PDF";
    else if (lowerName.endsWith(".zip") || lowerName.endsWith(".rar")) resourceType = "ZIP Archive";
    else if (lowerName.match(/\.(jpg|jpeg|png|webp|svg)$/)) resourceType = "Image";
    else if (lowerName.match(/\.(doc|docx|txt|md)$/)) resourceType = "Document";
    else if (lowerName.match(/\.(fig|sketch|xd)$/)) resourceType = "Design File";
    else resourceType = "Resource File";

    // Firebase Storage upload
    const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_");
    const storagePath = courseId && courseId !== "platform"
      ? `courses/${courseId}/resources/${Date.now()}_${safeName}`
      : `resources/${Date.now()}_${safeName}`;
    const storageRef = ref(storage, storagePath);

    try {
      const uploadSnapshot = await uploadBytes(storageRef, file);
      downloadUrl = await getDownloadURL(uploadSnapshot.ref);
    } catch (storageErr) {
      console.error("Firebase Storage upload failure:", storageErr);
      throw new Error(`Failed to upload file to Cloud Storage: ${storageErr.message || "Permission or network error"}`);
    }
  } else {
    resourceType = "External Link";
    fileSize = "Web Resource";
  }

  const payload = {
    title: title.trim(),
    desc: description.trim(),
    category: category || "General",
    courseId: courseId || "platform",
    fileUrl: downloadUrl,
    fileName,
    fileSize,
    type: resourceType,
    uploadedBy: user?.uid || "admin",
    uploaderName: user?.displayName || user?.fullName || user?.email || "Instructor",
    uploaderRole: user?.role || "tutor",
    createdAt: serverTimestamp(),
  };

  try {
    const docRef = await addDoc(collection(db, "resources"), payload);
    return {
      ...payload,
      id: docRef.id,
      createdAt: new Date().toISOString(),
    };
  } catch (fsErr) {
    console.error("Firestore resource addDoc error:", fsErr);
    throw new Error(`Failed to save resource metadata to Firestore: ${fsErr.message}`);
  }
}

/**
 * Delete a resource from Firestore, Storage, and local cache.
 */
export async function deleteResource(resourceId, fileUrl = null) {
  if (!resourceId) return;

  const existingLocal = getLocalCustomResources();
  saveLocalCustomResources(existingLocal.filter((r) => r.id !== resourceId));

  try {
    await Promise.race([
      deleteDoc(doc(db, "resources", resourceId)),
      new Promise((_, reject) => setTimeout(() => reject(new Error("FIRESTORE_TIMEOUT")), 3000)),
    ]);
  } catch (err) {
    console.warn("Firestore resource delete notice:", err);
  }

  if (fileUrl && fileUrl.includes("firebasestorage.googleapis.com")) {
    try {
      const fileRef = ref(storage, fileUrl);
      await Promise.race([
        deleteObject(fileRef),
        new Promise((_, reject) => setTimeout(() => reject(new Error("STORAGE_TIMEOUT")), 2500)),
      ]);
    } catch (sErr) {
      console.warn("Storage deletion notice:", sErr);
    }
  }
}
