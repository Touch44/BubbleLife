<?php
/**
 * FamilyHub v3 — api/sync.php
 * [MAJOR] 3-C — MySQL Sync Endpoint
 *
 * Handles server-side sync for multi-device support via Hostinger MySQL.
 *
 * Actions (POST JSON { action, token, ... }):
 *   push       — save a batch of entities/edges from client
 *   pull       — fetch entities/edges updated since a timestamp
 *   handshake  — validate session token, return family_id + server time
 *
 * Tables:
 *   fh_sessions  — (session_token, account_id, family_id, expires_at)
 *   fh_entities  — (id, family_id, type, data JSON, created_at, updated_at, deleted)
 *   fh_edges     — (id, family_id, from_id, to_id, relation, data JSON, created_at)
 *
 * Auth: Every request must include a valid session token stored in fh_sessions.
 * Conflict resolution: last-write-wins by updated_at timestamp (server is authoritative).
 */

// ── Config ──────────────────────────────────────────────────────
// Edit these for your Hostinger MySQL credentials:
define('DB_HOST', 'localhost');
define('DB_NAME', 'your_db_name');       // replace with Hostinger DB name
define('DB_USER', 'your_db_user');       // replace with Hostinger DB user
define('DB_PASS', 'your_db_password');   // replace with Hostinger DB password
define('DB_CHARSET', 'utf8mb4');

// Max entities returned in a single pull (pagination safety)
define('PULL_LIMIT', 5000); // [N-10 fix] raised from 500 to prevent silent data loss on full sync

// ── CORS / Headers ──────────────────────────────────────────────
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

// Allow same-origin requests only in production.
// For development on localhost, set this to your local origin:
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$allowed_origins = [
    'https://yourdomain.hostinger.com',   // replace with your Hostinger URL
    'http://localhost',
    'http://127.0.0.1',
];
if (in_array($origin, $allowed_origins, true)) {
    header("Access-Control-Allow-Origin: $origin");
}
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'Method not allowed']);
    exit;
}

// ── Read + decode body ───────────────────────────────────────────
$raw  = file_get_contents('php://input');
$body = json_decode($raw, true);

if (!is_array($body)) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Invalid JSON body']);
    exit;
}

$action = $body['action'] ?? '';
$token  = $body['token']  ?? '';

if (empty($action) || empty($token)) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Missing action or token']);
    exit;
}

// ── DB Connection ────────────────────────────────────────────────
function fh_db(): PDO {
    static $pdo = null;
    if ($pdo !== null) return $pdo;

    $dsn = sprintf(
        'mysql:host=%s;dbname=%s;charset=%s',
        DB_HOST, DB_NAME, DB_CHARSET
    );
    $pdo = new PDO($dsn, DB_USER, DB_PASS, [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ]);
    return $pdo;
}

