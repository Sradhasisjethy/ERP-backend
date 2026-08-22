const admin = require('firebase-admin');
const path = require('path');
require('dotenv').config();

const serviceAccountPath = path.resolve(__dirname, '../../firebase-service-account.json');

try {
  const serviceAccount = require(serviceAccountPath);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });

  console.log('Firebase Admin SDK initialized successfully.');
} catch (error) {
  console.warn('Firebase Service Account key not found or invalid at:', serviceAccountPath);
  console.warn('Please add firebase-service-account.json to the root of ERP-backend.');
}

const getStorage = () => {
  return admin.storage().bucket();
};

module.exports = {
  admin,
  getStorage,
};
