/**
 * services/klre-signals.js
 * KLRE — Pure signal computation functions.
 * NO IDB imports, NO side effects, NO async.
 * All functions return 0.0–1.0 scores.
 * [v6.6.0]
 */

// ── Stop-words ─────────────────────────────────────────────── //
// Family-context stop words — terms too common to signal relevance.
// Note: 'done' appears EXACTLY ONCE in this list.
export const STOP_WORDS = Object.freeze(new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'is','was','are','were','be','been','has','have','had','do','did',
  'will','would','could','should','may','might','get','got','need','want',
  'like','just','also','this','that','these','those','it','its','not','no',
  'yes','ok','my','our','your','his','her','their','we','i','he','she','they',
  'family','home','today','week','month','year','task','note',
  'done','check','follow','up','call','important',
]));

// ── S1: Text cosine similarity ─────────────────────────────── //

/**
 * Compute cosine similarity between two TF-IDF vectors.
 * @param {Object} vectorA - {term: weight} sparse object
 * @param {Object} vectorB - {term: weight} sparse object
 * @returns {number} 0.0–1.0
 */
export function computeS1_textCosine(vectorA, vectorB) {
  if (!vectorA || !vectorB) return 0;
  const keysA = Object.keys(vectorA);
  const keysB = Object.keys(vectorB);
  if (!keysA.length || !keysB.length) return 0;

  let dot = 0;
  for (const term of keysA) {
    if (vectorB[term]) dot += vectorA[term] * vectorB[term];
  }

  const magA = Math.sqrt(keysA.reduce((s, t) => s + vectorA[t] ** 2, 0));
  const magB = Math.sqrt(keysB.reduce((s, t) => s + vectorB[t] ** 2, 0));
  if (magA === 0 || magB === 0) return 0;

  return Math.min(1.0, dot / (magA * magB));
}

// ── S2: Shared person neighbors ────────────────────────────── //

/**
 * Score based on shared person neighbors.
 * IMPORTANT: Neighbors must be pre-enriched by the engine with entityType.
 * @param {Array} enrichedNeighborsA - [{entityId, entityType, relation, direction}]
 * @param {Array} enrichedNeighborsB - [{entityId, entityType, relation, direction}]
 * @returns {number} 0.0–1.0
 */
export function computeS2_sharedPerson(enrichedNeighborsA, enrichedNeighborsB) {
  if (!enrichedNeighborsA || !enrichedNeighborsB) return 0;

  const personsA = new Set(
    enrichedNeighborsA.filter(n => n.entityType === 'person').map(n => n.entityId)
  );
  const personsB = new Set(
    enrichedNeighborsB.filter(n => n.entityType === 'person').map(n => n.entityId)
  );

  if (!personsA.size || !personsB.size) return 0;

  let intersection = 0;
  for (const id of personsA) { if (personsB.has(id)) intersection++; }

  return intersection / Math.max(1, Math.sqrt(personsA.size * personsB.size));
}

// ── S3: Shared project neighbors ───────────────────────────── //

/**
 * Score based on shared project neighbors, with optional context bonus.
 * @param {Array} enrichedNeighborsA - pre-enriched with entityType
 * @param {Array} enrichedNeighborsB - pre-enriched with entityType
 * @param {string|null} contextA - entity.context for focal entity (or null)
 * @param {string|null} contextB - entity.context for candidate entity (or null)
 * @returns {number} 0.0–1.0
 */
export function computeS3_sharedProject(enrichedNeighborsA, enrichedNeighborsB, contextA, contextB) {
  if (!enrichedNeighborsA || !enrichedNeighborsB) return 0;

  const projectsA = new Set(
    enrichedNeighborsA.filter(n => n.entityType === 'project').map(n => n.entityId)
  );
  const projectsB = new Set(
    enrichedNeighborsB.filter(n => n.entityType === 'project').map(n => n.entityId)
  );

  let jaccard = 0;
  if (projectsA.size > 0 || projectsB.size > 0) {
    let intersection = 0;
    for (const id of projectsA) { if (projectsB.has(id)) intersection++; }
    const union = projectsA.size + projectsB.size - intersection;
    jaccard = union > 0 ? intersection / union : 0;
  }

  // Context bonus — only when both entities have a non-null equal context
  let bonus = 0;
  if (contextA && contextB && typeof contextA === 'string' && typeof contextB === 'string'
      && contextA === contextB) {
    bonus = 0.3;
  }

  return Math.min(1.0, jaccard + bonus);
}

// ── S4: Tag Jaccard with rarity weighting ──────────────────── //

/**
 * Rarity-weighted tag Jaccard similarity.
 * @param {string[]} tagsA
 * @param {string[]} tagsB
 * @param {Object} tagFrequencyMap - {tag: entityCount}
 * @param {number} totalEntityCount - total indexed entities (from corpusStats.docCount)
 * @returns {number} 0.0–1.0
 */
