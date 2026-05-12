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
let _isSaving = false;  // prevent blur-save → ENTITY_SAVED → re-render loop

// ── Inject view CSS once (reset .view padding, define two-panel layout) ───────
(function _injectStyles() {
  if (document.getElementById('notes-view-styles')) return;
  const style = document.createElement('style');
  style.id = 'notes-view-styles';
  style.textContent = `
    /* Override .view padding so notes controls its own layout */
    #view-notes.active {
      padding: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    .notes-layout {
      display: flex;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    @media (max-width: 639px) {
      .notes-layout { flex-direction: column; }
      .notes-list-panel { width: 100% !important; height: 220px; flex-shrink: 0; border-right: none !important; border-bottom: 1px solid var(--color-border); }
      .notes-detail-panel { flex: 1; min-height: 0; }
    }
  `;
  document.head.appendChild(style);
})();

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
      padding:var(--space-3) var(--space-4);
      cursor:pointer;
      border-bottom:1px solid var(--color-border);
      background:${isActive ? 'var(--color-accent-light, rgba(10,123,108,0.08))' : 'transparent'};
      transition:background 0.1s;
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
      _renderList();
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

  // Build detail with flex column so body editor fills remaining space
  detailPanel.innerHTML = '';
  detailPanel.style.cssText = 'flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--color-bg);overflow:hidden;';

  // Title row
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'note-title-input';
  titleInput.value = note.title || '';
  titleInput.placeholder = 'Note title…';
  titleInput.style.cssText = `
    flex-shrink:0;
    font-size:var(--text-xl);font-weight:var(--weight-bold);border:none;outline:none;
    background:transparent;color:var(--color-text);width:100%;font-family:var(--font-heading);
    padding:var(--space-4) var(--space-6) var(--space-2);
    border-bottom:2px solid transparent;box-sizing:border-box;
  `;

  // Body editor — flex:1 so it fills all remaining space
  const bodyEditor = document.createElement('div');
  bodyEditor.className = 'note-body-editor';
  bodyEditor.contentEditable = 'true';
  bodyEditor.style.cssText = `
    flex:1;min-height:0;overflow-y:auto;
    font-size:var(--text-sm);color:var(--color-text);line-height:1.7;
    outline:none;padding:var(--space-2) var(--space-6);
    white-space:pre-wrap;word-break:break-word;box-sizing:border-box;
  `;
  // Set body content — sanitize to prevent <script> execution from sync'd content
  const _rawBody = note.body || note.description || '';
  if (_rawBody) {
    const _dp = new DOMParser();
    const _doc = _dp.parseFromString(_rawBody, 'text/html');
    _doc.querySelectorAll('script,iframe,object,embed,link[rel="import"]').forEach(el => el.remove());
    // Strip inline event handlers from all elements to prevent XSS
    _doc.querySelectorAll('*').forEach(el => {
      for (const attr of [...el.attributes]) {
        if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
      }
    });
    // bodyEditor renders stored HTML — users own their content
    bodyEditor.innerHTML = _doc.body ? _doc.body.innerHTML : '';
  } else {
    bodyEditor.innerHTML = '';
  }

  // Footer
  const footer = document.createElement('div');
  footer.style.cssText = `
    flex-shrink:0;font-size:10px;color:var(--color-text-muted);
    padding:var(--space-2) var(--space-6);border-top:1px solid var(--color-border);
  `;
  footer.textContent = `Last edited ${_relativeTime(note.updatedAt || note.createdAt)}${note.category ? ' · ' + note.category : ''}`;

  detailPanel.appendChild(titleInput);
  detailPanel.appendChild(bodyEditor);
  detailPanel.appendChild(footer);

  // ── Wire blur-saves ──────────────────────────────────────
  titleInput.addEventListener('focus', () => { titleInput.style.borderBottomColor = 'var(--color-accent)'; });
  titleInput.addEventListener('blur', async () => {
    titleInput.style.borderBottomColor = 'transparent';
    const newTitle = titleInput.value.trim();
    // Guard: validate this note is still selected before saving (rapid switch protection)
    if (note.id !== _selectedId) return;
    if (newTitle !== (note.title || '')) {
      const account = getAccount();
      _isSaving = true;
      try {
        note.title = newTitle;
        _renderList();  // update list card immediately
        await saveEntity({ ...note, title: newTitle }, account?.id);
      } finally {
        _isSaving = false;
      }
    }
  });

  bodyEditor.addEventListener('blur', async () => {
    // Guard: validate this note is still selected before saving (rapid switch protection)
    if (note.id !== _selectedId) return;
    // Normalize empty editor states (<br>, empty div) to null
    const rawBody = bodyEditor.innerHTML;
    const newBody = (rawBody === '' || rawBody === '<br>' || rawBody === '<div><br></div>') ? null : rawBody;
    const oldBody = note.body || null;
    if (newBody !== oldBody) {
      const account = getAccount();
      _isSaving = true;
      try {
        // 3P-H-04 fix: re-sanitize before save to strip event handlers pasted after load
        let safeBody = newBody;
        if (newBody) {
          const _dp2 = new DOMParser();
          const _sanitized = _dp2.parseFromString(newBody, 'text/html');
          _sanitized.querySelectorAll('script,iframe,object,embed').forEach(el => el.remove());
          _sanitized.querySelectorAll('*').forEach(el => {
            for (const attr of [...el.attributes]) {
              if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
            }
          });
          safeBody = _sanitized.body?.innerHTML || newBody;
        }
        note.body = safeBody;
        await saveEntity({ ...note, body: safeBody }, account?.id);
      } finally {
        _isSaving = false;
      }
    }
  });
}

