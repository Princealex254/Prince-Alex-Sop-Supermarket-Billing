/* ==================================================================
   RetailFlow — firebase-config.js
   --------------------------------------------------------------
   The ONLY file that initialises Firebase for the RetailFlow
   frontend. Every page imports from here — never duplicate config.

   Firebase Authentication is used for IDENTITY + account
   provisioning:
     • email/password sign-in     • password reset
     • email verification         • authentication state
     • staff account creation (Identity Toolkit REST) & Firestore
       `users` mirror used by POS / mobile clients.

   Business data (business accounts, roles, permissions, branches,
   products, inventory, sales, customers, suppliers, payments,
   reports, settings, audit logs) lives in Cloudflare D1 via
   Cloudflare Workers. Uploads/media use Cloudflare R2.

   Architecture:
     Frontend → Firebase Auth → Firebase ID Token
     → Cloudflare Worker → Authorization → Cloudflare D1

   Available elsewhere in the app:
     import { auth, signOut, onAuthStateChanged } from ".../firebase/firebase-config.js";
   ================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  onAuthStateChanged,
  signOut,
  createUserWithEmailAndPassword,   // future: register.html
  updateProfile,                    // future: register.html
  sendEmailVerification             // future: register.html
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/* Firebase client configuration — safe to ship on the front end.
   Never place service-account credentials or other secrets here. */
const firebaseConfig = {
  apiKey: "AIzaSyAUNs3WYS2mkvPvzRDfhyZFUbP2XpZjDQg",
  authDomain: "retailflow-pos-11726.firebaseapp.com",
  projectId: "retailflow-pos-11726",
  storageBucket: "retailflow-pos-11726.firebasestorage.app",
  messagingSenderId: "309314798354",
  appId: "1:309314798354:web:30784c2b2e7e42168629cb"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

/* Firestore — used to mirror user/staff records into the `users`
   collection so POS / mobile clients can read them directly.
   NOTE: Firestore security rules must allow authenticated admins to
   read/write `users` documents for this to work. */
export const db = getFirestore(app);

export const FIREBASE_API_KEY = firebaseConfig.apiKey;

export {
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp
};

export {
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  onAuthStateChanged,
  signOut,
  createUserWithEmailAndPassword,
  updateProfile,
  sendEmailVerification
};