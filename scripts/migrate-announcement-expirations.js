#!/usr/bin/env node
/**
 * Safe Migration Script: Announcement Expiration Normalization
 *
 * Ensures every announcement document in Firestore has a valid Firestore Timestamp
 * in `expiresAt` so it satisfies strict Firestore Security Rules (`expiresAt is timestamp`
 * and `expiresAt > request.time`).
 *
 * Behavior:
 * - Announcements with missing (`undefined`), `null`, or empty-string (`""`) `expiresAt`
 *   are assigned the consistent far-future sentinel Timestamp (`9999-12-31T23:59:59.000Z`).
 * - Announcements with a valid ISO date string, numeric epoch ms, or Date in `expiresAt`
 *   are converted to a Firestore `Timestamp`.
 * - Published announcements with malformed/unparseable `expiresAt` values are never
 *   silently treated as valid published announcements; they are quarantined to
 *   `status: "draft"` with `migrationQuarantineReason` and assigned the far-future
 *   sentinel Timestamp until reviewed by an administrator.
 *
 * Usage:
 *   node scripts/migrate-announcement-expirations.js --dry-run   (default; no writes)
 *   node scripts/migrate-announcement-expirations.js --execute   (applies updates in batches)
 */

import admin from "firebase-admin";

const ANNOUNCEMENT_FAR_FUTURE_EXPIRES_AT_ISO = "9999-12-31T23:59:59.000Z";
const MAX_BATCH_OPERATIONS = 350;

export function classifyAnnouncementExpirationRecord(data, TimestampClass = admin.firestore?.Timestamp) {
  const raw = data?.expiresAt;
  const farFutureDate = new Date(ANNOUNCEMENT_FAR_FUTURE_EXPIRES_AT_ISO);
  const makeTimestamp = (d) =>
    TimestampClass && typeof TimestampClass.fromDate === "function"
      ? TimestampClass.fromDate(d)
      : d;

  if (raw && typeof raw.toMillis === "function") {
    const ms = raw.toMillis();
    if (Number.isFinite(ms)) {
      return { action: "already_valid", expiresAt: raw };
    }
  }

  if (raw === undefined || raw === null || raw === "") {
    return {
      action: "normalized_no_expiry",
      expiresAt: makeTimestamp(farFutureDate),
    };
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return {
        action: "normalized_no_expiry",
        expiresAt: makeTimestamp(farFutureDate),
      };
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return {
        action: "converted_to_timestamp",
        expiresAt: makeTimestamp(parsed),
      };
    }
  } else if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return {
        action: "converted_to_timestamp",
        expiresAt: makeTimestamp(parsed),
      };
    }
  } else if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return {
      action: "converted_to_timestamp",
      expiresAt: makeTimestamp(raw),
    };
  }

  return {
    action: "quarantined_malformed",
    expiresAt: makeTimestamp(farFutureDate),
    quarantineStatus: data?.status === "published" ? "draft" : data?.status || "draft",
    migrationQuarantineReason: "Malformed expiresAt value quarantined during migration.",
  };
}

export async function runAnnouncementExpirationMigration({
  db,
  dryRun = true,
  TimestampClass = admin.firestore?.Timestamp,
  ServerValue = admin.firestore?.FieldValue,
} = {}) {
  if (!db) {
    throw new Error("A Firestore database instance is required.");
  }

  const snap = await db.collection("announcements").get();
  const summary = {
    dryRun: Boolean(dryRun),
    scanned: snap.size,
    alreadyValid: 0,
    normalizedNoExpiry: 0,
    convertedStrings: 0,
    quarantinedMalformed: 0,
    updatedIds: [],
    quarantinedIds: [],
  };

  let batch = db.batch();
  let opsInBatch = 0;

  for (const docSnap of snap.docs) {
    const data = docSnap.data() || {};
    const decision = classifyAnnouncementExpirationRecord(data, TimestampClass);

    if (decision.action === "already_valid") {
      summary.alreadyValid += 1;
      continue;
    }

    const updatePayload = {
      expiresAt: decision.expiresAt,
      updatedAt:
        ServerValue && typeof ServerValue.serverTimestamp === "function"
          ? ServerValue.serverTimestamp()
          : new Date().toISOString(),
    };

    if (decision.action === "normalized_no_expiry") {
      summary.normalizedNoExpiry += 1;
      summary.updatedIds.push(docSnap.id);
    } else if (decision.action === "converted_to_timestamp") {
      summary.convertedStrings += 1;
      summary.updatedIds.push(docSnap.id);
    } else if (decision.action === "quarantined_malformed") {
      summary.quarantinedMalformed += 1;
      summary.quarantinedIds.push(docSnap.id);
      updatePayload.status = decision.quarantineStatus;
      updatePayload.migrationQuarantineReason = decision.migrationQuarantineReason;
    }

    if (!dryRun) {
      batch.set(docSnap.ref, updatePayload, { merge: true });
      opsInBatch += 1;
      if (opsInBatch >= MAX_BATCH_OPERATIONS) {
        await batch.commit();
        batch = db.batch();
        opsInBatch = 0;
      }
    }
  }

  if (!dryRun && opsInBatch > 0) {
    await batch.commit();
  }

  return summary;
}

const isMainModule =
  typeof process !== "undefined" &&
  process.argv?.[1] &&
  process.argv[1].endsWith("migrate-announcement-expirations.js");

if (isMainModule) {
  const execute = process.argv.includes("--execute");
  const dryRun = !execute;

  if (!admin.apps.length) {
    admin.initializeApp();
  }

  runAnnouncementExpirationMigration({
    db: admin.firestore(),
    dryRun,
  })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("Announcement expiration migration failed:", err);
      process.exit(1);
    });
}
