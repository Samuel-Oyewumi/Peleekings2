import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getFunctions } from "firebase/functions";

// NOTE: Hardcoded fallbacks below expose real credentials in source — move to a .env file
// and remove the || "..." fallbacks before committing to a public repository.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyC6HPgrp0YPkmx7yONTP4_qBhipSfzAEzM",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "pelee-kings.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "pelee-kings",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "pelee-kings.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "180209953008",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:180209953008:web:a3061cc026fc5c808cba35",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-05WVDJS8X9",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const functions = getFunctions(app);
export default app;
