// Notifications Service for Peleekings (Firestore-backed)
// Manages user-specific notifications for announcements, grades, application status, and content updates

import {
  collection,
  doc,
  updateDoc,
  onSnapshot,
  query,
  orderBy,
  limit,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";

/**
 * Subscribe to real-time notifications for a specific user.
 */
export function subscribeToNotifications(userId, callback) {
  if (!userId) return () => {};

  const notifRef = collection(db, "users", userId, "notifications");
  const q = query(notifRef, orderBy("createdAt", "desc"), limit(20));

  return onSnapshot(
    q,
    (snapshot) => {
      const items = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
      callback(items);
    },
    (err) => {
      console.warn("Notifications subscription notice:", err);
      callback([]);
    }
  );
}

/**
 * Mark a single notification as read.
 * Strictly updates only allowed fields ('read', 'readAt').
 */
export async function markNotificationAsRead(userId, notificationId) {
  if (!userId || !notificationId) return;
  try {
    const notifRef = doc(db, "users", userId, "notifications", notificationId);
    await updateDoc(notifRef, { read: true, readAt: serverTimestamp() });
  } catch (err) {
    console.error("Failed to mark notification as read:", err);
    throw err;
  }
}

/**
 * Mark all notifications as read for a user.
 * Strictly updates only allowed fields ('read', 'readAt').
 */
export async function markAllNotificationsAsRead(userId, notifications = []) {
  if (!userId || !notifications.length) return;
  try {
    const batch = writeBatch(db);
    notifications.forEach((notif) => {
      if (!notif.read) {
        const notifRef = doc(db, "users", userId, "notifications", notif.id);
        batch.update(notifRef, { read: true, readAt: serverTimestamp() });
      }
    });
    await batch.commit();
  } catch (err) {
    console.error("Failed to mark all notifications as read:", err);
    throw err;
  }
}

/**
 * Send a notification to a specific user via trusted server-side Cloud Function.
 * Direct client writes to users/{uid}/notifications are blocked by Firestore security rules.
 * Types: 'announcement' | 'grade' | 'application_status' | 'new_content'
 */
export async function createNotification(targetUid, { type = "announcement", title, body, courseId = null }) {
  if (!targetUid || !title || !body) return null;
  try {
    const sendFn = httpsCallable(functions, "sendCourseNotification");
    const res = await sendFn({
      targetUid,
      courseId,
      type,
      title,
      body,
    });
    return res.data;
  } catch (err) {
    console.error("Failed to dispatch notification via Cloud Function:", err);
    throw err;
  }
}
