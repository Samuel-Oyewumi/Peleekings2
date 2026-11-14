// Resources Service for Peleekings (Firestore & Storage backed)
// Allows Admins and Tutors to upload platform and course resources that reflect across the platform

import {
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  deleteDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { httpsCallable } from "firebase/functions";
import { db, storage, functions } from "../firebase";

// Deprecated static fallback removed from live queries so empty collections or Firestore errors
// never masquerade as published database records.
export const DEFAULT_RESOURCES = [];

/**
 * Helper to determine if a URL or storagePath refers to a Firebase Storage object.
 */
export function isFirebaseStorageResource(fileUrl, storagePath) {
  if (storagePath && typeof storagePath === "string" && storagePath.trim().length > 0) {
    return true;
  }
  if (!fileUrl || typeof fileUrl !== "string") return false;
  return (
    fileUrl.includes("firebasestorage.googleapis.com") ||
    fileUrl.includes(".firebasestorage.app") ||
    fileUrl.startsWith("gs://")
  );
}

/**
 * Fetch resources from Firestore.
 * Returns genuine Firestore documents only (empty array when collection is empty).
 * Throws on Firestore errors when throwOnError is true (default false for non-admin, or callers can catch).
 */
export async function getResources(courseId = null, { throwOnError = false } = {}) {
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
    return snap.docs.map((d) => {
      const data = d.data() || {};
      let createdAtStr = "";
      if (data.createdAt && typeof data.createdAt.toDate === "function") {
        createdAtStr = data.createdAt.toDate().toISOString();
      } else if (data.createdAt && typeof data.createdAt.seconds === "number") {
        createdAtStr = new Date(data.createdAt.seconds * 1000).toISOString();
      } else if (typeof data.createdAt === "string") {
        createdAtStr = data.createdAt;
      }
      return {
        ...data,
        id: d.id,
        title: typeof data.title === "string" && data.title ? data.title : "Untitled Resource",
        desc: typeof data.desc === "string" ? data.desc : (typeof data.description === "string" ? data.description : ""),
        category: typeof data.category === "string" && data.category ? data.category : "Tech & Digital Skills",
        courseId: typeof data.courseId === "string" && data.courseId ? data.courseId : "platform",
        type: typeof data.type === "string" && data.type ? data.type : "Document",
        fileSize: typeof data.fileSize === "string" ? data.fileSize : "",
        fileUrl: typeof data.fileUrl === "string" ? data.fileUrl : "",
        storagePath: typeof data.storagePath === "string" ? data.storagePath : null,
        createdAt: createdAtStr,
      };
    });
  } catch (err) {
    console.warn("Error querying Firestore resources:", err);
    if (throwOnError) {
      throw err;
    }
    return [];
  }
}

/**
 * Upload a resource to Firebase Storage & Firestore.
 * Accessible to Admins and assigned course Tutors.
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
  let uploadedStoragePath = null;

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
    uploadedStoragePath = courseId && courseId !== "platform"
      ? `courses/${courseId}/resources/${Date.now()}_${safeName}`
      : `resources/${Date.now()}_${safeName}`;
    const storageRef = ref(storage, uploadedStoragePath);

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
    storagePath: uploadedStoragePath,
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

    // Record server-side audit log non-blockingly
    try {
      const logFn = httpsCallable(functions, "adminLogResourceAction");
      logFn({
        action: "uploaded",
        resourceId: docRef.id,
        title: payload.title,
        courseId: payload.courseId,
      }).catch(() => {});
    } catch {
      // Ignore if functions emulator not attached
    }

    return {
      ...payload,
      id: docRef.id,
      createdAt: new Date().toISOString(),
    };
  } catch (fsErr) {
    // Roll back Storage upload if Firestore metadata creation failed
    if (uploadedStoragePath) {
      try {
        await deleteObject(ref(storage, uploadedStoragePath));
      } catch (rollbackErr) {
        console.warn("Could not roll back uploaded file after Firestore error:", rollbackErr);
      }
    }
    console.error("Firestore resource addDoc error:", fsErr);
    throw new Error(`Failed to save resource metadata to Firestore: ${fsErr.message}`);
  }
}

/**
 * Reliably delete a resource from Firebase Storage and Firestore.
 * - Inspects both storagePath and fileUrl to determine if a Storage object exists.
 * - Preserves external links (which have no Storage object) and deletes their Firestore record cleanly.
 * - Deletes the Storage object first; if Storage deletion fails (other than object-not-found), throws
 *   an error before deleting the Firestore document so partial failures are never hidden.
 * - Deletes the Firestore metadata document and throws on any Firestore error.
 */
export async function deleteResource(resourceId, fileUrl = null, storagePath = null) {
  if (!resourceId || typeof resourceId !== "string") {
    throw new Error("A valid resourceId is required to delete a resource.");
  }

  const resourceRef = doc(db, "resources", resourceId);
  let resolvedFileUrl = fileUrl;
  let resolvedStoragePath = storagePath;
  let resourceTitle = resourceId;
  let resourceCourseId = "platform";

  // Fetch metadata from Firestore if storagePath/fileUrl were not supplied
  try {
    const snap = await getDoc(resourceRef);
    if (snap.exists()) {
      const data = snap.data() || {};
      resolvedFileUrl = resolvedFileUrl || data.fileUrl || null;
      resolvedStoragePath = resolvedStoragePath || data.storagePath || null;
      resourceTitle = data.title || resourceId;
      resourceCourseId = data.courseId || "platform";
    }
  } catch (readErr) {
    console.warn("Could not pre-read resource document before deletion:", readErr);
  }

  // 1. Delete Storage file if this resource is backed by Firebase Storage
  const hasStorageObject = isFirebaseStorageResource(resolvedFileUrl, resolvedStoragePath);
  if (hasStorageObject) {
    const targetRefPath = resolvedStoragePath || resolvedFileUrl;
    try {
      const fileRef = ref(storage, targetRefPath);
      await deleteObject(fileRef);
    } catch (storageErr) {
      const code = storageErr?.code || "";
      // If object was already deleted from Storage, proceed to clean up Firestore doc
      if (code !== "storage/object-not-found") {
        console.error("Storage file deletion failed:", storageErr);
        throw new Error(
          `Failed to delete file from Cloud Storage (${code || storageErr.message || "Storage error"}). Metadata was kept so you can retry.`
        );
      }
    }
  }

  // 2. Delete Firestore metadata document (never swallow errors)
  try {
    await deleteDoc(resourceRef);
  } catch (fsErr) {
    console.error("Firestore resource deletion failed:", fsErr);
    throw new Error(`Failed to delete resource record from Firestore: ${fsErr.message || "Permission or network error"}`);
  }

  // 3. Record server-controlled audit log
  try {
    const logFn = httpsCallable(functions, "adminLogResourceAction");
    logFn({
      action: "deleted",
      resourceId,
      title: resourceTitle,
      courseId: resourceCourseId,
    }).catch(() => {});
  } catch {
    // Ignore if functions unreachable
  }

  return { success: true, resourceId, deletedStorageObject: hasStorageObject };
}
