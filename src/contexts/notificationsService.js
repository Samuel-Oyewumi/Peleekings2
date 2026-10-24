// Notifications Service for Peleekings (Firestore-backed)
// Manages user-specific notifications for announcements, grades, application status, and content updates

import {
  collection,
  doc,
  addDoc,
  updateDoc,
  onSnapshot,
  query,
  orderBy,
  limit,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore";
import { db } from "../firebase";

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
 */
export async function markNotificationAsRead(userId, notificationId) {
  if (!userId || !notificationId) return;
  try {
    const notifRef = doc(db, "users", userId, "notifications", notificationId);
    await updateDoc(notifRef, { read: true, readAt: serverTimestamp() });
  } catch (err) {
    console.error("Failed to mark notification as read:", err);
  }
}

/**
 * Mark all notifications as read for a user.
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
  }
}

/**
 * Send a notification to a specific user.
 * Types: 'announcement' | 'grade' | 'application_status' | 'new_content'
 */
export async function createNotification(targetUid, { type = "announcement", title, body, courseId = null }) {
  if (!targetUid || !title) return;
  try {
    const notifCol = collection(db, "users", targetUid, "notifications");
    await addDoc(notifCol, {
      type,
      title,
      body,
      courseId,
      read: false,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    console.error("Failed to create notification:", err);
  }
}