// ── Main Render ────────────────────────────────────────────────
async function renderNotes(params = {}) {
  const el = document.getElementById('view-notes');
  if (!el) return;
  _containerEl = el;

  if (!params._internal) {
    await _loadNotes();
  }

  el.innerHTML = '';

  // ── Left Panel: List ──────────────────────────────────────
  const listPanel = document.createElement('div');
  listPanel.className = 'notes-list-panel';
  listPanel.style.cssText = `
    width:280px;flex-shrink:0;
    border-right:1px solid var(--color-border);
    display:flex;flex-direction:column;
    background:var(--color-surface);overflow:hidden;
  `;

  // Header
  const header = document.createElement('div');
  header.style.cssText = `
    padding:var(--space-3) var(--space-4);border-bottom:1px solid var(--color-border);
    display:flex;flex-direction:column;gap:var(--space-2);flex-shrink:0;
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
    background:var(--color-accent);color:#fff;border:none;border-radius:var(--radius-md);cursor:pointer;
  `;
  newBtn.addEventListener('click', () => {
    const ctx = getActiveContext();
    openForm('note', { context: ctx === 'all' ? 'family' : ctx });
  });
  headerTop.appendChild(newBtn);
  header.appendChild(headerTop);

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Search notes…';
  searchInput.value = _searchQ;
  searchInput.style.cssText = `
    width:100%;padding:6px 10px;font-size:var(--text-xs);border:1px solid var(--color-border);
    border-radius:var(--radius-md);outline:none;background:var(--color-bg);color:var(--color-text);
    box-sizing:border-box;
  `;
  searchInput.addEventListener('input', () => {
    _searchQ = searchInput.value;
    _renderList();
  });
  header.appendChild(searchInput);
  listPanel.appendChild(header);

  const listBody = document.createElement('div');
  listBody.className = 'notes-list-body';
  listBody.style.cssText = 'flex:1;min-height:0;overflow-y:auto;';
  listPanel.appendChild(listBody);

  // ── Right Panel: Detail ───────────────────────────────────
  const detailPanel = document.createElement('div');
  detailPanel.className = 'notes-detail-panel';
  detailPanel.style.cssText = 'flex:1;min-width:0;min-height:0;overflow:hidden;display:flex;flex-direction:column;background:var(--color-bg);';

  // ── Layout wrapper ────────────────────────────────────────
  const layout = document.createElement('div');
  layout.className = 'notes-layout';
  layout.appendChild(listPanel);
  layout.appendChild(detailPanel);
  el.appendChild(layout);

  _renderList();
  _renderDetail();
}

// ── Module-level event listeners ───────────────────────────────
on(EVENTS.ENTITY_SAVED, ({ entity } = {}) => {
  if (_isSaving) return;
  if (entity?.type === 'note' && document.getElementById('view-notes')?.classList.contains('active')) {
    const prevSelected = _selectedId;  // preserve selection across reload
    _loadNotes().then(() => {
      // Restore selection if the note still exists
      if (prevSelected && _notes.find(n => n.id === prevSelected)) {
        _selectedId = prevSelected;
      }
      _renderList();
      _renderDetail();
    });
  }
});

on(EVENTS.ENTITY_DELETED, ({ entity } = {}) => {
  if (entity?.type === 'note' && document.getElementById('view-notes')?.classList.contains('active')) {
    _selectedId = null;
    _loadNotes().then(() => { _renderList(); _renderDetail(); });
  }
});

on('context:changed', () => {
  if (document.getElementById('view-notes')?.classList.contains('active')) {
    _selectedId = null;
    _loadNotes().then(() => { _renderList(); _renderDetail(); });
  }
});

// ── Registration ───────────────────────────────────────────────
registerView('notes', renderNotes);

export { renderNotes };
