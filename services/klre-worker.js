/**
 * services/klre-worker.js
 * KLRE — Web Worker for background index building.
 * Runs TF-IDF indexing off the main thread to prevent UI jank.
 * Communicates via postMessage — no ES module syntax (plain browser worker).
 * [v6.7.0]
 */

'use strict';

// ── Stop words (mirrors klre-signals.js STOP_WORDS) ──────────── //
// NOTE: This is intentionally duplicated because this is a plain Worker (not ES module).
// If STOP_WORDS changes in klre-signals.js, update this list too. Last synced: v6.8.0
var STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'is','was','are','were','be','been','has','have','had','do','did',
  'will','would','could','should','may','might','get','got','need','want',
  'like','just','also','this','that','these','those','it','its','not','no',
  'yes','ok','my','our','your','his','her','their','we','i','he','she','they',
  'family','home','today','week','month','year','task','note',
  'done','check','follow','up','call','important',
]);

var MIN_TERM_LENGTH = 3;

// ── Text helpers (mirrored from klre-index.js) ───────────────── //
function stripHtml(str) {
  return (str || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenise(text) {
  return stripHtml(text)
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter(function(t) { return t.length >= MIN_TERM_LENGTH && !STOP_WORDS.has(t); });
}

function buildEntityText(entity) {
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var SKIP = new Set(['id','type','createdAt','updatedAt','createdBy','deleted','_authorName','_authorPersonId']);
  var parts = [];

  for (var key in entity) {
    if (!Object.prototype.hasOwnProperty.call(entity, key)) continue;
    var val = entity[key];
    if (SKIP.has(key) || val == null) continue;
    if (typeof val === 'boolean') continue;

    var text;
    if (Array.isArray(val)) {
      if (val.length === 0) continue;
      if (val.length && typeof val[0] === 'object' && val[0] !== null && 'text' in val[0]) {
        text = val.map(function(item) { return item.text || ''; }).join(' ');
      } else {
        text = val.join(' ');
      }
    } else {
      text = String(val);
    }

    // Skip UUID-format strings
    if (UUID_RE.test(text.trim())) continue;

    // Strip HTML from body/content fields
    if (/body|content|notes|description/i.test(key)) {
      text = stripHtml(text);
    }

    if (text.trim()) parts.push(text);
  }
  return parts.join(' ');
}

function computeTFIDF(tokens, corpusStats) {
  if (!tokens.length) return {};
  var counts = {};
  for (var i = 0; i < tokens.length; i++) {
    counts[tokens[i]] = (counts[tokens[i]] || 0) + 1;
  }
  var total = tokens.length;
  var vector = {};
  for (var term in counts) {
    var tf  = counts[term] / total;
    var idf = Math.log(1 + corpusStats.docCount / (1 + (corpusStats.termDocFreq[term] || 0)));
    vector[term] = tf * idf;
  }
  return vector;
}

function buildCorpusStats(entities) {
  var termDocFreq = {};
  for (var i = 0; i < entities.length; i++) {
    var tokens = tokenise(buildEntityText(entities[i]));
    var seen   = new Set(tokens);
    seen.forEach(function(t) {
      termDocFreq[t] = (termDocFreq[t] || 0) + 1;
    });
  }
  return { docCount: entities.length, termDocFreq: termDocFreq };
}

// ── IDB helpers ───────────────────────────────────────────────── //
var DB_NAME    = 'familyhub_v2';
var DB_VERSION = 2;
var _db        = null;
// B06: In-worker corpus cache — avoids O(N) corpus rebuild on every entity update.
// Cache is valid for 1 hour (same as main-thread CORPUS_CACHE_TTL).
var _workerCorpus     = null;
var _workerCorpusTime = 0;
var WORKER_CORPUS_TTL = 3600000; // 1 hour

function openDB() {
  return new Promise(function(resolve, reject) {
    if (_db) { resolve(_db); return; }
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror   = function() { reject(req.error); };
    req.onsuccess = function() { _db = req.result; resolve(_db); };
    req.onupgradeneeded = function() {/* upgrade handled by main thread */};
  });
}

function getAllEntities(db) {
  return new Promise(function(resolve, reject) {
    var tx      = db.transaction('entities', 'readonly');
    var store   = tx.objectStore('entities');
    var request = store.getAll();
    request.onsuccess = function() { resolve(request.result || []); };
    request.onerror   = function() { reject(request.error); };
  });
}

function putIndexEntry(db, entry) {
  return new Promise(function(resolve, reject) {
    var tx    = db.transaction('klre_index', 'readwrite');
    var store = tx.objectStore('klre_index');
    var req   = store.put(entry);
    req.onsuccess = function() { resolve(); };
    req.onerror   = function() { reject(req.error); };
  });
}

// ── BUILD INDEX ───────────────────────────────────────────────── //
async function handleBuildIndex() {
  try {
    var db       = await openDB();
    var all      = await getAllEntities(db);
    var entities = all.filter(function(e) { return !e.deleted; });

    var corpusStats  = buildCorpusStats(entities);
    var total        = entities.length;
    var CHUNK_SIZE   = 50;
    var processed    = 0;

    // Build title set for named entity boosting
    var titleSet = new Set(
      entities.map(function(e) {
        return (e.name || e.title || e.text || e.subject || '').toLowerCase();
      }).filter(Boolean)
    );

    // Index in chunks
    for (var i = 0; i < entities.length; i += CHUNK_SIZE) {
      var chunk = entities.slice(i, i + CHUNK_SIZE);
      var promises = chunk.map(function(entity) {
        var rawText = buildEntityText(entity);
        var tokens  = tokenise(rawText);
        var vector  = computeTFIDF(tokens, corpusStats);

        // Named entity boost
        Object.keys(vector).forEach(function(term) {
          if (titleSet.has(term)) vector[term] *= 3.0;
        });

        // Build tagFrequencyMap inline
        var entry = {
          entityId:   entity.id,
          entityType: entity.type,
          vector:     vector,
          searchBlob: rawText.toLowerCase(),
          updatedAt:  new Date().toISOString(),
        };
        return putIndexEntry(db, entry);
      });
      await Promise.all(promises);
      processed += chunk.length;

      // Report progress every chunk
      self.postMessage({ type: 'INDEX_PROGRESS', count: processed, total: total });
    }

    // Build tagFrequencyMap and include in completion message
    var tagFrequencyMap = {};
    entities.forEach(function(e) {
      if (Array.isArray(e.tags)) {
        e.tags.forEach(function(tag) {
          tagFrequencyMap[tag] = (tagFrequencyMap[tag] || 0) + 1;
        });
      }
    });

    self.postMessage({ type: 'INDEX_COMPLETE', count: total, tagFrequencyMap: tagFrequencyMap });
  } catch (err) {
    self.postMessage({ type: 'INDEX_ERROR', error: String(err) });
  }
}

// ── UPDATE ENTITY ─────────────────────────────────────────────── //
async function handleUpdateEntity(entity) {
  if (!entity || !entity.id) return;
  try {
    var db = await openDB();

    // B06: Use cached corpus stats — avoid O(N) full entity scan per entity update.
    var corpus;
    if (_workerCorpus && (Date.now() - _workerCorpusTime) < WORKER_CORPUS_TTL) {
      corpus = _workerCorpus;
    } else {
      var all      = await getAllEntities(db);
      var entities = all.filter(function(e) { return !e.deleted; });
      corpus             = buildCorpusStats(entities);
      _workerCorpus      = corpus;
      _workerCorpusTime  = Date.now();
    }

    var rawText    = buildEntityText(entity);
    var tokens     = tokenise(rawText);
    var vector     = computeTFIDF(tokens, corpus);

    var entry = {
      entityId:   entity.id,
      entityType: entity.type,
      vector:     vector,
      searchBlob: rawText.toLowerCase(),
      updatedAt:  new Date().toISOString(),
    };
    await putIndexEntry(db, entry);
    self.postMessage({ type: 'ENTITY_UPDATED', entityId: entity.id });
  } catch (err) {
    self.postMessage({ type: 'ENTITY_UPDATE_ERROR', entityId: entity.id, error: String(err) });
  }
}

// ── Message handler ───────────────────────────────────────────── //
self.onmessage = function(e) {
  var data = e.data;
  if (!data) return;

  if (data.type === 'BUILD_INDEX') {
    // B20: Explicit .catch() so unhandled rejections send INDEX_ERROR to main thread
    handleBuildIndex().catch(function(err) {
      self.postMessage({ type: 'INDEX_ERROR', error: String(err) });
    });
  } else if (data.type === 'UPDATE_ENTITY') {
    // B18: Invalidate corpus cache on entity update so next full build uses fresh corpus
    _workerCorpus = null;
    handleUpdateEntity(data.entity).catch(function(err) {
      self.postMessage({ type: 'ENTITY_UPDATE_ERROR', entityId: data.entity?.id, error: String(err) });
    });
  }
};
