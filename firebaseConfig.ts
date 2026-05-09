import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyAm4ztPRbDpY-Tg_pEdGEvQZeXkaDKlTIY",
  authDomain: "mantra-japam.firebaseapp.com",
  projectId: "mantra-japam",
  storageBucket: "mantra-japam.firebasestorage.app",
  messagingSenderId: "475929514423",
  appId: "1:475929514423:web:de576b40b1a7e0d9eb9832"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);






