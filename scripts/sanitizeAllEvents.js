// scripts/sanitizeAllEvents.js
//
// Usage:
//   # Dry-run (default) — shows counts and example changes, does NOT write
//   node scripts/sanitizeAllEvents.js
//
//   # Apply changes
//   node scripts/sanitizeAllEvents.js --apply
//
const mongoose = require('mongoose');
const Event = require('../src/models/Event');
const argv = require('minimist')(process.argv.slice(2));
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/webhook-db';

const BATCH_OPS = 500; // bulkWrite op batch size
const APPLY = !!argv.apply; // pass --apply to commit

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function normalizeFinalHttpStatus(val) {
  // Accept number -> return number
  if (isFiniteNumber(val)) return val;
  // Accept numeric string -> number
  if (typeof val === 'string') {
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  }
  // null/undefined/other -> null
  return null;
}

function normalizeLogEntry(l) {
  if (!l || typeof l !== 'object') return null;
  const attempt = (l.attempt !== undefined && Number.isFinite(Number(l.attempt))) ? Number(l.attempt) : null;
  const status = (l.status !== undefined && Number.isFinite(Number(l.status))) ? Number(l.status) : null;
  const response = l.response != null ? String(l.response) : null;
  const timestamp = l.timestamp ? new Date(l.timestamp) : new Date();
  return { attempt, status, response, timestamp };
}

function normalizeFailureType(val) {
  if (val === 'TRANSIENT' || val === 'PERMANENT') return val;
  return null;
}

function buildSanitizedPatch(doc) {
  const patch = {};
  const original = doc.toObject ? doc.toObject() : doc;

  // finalHttpStatus: move non-numeric strings to errorCode/lastError, numeric -> keep
  const candidate = original.finalHttpStatus ?? original.httpStatus ?? null;
  const normalizedFinal = normalizeFinalHttpStatus(candidate);

  if (normalizedFinal !== (original.finalHttpStatus === undefined ? null : original.finalHttpStatus)) {
    patch.finalHttpStatus = normalizedFinal;
  }

  // If original.finalHttpStatus was a non-numeric string, preserve in errorCode/lastError
  if (typeof original.finalHttpStatus === 'string' && original.finalHttpStatus.trim() !== '') {
    if (!original.errorCode || original.errorCode === null) patch.errorCode = original.finalHttpStatus;
    if (!original.lastError || original.lastError === null) patch.lastError = original.finalHttpStatus;
    // null out numeric field (already handled above)
    if (patch.finalHttpStatus === undefined) patch.finalHttpStatus = null;
  }

  // If http status was embedded in logs as string, we will normalize logs below

  // Ensure failureType valid
  const normalizedFailureType = normalizeFailureType(original.failureType);
  if (normalizedFailureType !== original.failureType) patch.failureType = normalizedFailureType;

  // attemptCount -> numeric or 0
  const attemptCount = (original.attemptCount !== undefined && Number.isFinite(Number(original.attemptCount)))
    ? Number(original.attemptCount)
    : 0;
  if (attemptCount !== original.attemptCount) patch.attemptCount = attemptCount;

  // lastError and errorCode defaults
  if (original.lastError === undefined) patch.lastError = null;
  if (original.errorCode === undefined) patch.errorCode = null;

  // deliverySemantics default
  if (!original.deliverySemantics) patch.deliverySemantics = 'AT_LEAST_ONCE_UNORDERED';

  // Normalize logs array fully if present or if we need to create it
  let logsChanged = false;
  const origLogs = Array.isArray(original.logs) ? original.logs : [];
  const normalizedLogs = origLogs.map(l => {
    const nl = normalizeLogEntry(l);
    // flag change if types differ
    if (!l) { logsChanged = true; return nl; }
    if ((l.attempt !== nl.attempt) || (l.status !== nl.status) || (String(l.response || '') !== String(nl.response || ''))) {
      logsChanged = true;
    }
    // if timestamp string -> Date will differ, we don't treat as significant for change count
    return nl;
  });

  if (logsChanged) patch.logs = normalizedLogs;

  // If logs empty but there is a log-like field passed in (logEntry/httpStatus in worker) -> do nothing here
  // (we only sanitize existing logs)

  return Object.keys(patch).length ? patch : null;
}

async function run() {
  console.log(`Connecting to ${MONGO_URI} ...`);
  await mongoose.connect(MONGO_URI, {});

  const cursor = Event.find().cursor();
  let ops = [];
  let processed = 0;
  let toUpdate = 0;
  let examples = [];
  let batchCount = 0;

  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    processed++;
    const patch = buildSanitizedPatch(doc);

    if (patch) {
      toUpdate++;
      const op = {
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: patch }
        }
      };
      ops.push(op);

      if (examples.length < 5) {
        examples.push({
          _id: doc._id.toString(),
          before: {
            finalHttpStatus: doc.finalHttpStatus,
            failureType: doc.failureType,
            attemptCount: doc.attemptCount,
            errorCode: doc.errorCode,
            lastError: doc.lastError,
            logsSample: Array.isArray(doc.logs) ? doc.logs.slice(0,1) : doc.logs
          },
          after: patch
        });
      }
    }

    if (ops.length >= BATCH_OPS) {
      batchCount++;
      if (APPLY) {
        await Event.bulkWrite(ops, { ordered: false });
        console.log(`Applied batch #${batchCount} (${ops.length} ops)`);
      } else {
        console.log(`Prepared batch #${batchCount} (${ops.length} ops) [dry-run]`);
      }
      ops = [];
    }
  }

  // final flush
  if (ops.length > 0) {
    batchCount++;
    if (APPLY) {
      await Event.bulkWrite(ops, { ordered: false });
      console.log(`Applied final batch #${batchCount} (${ops.length} ops)`);
    } else {
      console.log(`Prepared final batch #${batchCount} (${ops.length} ops) [dry-run]`);
    }
  }

  console.log('--- Summary ---');
  console.log('Processed documents:', processed);
  console.log('To update:', toUpdate);
  console.log('Batches:', batchCount);
  console.log('Mode:', APPLY ? 'APPLY (writes performed)' : 'DRY-RUN (no writes)');
  console.log('\nExamples (first up to 5 changes):');
  examples.forEach((ex, i) => {
    console.log(`\n[${i+1}] id=${ex._id}`);
    console.log(' before:', ex.before);
    console.log(' after :', ex.after);
  });

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
