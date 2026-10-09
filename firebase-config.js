// ==========================================
// firebase-config.js - إعداد Firebase الأساسي
// مشروع: ahmd4mobily2026 - سحابي كامل
// جميع الأسماء سمول - لا تستخدم حروف كبيرة
// ==========================================
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCSV4hHRE_EWQ7Q4vThpI-7AqDNQh3idg",
  authDomain: "ahmd4mobily2026.firebaseapp.com",
  projectId: "ahmd4mobily2026",
  storageBucket: "ahmd4mobily2026.firebasestorage.app",
  messagingSenderId: "365833229927",
  appId: "1:365833229927:web:49661d5dbbe53295fae6c2",
  measurementId: "G-X3NGD09PLV"
};

// تهيئة آمنة بدون تكرار التهيئة
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(app);

console.log("✅ Firebase متصل:", firebaseConfig.projectId);

export { db, app };
export default app;