export function computeS4_tagJaccard(tagsA, tagsB, tagFrequencyMap, totalEntityCount) {
  if (!tagsA || !tagsB || !tagsA.length || !tagsB.length) return 0;

  const setA = new Set(tagsA);
  const setB = new Set(tagsB);
  const setAll = new Set([...setA, ...setB]);

  let intersection = 0;
  let weightedIntersection = 0;
  const total = totalEntityCount || 1;

  for (const tag of setA) {
    if (setB.has(tag)) {
      intersection++;
      const freq = (tagFrequencyMap && tagFrequencyMap[tag]) ? tagFrequencyMap[tag] : 0;
      const rarity = freq / total;
      let weight;
      if (rarity < 0.05)       weight = 2.0;
      else if (rarity <= 0.20) weight = 1.0;
      else                      weight = 0.3;
      weightedIntersection += weight;
    }
  }

  if (intersection === 0) return 0;

  const union = setAll.size;
  // Average weight of shared tags * Jaccard coefficient
  const avgWeight = weightedIntersection / intersection;
  const jaccard = intersection / union;

  return Math.min(1.0, avgWeight * jaccard);
}

// ── S5: Temporal decay ─────────────────────────────────────── //

/**
 * Temporal proximity decay between two timestamps.
 * NEVER uses toISOString() — uses getTime() only.
 * @param {string} tsA - ISO timestamp string (createdAt)
 * @param {string} tsB - ISO timestamp string (createdAt)
 * @returns {number} 0.0–1.0 (acts as multiplier in computeComposite)
 */
export function computeS5_temporalDecay(tsA, tsB) {
  if (!tsA || !tsB) return 0;
  const diffMs = Math.abs(new Date(tsA).getTime() - new Date(tsB).getTime());
  if (isNaN(diffMs)) return 0;

  if (diffMs < 86400000)    return 1.0;  // same day
  if (diffMs < 604800000)   return 0.7;  // same week
  if (diffMs < 2592000000)  return 0.4;  // same month (~30d)
  if (diffMs < 31536000000) return 0.15; // same year
  return 0.0;
}

// ── S6: URL domain match ───────────────────────────────────── //

/**
 * Score based on shared URL domain.
 * IMPORTANT: Args are ENRICHED objects: {...entity, searchBlob: indexEntry?.searchBlob}
 * Raw entity objects have no searchBlob — engine must merge before calling.
 * @param {Object} entryA - enriched entity with searchBlob
 * @param {Object} entryB - enriched entity with searchBlob
 * @returns {number} 0.0–1.0
 */
export function computeS6_urlDomain(entryA, entryB) {
  if (!entryA || !entryB) return 0;

  function extractDomain(entry) {
    // Check common URL-holding fields in entity data
    const urlFields = [entry.url, entry.fileUrl, entry.source, entry.link, entry.linkUrl];
    for (const val of urlFields) {
      if (val && typeof val === 'string' && /^https?:\/\//i.test(val)) {
        try { return new URL(val).hostname.toLowerCase(); } catch { /* ignore */ }
      }
    }
    // Fallback: scan searchBlob for URLs
    if (entry.searchBlob) {
      const match = entry.searchBlob.match(/https?:\/\/([^\s"'/?#]+)/i);
      if (match) {
        try { return new URL('https://' + match[1]).hostname.toLowerCase(); } catch { /* ignore */ }
      }
    }
    return null;
  }

  const domainA = extractDomain(entryA);
  const domainB = extractDomain(entryB);

  if (!domainA && !domainB) return 0;

  // Both have URLs and share the same domain
  if (domainA && domainB && domainA === domainB) return 0.4;

  // One has a domain and it appears in the other's searchBlob
  if (domainA && entryB.searchBlob && entryB.searchBlob.toLowerCase().includes(domainA)) return 0.7;
  if (domainB && entryA.searchBlob && entryA.searchBlob.toLowerCase().includes(domainB)) return 0.7;

  return 0;
}

// ── S7: Co-access frequency ────────────────────────────────── //

/**
 * Normalize raw co-access count to 0.0–1.0.
 * 5 co-accesses in the same session window = max score.
 * @param {number} rawCoAccessCount - count of sessions where both entities were opened
 * @returns {number} 0.0–1.0
 */
export function computeS7_coAccess(rawCoAccessCount) {
  return Math.min(1.0, (rawCoAccessCount || 0) / 5);
}

// ── Composite score ────────────────────────────────────────── //

/**
 * Compute the final relevance score from all signals.
 * S5 (temporal) is a multiplier — NOT additive — so weights has no w5.
 * @param {Object} signals - {s1,s2,s3,s4,s5,s6,s7} all 0.0–1.0
 * @param {Object} weights - {w1,w2,w3,w4,w6,w7} learned multipliers (default 1.0)
 * @param {Object} boosts  - {health:bool, recency:bool}
 * @returns {number} 0.0–1.0
 */
export function computeComposite(signals, weights, boosts) {
  const s = signals || {};
  const w = weights || {};

  // Weighted additive combination (S5 excluded — it's a multiplier)
  const raw =
    (s.s1 || 0) * 0.35 * (w.w1 ?? 1) +
    (s.s2 || 0) * 0.20 * (w.w2 ?? 1) +
    (s.s3 || 0) * 0.18 * (w.w3 ?? 1) +
    (s.s4 || 0) * 0.12 * (w.w4 ?? 1) +
    (s.s6 || 0) * 0.10 * (w.w6 ?? 1) +
    (s.s7 || 0) * 0.05 * (w.w7 ?? 1);

  // S5 acts as a temporal proximity multiplier (boosts nearby items)
  const score = raw * (1 + (s.s5 || 0) * 0.15);

  // Apply special case boosts
  let final = score;
  if (boosts && boosts.health)   final *= 1.4;
  if (boosts && boosts.recency)  final *= 1.2;

  return Math.min(1.0, final);
}
