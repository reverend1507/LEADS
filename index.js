/**
 * Leads Backend - Firebase Functions
 * Handles wallet, purchases, and Paystack payments
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");

// ✅ Initialize Firebase Admin
admin.initializeApp();
const db = admin.firestore();

/**
 * 🟣 API 1: Verify Paystack Payment
 * - Frontend calls this with { reference, userId }
 * - Uses your Paystack Secret Key stored in Firebase config
 * - Credits wallet & logs transaction
 */
exports.verifyPaystackPayment = functions.https.onCall(async (data, context) => {
  const { reference, userId } = data;

  if (!reference || !userId) {
    return { success: false, error: "Missing required fields" };
  }

  try {
    // Call Paystack API
    const res = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${functions.config().paystack.secret}`, // 🔑 your Paystack Secret Key (hidden in config)
        },
      }
    );

    const result = res.data;

    if (result.status && result.data.status === "success") {
      const amount = result.data.amount / 100; // convert kobo → naira

      // Update user wallet
      await db.collection("users").doc(userId).update({
        wallet: admin.firestore.FieldValue.increment(amount),
      });

      // Log transaction
      await db.collection("transactions").add({
        userId,
        amount,
        type: "credit",
        gateway: "paystack",
        status: "success",
        reference,
        createdAt: admin.firestore.Timestamp.now(),
      });

      return { success: true, amount };
    } else {
      return { success: false, error: "Payment verification failed" };
    }
  } catch (err) {
    console.error("Paystack verify error:", err.message);
    return { success: false, error: err.message };
  }
});

/**
 * 🟣 API 2: Buy Code
 * - Deducts from wallet
 * - Logs purchase
 * - Returns unlocked booking code
 */
exports.buyCode = functions.https.onCall(async (data, context) => {
  const { userId, codeId } = data;

  if (!userId || !codeId) {
    return { success: false, error: "Missing required fields" };
  }

  try {
    const userRef = db.collection("users").doc(userId);
    const codeRef = db.collection("codes").doc(codeId);

    const [userDoc, codeDoc] = await Promise.all([
      userRef.get(),
      codeRef.get(),
    ]);

    if (!userDoc.exists || !codeDoc.exists) {
      return { success: false, error: "User or Code not found" };
    }

    const user = userDoc.data();
    const code = codeDoc.data();

    if (user.wallet < code.price) {
      return { success: false, error: "Insufficient balance" };
    }

    // Deduct wallet
    await userRef.update({
      wallet: admin.firestore.FieldValue.increment(-code.price),
    });

    // Save purchase history
    await db.collection("purchases").add({
      userId,
      codeId,
      amount: code.price,
      createdAt: admin.firestore.Timestamp.now(),
    });

    return { success: true, code: code.bookingCode };
  } catch (err) {
    console.error("Buy code error:", err.message);
    return { success: false, error: err.message };
  }
});

/**
 * 🟣 API 3: Get User Purchases
 * - Returns all purchase history for a user
 */
exports.getPurchases = functions.https.onCall(async (data, context) => {
  const { userId } = data;

  if (!userId) {
    return { success: false, error: "UserId is required" };
  }

  try {
    const snapshot = await db
      .collection("purchases")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .get();

    const purchases = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return { success: true, purchases };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * 🟣 API 4: Replenish Codes (Scheduled every 24h)
 * - Deletes old codes
 * - Adds fresh daily codes
 */
exports.replenishCodes = functions.pubsub
  .schedule("every 24 hours")
  .onRun(async () => {
    try {
      // Delete old codes
      const snapshot = await db.collection("codes").get();
      const batch = db.batch();
      snapshot.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();

      // Insert sample codes (replace with your real logic)
      const codes = [
        {
          teams: "Chelsea vs Arsenal",
          betType: "Over/Under",
          odds: 2.5,
          guarantee: 20,
          price: 1500,
          bookingCode: "SPTY-ABC123",
          category: "over-under",
          isVip: false,
          createdAt: admin.firestore.Timestamp.now(),
        },
        {
          teams: "Man Utd vs Liverpool",
          betType: "Correct Score",
          odds: 10.5,
          guarantee: 15,
          price: 7000,
          bookingCode: "FTBL-XYZ987",
          category: "vip",
          isVip: true,
          createdAt: admin.firestore.Timestamp.now(),
        },
      ];

      for (let c of codes) {
        await db.collection("codes").add(c);
      }

      console.log("✅ Codes replenished successfully");
      return null;
    } catch (err) {
      console.error("Replenish error:", err.message);
      return null;
    }
  });
