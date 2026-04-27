/**
 * FamilyHub v3 — views/notes.js
 * [MAJOR] V-01 — Notes View — Two-Panel List + Editable Detail
 *
 * Two-panel layout:
 *   Left (280px): searchable, filterable note list sorted by updatedAt desc
 *   Right: editable title + contenteditable body (blur saves)
 *
 * Registration: registerView('notes', renderNotes)
 */

import { registerView } from '../core/router.js';
import { getEntitiesByType, saveEntity } from '../core/db.js';
import { emit, on, EVENTS } from '../core/events.js';
import { getAccount } from '../core/auth.js';
import { filterByContext, getActiveContext } from '../core/context.js';
import { openForm } from '../components/entity-form.js';

// ── Module state ───────────────────────────────────────────────
let _notes = [];
let _selectedId = null;
let _searchQ = '';
let _containerEl = null;

// ── Data Loading ───────────────────────────────────────────────
async function _loadNotes() {
  const all = await getEntitiesByType('note');
  _notes = filterByContext(all.filter(n => !n.deleted));
  _notes.sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
}

// ── Helpers ────────────────────────────────────────────────────
function _esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function _stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function _relativeTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

function _filteredNotes() {
  if (!_searchQ) return _notes;
  const q = _searchQ.toLowerCase();
  return _notes.filter(n => {
    const title = (n.title || '').toLowerCase();
    const body = _stripHtml(n.body || n.description || '').toLowerCase();
    const cat = (n.category || '').toLowerCase();
    return title.includes(q) || body.includes(q) || cat.includes(q);
  });
}

// ── Render: List Panel (Left) ──────────────────────────────────
function _renderList() {
  const listPanel = _containerEl?.querySelector('.notes-list-panel');
  if (!listPanel) return;

  const filtered = _filteredNotes();

  const listBody = listPanel.querySelector('.notes-list-body');
  if (!listBody) return;
  listBody.innerHTML = '';

  if (filtered.length === 0) {
    listBody.innerHTML = `
      <div style="padding:var(--space-6);text-align:center;color:var(--color-text-muted);font-size:var(--text-sm);">
        ${_searchQ ? 'No notes match your search.' : 'No notes yet. Click "+ New" to create one.'}
      </div>
    `;
    return;
  }

  for (const note of filtered) {
    const card = document.createElement('div');
    card.className = 'note-card';
    card.dataset.id = note.id;
    const isActive = note.id === _selectedId;
    card.style.cssText = `
      padding: var(--space-3) var(--space-4);
      cursor: pointer;
      border-bottom: 1px solid var(--color-border);
      background: ${isActive ? 'var(--color-accent-light, rgba(10,123,108,0.08))' : 'transparent'};
      transition: background 0.1s;
    `;

    const preview = _stripHtml(note.body || note.description || '').slice(0, 80);
    const catBadge = note.category
      ? `<span style="font-size:var(--text-xs);color:var(--color-text-muted);background:var(--color-surface);padding:1px 6px;border-radius:var(--radius-full);border:1px solid var(--color-border);">${_esc(note.category)}</span>`
      : '';

    card.innerHTML = `
      <div style="font-weight:var(--weight-semibold);font-size:var(--text-sm);color:var(--color-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
        ${_esc(note.title || 'Untitled')}
      </div>
      <div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
        ${_esc(preview)}
      </div>
      <div style="display:flex;align-items:center;gap:var(--space-2);margin-top:4px;">
        ${catBadge}
        <span style="font-size:10px;color:var(--color-text-muted);margin-left:auto;">${_relativeTime(note.updatedAt || note.createdAt)}</span>
      </div>
    `;

    card.addEventListener('click', () => {
      _selectedId = note.id;
      _renderList();    // update active highlight
      _renderDetail();
    });

    listBody.appendChild(card);
  }
}

