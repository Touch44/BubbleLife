/**
 * services/klre-index.js
 * KLRE — TF-IDF index builder, updater, and query layer.
 * Builds searchable vector representations of every entity.
 * [v6.6.0]
 */

import { getAllEntityTypes, getEntityTypeConfig } from '../core/graph-engine.js';
import { getEntitiesByType, saveKlreIndex, getKlreIndex } from '../core/db.js';
import { emit, EVENTS } from '../core/events.js';
import { STOP_WORDS } from './klre-signals.js';

// ── Constants ─────────────────────────────────────────────── //
const NAMED_ENTITY_BOOST = 3.0;
const MIN_TERM_LENGTH    = 3;
const CORPUS_CACHE_TTL   = 3600000; // 1 hour in ms

// ── Module-level corpus cache ─────────────────────────────── //
let _corpusStats  = null; // {docCount, termDocFreq}
let _corpusCacheTime = 0;

// ── Private text helpers ──────────────────────────────────── //

/**
 * Strip HTML tags from a string.
 * @param {string} str
 * @returns {string}
 */
function _stripHtml(str) {
  return String(str || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Tokenise a text string for TF-IDF.
 * @param {string} text
 * @returns {string[]}
 */
function _tokenise(text) {
  return _stripHtml(text)
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter(t => t.length >= MIN_TERM_LENGTH && !STOP_WORDS.has(t));
}

/**
 * Build a plain-text representation of an entity for indexing.
 * Mirrors the pattern used in search.js _buildIndex().
 * Skips: meta fields, relation fields (UUIDs), null/undefined values.
 * @param {Object} entity
 * @returns {string}
 */
function _buildEntityText(entity) {
  const cfg    = getEntityTypeConfig(entity.type);
  const fields = cfg?.fields ?? [];
  const fieldMap = new Map(fields.map(f => [f.key, f]));

  const SKIP = new Set([
    'id','type','createdAt','updatedAt','createdBy','deleted',
    '_authorName','_authorPersonId',
  ]);

  const parts = [];
  for (const [key, val] of Object.entries(entity)) {
    if (SKIP.has(key) || val == null) continue;

    const fieldCfg = fieldMap.get(key);
    // Skip relation fields — they store UUIDs, not readable text
    if (fieldCfg && fieldCfg.type === 'relation') continue;

    let text;
    if (Array.isArray(val)) {
      // Checklist: join .text values; tags/multiselect: join strings
      if (val.length && typeof val[0] === 'object' && val[0] !== null && 'text' in val[0]) {
        text = val.map(item => item.text || '').join(' ');
      } else {
        text = val.join(' ');
      }
    } else {
      text = String(val);
    }

    // Rich-text / body fields: strip HTML first
    const isRichText = fieldCfg && fieldCfg.type === 'richtext';
    const isBodyField = /body|content|notes|description/i.test(key);
    if (isRichText || isBodyField) {
      text = _stripHtml(text);
    }

    if (text.trim()) parts.push(text);
  }

  return parts.join(' ');
}

/**
 * Compute TF-IDF vector for a token list.
 * @param {string[]} tokens
 * @param {{docCount:number, termDocFreq:{[term:string]:number}}} corpusStats
 * @returns {{[term:string]:number}} sparse TF-IDF vector
 */
function _computeTFIDF(tokens, corpusStats) {
  if (!tokens.length) return {};

  // Term frequencies
  const counts = {};
  for (const t of tokens) counts[t] = (counts[t] || 0) + 1;
  const total = tokens.length;

  const vector = {};
  for (const [term, cnt] of Object.entries(counts)) {
    const tf  = cnt / total;
    const idf = Math.log(1 + corpusStats.docCount / (1 + (corpusStats.termDocFreq[term] || 0)));
    vector[term] = tf * idf;
  }
  return vector;
}

// ── Public: corpus stats ──────────────────────────────────── //

/**
 * Build corpus statistics from a list of entities.
 * @param {Object[]} allEntities
 * @returns {{docCount:number, termDocFreq:{[term:string]:number}}}
 */
export function buildCorpusStats(allEntities) {
  const termDocFreq = {};
  for (const entity of allEntities) {
    const tokens = new Set(_tokenise(_buildEntityText(entity)));
    for (const t of tokens) {
      termDocFreq[t] = (termDocFreq[t] || 0) + 1;
    }
  }
  return { docCount: allEntities.length, termDocFreq };
}

// ── Private: single entity index ─────────────────────────── //

/**
 * Build and persist the KLRE index entry for one entity.
 * @param {Object} entity
 * @param {{docCount:number, termDocFreq:{}}} corpusStats
 * @param {Set<string>} titleSet - lowercase title strings for named entity boosting
 */
async function _buildEntityIndex(entity, corpusStats, titleSet) {
  const rawText = _buildEntityText(entity);
  const tokens  = _tokenise(rawText);
  const vector  = _computeTFIDF(tokens, corpusStats);

  // Boost tokens that match known entity titles
  for (const term of Object.keys(vector)) {
    if (titleSet.has(term)) vector[term] *= NAMED_ENTITY_BOOST;
  }

  await saveKlreIndex({
    entityId:   entity.id,
    entityType: entity.type,
    vector,
    searchBlob: rawText.toLowerCase(),
    updatedAt:  new Date().toISOString(),
  });
}

// ── Public: full index build ──────────────────────────────── //

/**
 * Build the complete KLRE index for all entities.
 * Emits EVENTS.KLRE_INDEX_READY when done.
 * @returns {Promise<number>} count of indexed entities
 */
export async function buildFullIndex() {
  // Load all entity types using getAllEntityTypes()
  const typeKeys    = getAllEntityTypes().map(t => t.key);
  const allEntities = (
    await Promise.all(typeKeys.map(k => getEntitiesByType(k)))
  ).flat().filter(e => !e.deleted);

  // Build and cache corpus stats
  _corpusStats     = buildCorpusStats(allEntities);
  _corpusCacheTime = Date.now();

  // Build title set for named entity boost
  // Each entity type may use different title fields
  const titleSet = new Set(
    allEntities
      .map(e => (e.name || e.title || e.text || e.subject || '').toLowerCase())
      .filter(Boolean)
  );

  // Index each entity
  await Promise.all(allEntities.map(e => _buildEntityIndex(e, _corpusStats, titleSet)));

  emit(EVENTS.KLRE_INDEX_READY, { count: allEntities.length });
  return allEntities.length;
}

// ── Public: single entity update ─────────────────────────── //

/**
 * Re-index a single entity after it has been saved.
 * Uses cached corpus stats if fresh; rebuilds if stale.
 * @param {Object} entity
 */
export async function updateEntityIndex(entity) {
  if (!entity || !entity.id) return;

  // Use cached corpus or rebuild if stale
  if (!_corpusStats || (Date.now() - _corpusCacheTime) > CORPUS_CACHE_TTL) {
    const typeKeys    = getAllEntityTypes().map(t => t.key);
    const allEntities = (
      await Promise.all(typeKeys.map(k => getEntitiesByType(k)))
    ).flat().filter(e => !e.deleted);
    _corpusStats     = buildCorpusStats(allEntities);
    _corpusCacheTime = Date.now();
  }

  // Title set is minimal for single-entity update (no full entity list available cheaply)
  const titleSet = new Set();
  await _buildEntityIndex(entity, _corpusStats, titleSet);
  emit(EVENTS.KLRE_INDEX_UPDATED, { entityId: entity.id });
}

// ── Public: query ─────────────────────────────────────────── //

/**
 * Retrieve the stored KLRE index entry for an entity.
 * @param {string} entityId
 * @returns {Promise<Object|null>}
 */
export async function getIndexEntry(entityId) {
  return getKlreIndex(entityId);
}