// ── Schema bootstrap ─────────────────────────────────────────────
// Call once on first deploy (or wrap in a migration flag check).
function fh_ensure_schema(): void {
    $pdo = fh_db();

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS fh_sessions (
            session_token   VARCHAR(128)  NOT NULL PRIMARY KEY,
            account_id      VARCHAR(36)   NOT NULL,
            family_id       VARCHAR(36)   NOT NULL,
            expires_at      BIGINT        NOT NULL,
            created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_family (family_id),
            INDEX idx_expires (expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS fh_entities (
            id              VARCHAR(36)   NOT NULL,
            family_id       VARCHAR(36)   NOT NULL,
            type            VARCHAR(50)   NOT NULL,
            data            JSON          NOT NULL,
            created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            deleted         TINYINT(1)    NOT NULL DEFAULT 0,
            PRIMARY KEY (id),
            INDEX idx_family_updated (family_id, updated_at),
            INDEX idx_family_type    (family_id, type)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS fh_edges (
            id              VARCHAR(36)   NOT NULL,
            family_id       VARCHAR(36)   NOT NULL,
            from_id         VARCHAR(36)   NOT NULL,
            to_id           VARCHAR(36)   NOT NULL,
            relation        VARCHAR(100)  NOT NULL,
            data            JSON,
            created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            INDEX idx_family      (family_id),
            INDEX idx_from_id     (from_id),
            INDEX idx_to_id       (to_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    ");
}

// ── Auth: validate session token ─────────────────────────────────
/**
 * Validates the session token against fh_sessions.
 * Returns ['account_id' => ..., 'family_id' => ...] on success, null on failure.
 */
function fh_validate_token(string $token): ?array {
    if (strlen($token) < 16 || strlen($token) > 128) return null;

    $pdo  = fh_db();
    $stmt = $pdo->prepare(
        'SELECT account_id, family_id, expires_at FROM fh_sessions WHERE session_token = ? LIMIT 1'
    );
    $stmt->execute([$token]);
    $row = $stmt->fetch();

    if (!$row) return null;
    if ((int)$row['expires_at'] < time() * 1000) {
        // Expired — clean up lazily
        $pdo->prepare('DELETE FROM fh_sessions WHERE session_token = ?')->execute([$token]);
        return null;
    }

    return ['account_id' => $row['account_id'], 'family_id' => $row['family_id']];
}

// ── Action: handshake ─────────────────────────────────────────────
/**
 * Validate token + upsert session into fh_sessions.
 * Client sends: { action:'handshake', token, accountId, familyId, expiresAt }
 * Server returns: { ok:true, family_id, server_time_ms }
 */
function fh_action_handshake(string $token, array $body): void {
    $account_id = $body['accountId'] ?? '';
    $family_id  = $body['familyId']  ?? '';
    $expires_at = (int)($body['expiresAt'] ?? 0);

    if (empty($account_id) || empty($family_id) || $expires_at < 1) {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'Missing accountId, familyId, or expiresAt']);
        return;
    }

    // Sanitise lengths
    $token      = substr($token,      0, 128);
    $account_id = substr($account_id, 0, 36);
    $family_id  = substr($family_id,  0, 36);

    $pdo = fh_db();
    $pdo->prepare("
        INSERT INTO fh_sessions (session_token, account_id, family_id, expires_at)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE account_id = VALUES(account_id),
                                family_id  = VALUES(family_id),
                                expires_at = VALUES(expires_at)
    ")->execute([$token, $account_id, $family_id, $expires_at]);

    echo json_encode([
        'ok'            => true,
        'family_id'     => $family_id,
        'server_time_ms'=> (int)(microtime(true) * 1000),
    ]);
}

// ── Action: push ──────────────────────────────────────────────────
/**
 * Save a batch of entities and edges from the client.
 * Body: { action:'push', token, entities:[...], edges:[...] }
 * Last-write-wins: only update server row if client updated_at >= server updated_at.
 */
function fh_action_push(array $session, array $body): void {
    $family_id = $session['family_id'];
    $entities  = $body['entities'] ?? [];
    $edges     = $body['edges']    ?? [];

    if (!is_array($entities) || !is_array($edges)) {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'entities and edges must be arrays']);
        return;
    }

    if (count($entities) > PULL_LIMIT || count($edges) > PULL_LIMIT) {
        http_response_code(413);
        echo json_encode(['ok' => false, 'error' => 'Batch too large — max ' . PULL_LIMIT . ' per push']);
        return;
    }

    $pdo = fh_db();
    $conflicts = [];
    $saved     = 0;

    // ── Entities ───────────────────────────────────────────────
    $upsert_entity = $pdo->prepare("
        INSERT INTO fh_entities (id, family_id, type, data, created_at, updated_at, deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            data       = IF(VALUES(updated_at) >= updated_at, VALUES(data),       data),
            deleted    = IF(VALUES(updated_at) >= updated_at, VALUES(deleted),     deleted),
            updated_at = IF(VALUES(updated_at) >= updated_at, VALUES(updated_at), updated_at)
    ");

    foreach ($entities as $e) {
        if (empty($e['id']) || empty($e['type'])) continue;
        $id         = substr((string)$e['id'],   0, 36);
        $type       = substr((string)$e['type'], 0, 50);
        $deleted    = empty($e['deleted']) ? 0 : 1;
        $created_at = fh_ts_to_datetime($e['createdAt']  ?? null);
        $updated_at = fh_ts_to_datetime($e['updatedAt']  ?? null);
        $data_json  = json_encode($e);

        $upsert_entity->execute([
            $id, $family_id, $type, $data_json,
            $created_at, $updated_at, $deleted
        ]);
        $saved++;
    }

    // ── Edges ──────────────────────────────────────────────────
    $upsert_edge = $pdo->prepare("
        INSERT IGNORE INTO fh_edges (id, family_id, from_id, to_id, relation, data, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ");

    foreach ($edges as $edge) {
        if (empty($edge['id']) || empty($edge['fromId']) || empty($edge['toId'])) continue;
        $id         = substr((string)$edge['id'],       0, 36);
        $from_id    = substr((string)$edge['fromId'],   0, 36);
        $to_id      = substr((string)$edge['toId'],     0, 36);
        $relation   = substr((string)($edge['relation'] ?? ''), 0, 100);
        $created_at = fh_ts_to_datetime($edge['createdAt'] ?? null);
        $data_json  = json_encode($edge['metadata'] ?? null);

        $upsert_edge->execute([
            $id, $family_id, $from_id, $to_id, $relation, $data_json, $created_at
        ]);
        $saved++;
    }

    echo json_encode([
        'ok'        => true,
        'saved'     => $saved,
        'conflicts' => $conflicts,
        'server_time_ms' => (int)(microtime(true) * 1000),
    ]);
}

// ── Action: pull ──────────────────────────────────────────────────
/**
 * Fetch all entities/edges updated since a given timestamp.
 * Body: { action:'pull', token, since_ms }
 * Returns: { ok:true, entities:[...], edges:[...], server_time_ms }
 */
function fh_action_pull(array $session, array $body): void {
    $family_id = $session['family_id'];
    $since_ms  = (int)($body['since_ms'] ?? 0);
    $since_dt  = fh_ts_to_datetime($since_ms > 0 ? $since_ms : null);

    $pdo = fh_db();

    // Pull entities
    if ($since_ms > 0) {
        $stmt = $pdo->prepare(
            'SELECT data FROM fh_entities WHERE family_id = ? AND updated_at > ? LIMIT ' . PULL_LIMIT
        );
        $stmt->execute([$family_id, $since_dt]);
    } else {
        $stmt = $pdo->prepare(
            'SELECT data FROM fh_entities WHERE family_id = ? AND deleted = 0 ORDER BY updated_at DESC LIMIT ' . PULL_LIMIT
        );
        $stmt->execute([$family_id]);
    }

    $entities = [];
    while ($row = $stmt->fetch()) {
        $entity = json_decode($row['data'], true);
        if (is_array($entity)) $entities[] = $entity;
    }

    // Pull edges
    if ($since_ms > 0) {
        $estmt = $pdo->prepare(
            'SELECT id, from_id, to_id, relation, data FROM fh_edges WHERE family_id = ? AND created_at > ? LIMIT ' . PULL_LIMIT
        );
        $estmt->execute([$family_id, $since_dt]);
    } else {
        $estmt = $pdo->prepare(
            'SELECT id, from_id, to_id, relation, data FROM fh_edges WHERE family_id = ? LIMIT ' . PULL_LIMIT
        );
        $estmt->execute([$family_id]);
    }

    $edges = [];
    while ($erow = $estmt->fetch()) {
        $edges[] = [
            'id'       => $erow['id'],
            'fromId'   => $erow['from_id'],
            'toId'     => $erow['to_id'],
            'relation' => $erow['relation'],
            'metadata' => $erow['data'] ? json_decode($erow['data'], true) : null,
        ];
    }

    // [N-10 fix] Warn if result hit PULL_LIMIT — may be truncated
    $truncated = count($entities) >= PULL_LIMIT || count($edges) >= PULL_LIMIT;
    if ($truncated) {
        error_log('[fh-sync] WARNING: pull hit PULL_LIMIT (' . PULL_LIMIT . '). Increase limit or add cursor pagination.');
    }
    echo json_encode([
        'ok'            => true,
        'entities'      => $entities,
        'edges'         => $edges,
        'server_time_ms'=> (int)(microtime(true) * 1000),
        '_truncated'    => $truncated,
    ]);
}

// ── Utility: timestamp → MySQL datetime ──────────────────────────
function fh_ts_to_datetime(?int $ts_ms): string {
    if (!$ts_ms || $ts_ms <= 0) return date('Y-m-d H:i:s');
    $ts = (int)($ts_ms / 1000);
    return date('Y-m-d H:i:s', $ts);
}

// ── Router ───────────────────────────────────────────────────────
try {
    fh_ensure_schema();

    if ($action === 'handshake') {
        fh_action_handshake($token, $body);
        exit;
    }

    // All other actions require valid auth
    $session = fh_validate_token($token);
    if (!$session) {
        http_response_code(401);
        echo json_encode(['ok' => false, 'error' => 'Invalid or expired session token']);
        exit;
    }

    match ($action) {
        'push' => fh_action_push($session, $body),
        'pull' => fh_action_pull($session, $body),
        default => (function () {
            http_response_code(400);
            echo json_encode(['ok' => false, 'error' => 'Unknown action']);
        })(),
    };

} catch (PDOException $e) {
    http_response_code(500);
    // Don't expose PDO details to client
    error_log('[FamilyHub sync.php] DB error: ' . $e->getMessage());
    echo json_encode(['ok' => false, 'error' => 'Database error']);
} catch (Throwable $e) {
    http_response_code(500);
    error_log('[FamilyHub sync.php] Error: ' . $e->getMessage());
    echo json_encode(['ok' => false, 'error' => 'Server error']);
}
