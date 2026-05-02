import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getFirestore, Firestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';
import { getStorage, FirebaseStorage } from 'firebase/storage';
import { getAuth, Auth } from 'firebase/auth';
import { getDatabase, Database } from 'firebase/database';

function requireEnv(name: string, value: string | undefined): string {
  if (typeof value === 'string' && value.length > 0) return value;
  const message = `[firebase] Missing required environment variable: ${name}. ` +
    `For client-side Firebase config in Next.js this must be prefixed with NEXT_PUBLIC_.`;
  // Surface a clear error early instead of passing undefined into Firebase SDK.
  throw new Error(message);
}

const firebaseConfig = {
  apiKey: requireEnv('NEXT_PUBLIC_FIREBASE_API_KEY', process.env.NEXT_PUBLIC_FIREBASE_API_KEY),
  authDomain: requireEnv('NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN', process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN),
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
  projectId: requireEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID', process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID),
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || 'fintrack-tpsds.appspot.com',
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: requireEnv('NEXT_PUBLIC_FIREBASE_APP_ID', process.env.NEXT_PUBLIC_FIREBASE_APP_ID),
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

// Singleton pattern to prevent multiple initializations in Next.js dev mode
let app: FirebaseApp;
let db: Firestore;
let auth: Auth;
let storage: FirebaseStorage;
let rtdb: Database | null = null;

if (!getApps().length) {
  app = initializeApp(firebaseConfig);
  // Initialize Firestore with modern persistent cache only ONCE
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ 
      tabManager: persistentMultipleTabManager() 
    })
  });
} else {
  app = getApp();
  db = getFirestore(app);
}

auth = getAuth(app);
storage = getStorage(app);

if (firebaseConfig.databaseURL && firebaseConfig.databaseURL.startsWith('https://')) {
    try {
        rtdb = getDatabase(app);
    } catch (error) {
        console.warn("RTDB Init failed", error);
    }
}

export { app, auth, storage, rtdb, db };
export const getDb = (): Firestore => db;
