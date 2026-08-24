/* =========================================================
   Ключі Firebase-проєкту.
   Візьми об'єкт firebaseConfig з Firebase Console:
   Project settings → Your apps → Web app → SDK setup and configuration.
   Це публічні ідентифікатори проєкту (не секрети) — їх нормально
   тримати у клієнтському коді; захист даних дають правила Firestore
   (Firestore → Rules), а не приховування цих значень.

   Якщо залишити плейсхолдери — застосунок сам відкотиться у режим
   "тільки цей браузер" (localStorage), без спільної синхронізації.
   ========================================================= */
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyCKCxENraQctYn_Zykb4LQXfAAvcuwc_T0",
  authDomain: "achievement-board.firebaseapp.com",
  projectId: "achievement-board",
  storageBucket: "achievement-board.firebasestorage.app",
  messagingSenderId: "948718969765",
  appId: "1:948718969765:web:619c2bcf654adc013b3e4c",
};