// ── Render: Detail Panel (Right) ──────────────────────────────
function _renderDetail() {
  const detailPanel = _containerEl?.querySelector('.notes-detail-panel');
  if (!detailPanel) return;

  const note = _notes.find(n => n.id === _selectedId);
  if (!note) {
    detailPanel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--color-text-muted);font-size:var(--text-sm);">
        Select a note to read it
      </div>
    `;
    return;
  }

  detailPanel.innerHTML = `
    <div style="padding:var(--space-4) var(--space-6);display:flex;flex-direction:column;height:100%;gap:var(--space-3);">
      <input type="text" class="note-title-input" value="${_esc(note.title || '')}"
        style="
          font-size:var(--text-xl);font-weight:var(--weight-bold);border:none;outline:none;
          background:transparent;color:var(--color-text);width:100%;font-family:var(--font-heading);
          padding:var(--space-1) 0;border-bottom:2px solid transparent;
        "
        placeholder="Note title…"
      />
      <div class="note-body-editor" contenteditable="true"
        style="
          flex:1;overflow-y:auto;font-size:var(--text-sm);color:var(--color-text);
          line-height:1.7;outline:none;min-height:200px;padding:var(--space-2) 0;
          white-space:pre-wrap;word-break:break-word;
        "
      >${note.body || note.description || ''}</div>
      <div style="font-size:10px;color:var(--color-text-muted);padding-top:var(--space-2);border-top:1px solid var(--color-border);">
        Last edited ${_relativeTime(note.updatedAt || note.createdAt)}
        ${note.category ? ' · ' + _esc(note.category) : ''}
      </div>
    </div>
  `;

  // Wire blur-saves
  const titleInput = detailPanel.querySelector('.note-title-input');
  const bodyEditor = detailPanel.querySelector('.note-body-editor');

  titleInput?.addEventListener('blur', async () => {
    const newTitle = titleInput.value.trim();
    if (newTitle !== (note.title || '')) {
      const account = getAccount();
      await saveEntity({ ...note, title: newTitle }, account?.id);
    }
  });

  bodyEditor?.addEventListener('blur', async () => {
    const newBody = bodyEditor.innerHTML;
    if (newBody !== (note.body || note.description || '')) {
      const account = getAccount();
      await saveEntity({ ...note, body: newBody }, account?.id);
    }
  });

  // Focus title styling
  titleInput?.addEventListener('focus', () => { titleInput.style.borderBottomColor = 'var(--color-accent)'; });
  titleInput?.addEventListener('blur', () => { titleInput.style.borderBottomColor = 'transparent'; });
}

// ── Main Render ────────────────────────────────────────────────
async function renderNotes(params = {}) {
  const el = document.getElementById('view-notes');
  if (!el) return;
  _containerEl = el;

  // Only reload data if not an internal re-render
  if (!params._listOnly) {
    await _loadNotes();
  }

  el.innerHTML = '';

  // Build two-panel layout
  el.style.cssText = 'display:flex;height:100%;overflow:hidden;';

  // ── Left Panel: List ──────────────────────────────────────
  const listPanel = document.createElement('div');
  listPanel.className = 'notes-list-panel';
  listPanel.style.cssText = `
    width:280px;min-width:240px;max-width:320px;border-right:1px solid var(--color-border);
    display:flex;flex-direction:column;background:var(--color-surface);overflow:hidden;
  `;

  // Header
  const header = document.createElement('div');
  header.style.cssText = `
    padding:var(--space-3) var(--space-4);border-bottom:1px solid var(--color-border);
    display:flex;flex-direction:column;gap:var(--space-2);
  `;

  const headerTop = document.createElement('div');
  headerTop.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
  headerTop.innerHTML = `
    <span style="font-weight:var(--weight-bold);font-size:var(--text-base);color:var(--color-text);">
      📝 Notes <span style="font-weight:normal;font-size:var(--text-xs);color:var(--color-text-muted);">(${_notes.length})</span>
    </span>
  `;

  const newBtn = document.createElement('button');
  newBtn.textContent = '+ New';
  newBtn.style.cssText = `
    padding:4px 10px;font-size:var(--text-xs);font-weight:var(--weight-semibold);
    background:var(--color-accent);color:#fff;border:none;border-radius:var(--radius-md);
    cursor:pointer;
  `;
  newBtn.addEventListener('click', () => {
    const ctx = getActiveContext();
    openForm('note', { context: ctx === 'all' ? 'family' : ctx });
  });
  headerTop.appendChild(newBtn);
  header.appendChild(headerTop);

  // Search input
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Search notes…';
  searchInput.value = _searchQ;
  searchInput.style.cssText = `
    width:100%;padding:6px 10px;font-size:var(--text-xs);border:1px solid var(--color-border);
    border-radius:var(--radius-md);outline:none;background:var(--color-bg);color:var(--color-text);
  `;
  searchInput.addEventListener('input', () => {
    _searchQ = searchInput.value;
    _renderList();
  });
  header.appendChild(searchInput);
  listPanel.appendChild(header);

  // List body (scrollable)
  const listBody = document.createElement('div');
  listBody.className = 'notes-list-body';
  listBody.style.cssText = 'flex:1;overflow-y:auto;';
  listPanel.appendChild(listBody);

  // ── Right Panel: Detail ───────────────────────────────────
  const detailPanel = document.createElement('div');
  detailPanel.className = 'notes-detail-panel';
  detailPanel.style.cssText = 'flex:1;overflow-y:auto;background:var(--color-bg);';

  el.appendChild(listPanel);
  el.appendChild(detailPanel);

  _renderList();
  _renderDetail();
}

// ── Module-level event listeners ───────────────────────────────
// (outside renderNotes — runs once at import, matching kanban/calendar/wall pattern)

on(EVENTS.ENTITY_SAVED, ({ entity } = {}) => {
  if (entity?.type === 'note' && document.getElementById('view-notes')?.classList.contains('active')) {
    _loadNotes().then(() => { _renderList(); _renderDetail(); });
  }
});

on(EVENTS.ENTITY_DELETED, ({ entityType } = {}) => {
  if (entityType === 'note' && document.getElementById('view-notes')?.classList.contains('active')) {
    _selectedId = null;
    _loadNotes().then(() => { _renderList(); _renderDetail(); });
  }
});

on('context:changed', () => {
  if (document.getElementById('view-notes')?.classList.contains('active')) {
    _loadNotes().then(() => { _renderList(); _renderDetail(); });
  }
});

// ── Registration ───────────────────────────────────────────────
registerView('notes', renderNotes);

export { renderNotes };
