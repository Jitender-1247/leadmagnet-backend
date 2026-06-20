const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");
// JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);require("./serviceAccountKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

module.exports = { db , admin };