/**
 * FamilyHub v3 — components/type-editor-modal.js
 * [MAJOR] Capacities-Inspired Type Editor Drawer
 *
 * Slide-in drawer (right side) for creating and editing custom object types.
 *
 * Tabs:
 *   1. General    — name, plural, icon (emoji picker), color swatches, description, key
 *   2. Properties — add / expand / edit / delete property fields
 *   3. Views      — default view, dashboard sections, graph visibility
 *
 * Built-in types: read-only info view, no edit/delete.
 * Custom types:   full edit with Save and Delete actions.
 *
 * State pattern: _editingType is a deep-clone of the type config.
 * All in-memory mutations apply to the clone; Save persists it.
 * _renderDrawer() replaces _drawerEl.innerHTML entirely on each
 * tab-switch or property expand — fresh elements, no accumulation.
 *
 * Exports:
 *   openTypeEditor(typeKey, onSaved?)  — open the drawer
 *   closeTypeEditor()                  — programmatic close
 */

import { saveEntityType }     from '../core/graph-engine.js';
import { emit, EVENTS }       from '../core/events.js';
import { toast }              from '../core/toast.js';
import {
  getObjectTypeConfig,
  saveCustomObjectType,
  deleteCustomObjectType,
  isBuiltInType,
  PROPERTY_FIELD_TYPES,
  PROPERTY_CATEGORIES,
  VIEW_MODES,
  DASHBOARD_SECTION_DEFS,
  makeDefaultField,
}                              from '../core/object-type-registry.js';

// ── Module state ──────────────────────────────────────────────────
let _drawerEl    = null;
let _onSavedCb   = null;
let _activeTab   = 'general';
let _editingType = null;
let _propEditing = null; // key of currently expanded property row

// ── Constants ─────────────────────────────────────────────────────
const EMOJI_CATALOG = [
  '📝','📄','📋','📌','📎','🔖','📚','📖','📗','📘','📙','📓','📔','📒','📕',
  '💡','🎯','🎨','🎭','🎬','🎤','🎵','🎸','🎓','🏆','🥇','🏅','🎖',
  '🏠','🏢','🏥','🏫','🏗','🌍','🌱','🌿','🍀','🌸','🌺','🌙','☀️','⭐','🌟',
  '👤','👥','👨‍💼','👩‍💼','🧑‍🍳','🧑‍🏫','🧑‍⚕️','🧑‍💻','🧑‍🔬','🧑‍🎨',
  '🚀','✈️','🚗','🚲','⚽','🏀','🎾','💰','💳','📈','📉','📊','🗂','📅','⏰',
  '🍎','🍽','🍕','☕','🍵','💻','📱','⌨️','🔬','🧪','⚙️','🔧','🔨','📡','🧲',
  '❤️','💙','💚','💛','💜','🤍','🔥','⚡','💎','🔑','🗝','🔒','🎁','🎉','✦',
];

const COLORS = [
  '#6366f1','#8b5cf6','#ec4899','#ef4444','#f59e0b',
  '#10b981','#06b6d4','#3b82f6','#64748b','#0ea5e9',
];

// ── Styles ────────────────────────────────────────────────────────
(function _injectStyles() {
  if (document.getElementById('type-editor-styles')) return;
  const s = document.createElement('style');
  s.id = 'type-editor-styles';
  s.textContent = `
    .te-overlay {
      position:fixed;inset:0;z-index:300;background:rgba(0,0,0,0.4);
      display:flex;justify-content:flex-end;animation:te-fade 0.15s ease;
    }
    @keyframes te-fade{from{opacity:0}to{opacity:1}}
    .te-drawer {
      width:min(500px,100vw);height:100%;background:var(--color-bg);
      border-left:1px solid var(--color-border);
      display:flex;flex-direction:column;overflow:hidden;
      animation:te-slide 0.18s ease;
    }
    @keyframes te-slide{from{transform:translateX(40px);opacity:0}to{transform:none;opacity:1}}
    /* Header */
    .te-hdr {
      display:flex;align-items:center;justify-content:space-between;
      padding:var(--space-4) var(--space-5);border-bottom:1px solid var(--color-border);flex-shrink:0;
    }
    .te-hdr-l{display:flex;align-items:center;gap:var(--space-2);}
    .te-hdr-icon{font-size:1.5rem;}
    .te-hdr-name{font-size:var(--text-lg);font-weight:var(--weight-bold);color:var(--color-text);}
    .te-hdr-sub{font-size:var(--text-xs);color:var(--color-text-muted);margin-top:1px;}
    .te-badge {
      display:inline-flex;align-items:center;gap:4px;font-size:var(--text-xs);padding:2px 8px;
      background:var(--color-surface-2);border:1px solid var(--color-border);
      border-radius:var(--radius-full);color:var(--color-text-muted);
    }
    .te-badge.custom{border-color:var(--color-accent);color:var(--color-accent);background:var(--color-accent-muted);}
    .te-close {
      width:32px;height:32px;border:1px solid var(--color-border);border-radius:var(--radius-md);
      background:none;color:var(--color-text-muted);font-size:18px;cursor:pointer;
      display:flex;align-items:center;justify-content:center;
    }
    .te-close:hover{background:var(--color-surface);color:var(--color-text);}
    /* Tabs */
    .te-tabs{display:flex;border-bottom:1px solid var(--color-border);flex-shrink:0;padding:0 var(--space-5);}
    .te-tab{
      padding:var(--space-2) var(--space-3);border:none;background:none;
      font-size:var(--text-sm);font-weight:var(--weight-medium);color:var(--color-text-muted);
      cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;
      transition:color 0.12s,border-color 0.12s;
    }
    .te-tab:hover{color:var(--color-text);}
    .te-tab.active{color:var(--color-accent);border-bottom-color:var(--color-accent);}
    /* Content */
    .te-content{flex:1;overflow-y:auto;padding:var(--space-5);display:flex;flex-direction:column;gap:var(--space-4);}
    /* Form elements */
    .te-field{display:flex;flex-direction:column;gap:var(--space-1);}
    .te-lbl{font-size:var(--text-sm);font-weight:var(--weight-semibold);color:var(--color-text);}
    .te-req{color:var(--color-danger);margin-left:2px;}
    .te-hint{font-size:var(--text-xs);color:var(--color-text-muted);margin-top:2px;}
    .te-input{
      padding:8px 12px;border:1.5px solid var(--color-border);border-radius:var(--radius-md);
      background:var(--color-surface);color:var(--color-text);font-size:var(--text-sm);font-family:inherit;
    }
    .te-input:focus{outline:none;border-color:var(--color-accent);}
    .te-input:disabled{opacity:0.6;cursor:not-allowed;}
    .te-row{display:grid;grid-template-columns:1fr 1fr;gap:var(--space-3);}
    .te-textarea{
      padding:8px 12px;border:1.5px solid var(--color-border);border-radius:var(--radius-md);
      background:var(--color-surface);color:var(--color-text);font-size:var(--text-sm);font-family:inherit;
      min-height:72px;resize:vertical;
    }
    .te-textarea:focus{outline:none;border-color:var(--color-accent);}
    .te-select{
      padding:7px 10px;border:1.5px solid var(--color-border);border-radius:var(--radius-md);
      background:var(--color-surface);color:var(--color-text);font-size:var(--text-sm);cursor:pointer;
      font-family:inherit;
    }
    .te-select:focus{outline:none;border-color:var(--color-accent);}
    .te-sec-title{
      font-size:var(--text-xs);font-weight:var(--weight-bold);text-transform:uppercase;
      letter-spacing:0.08em;color:var(--color-text-muted);
      padding-bottom:var(--space-1);border-bottom:1px solid var(--color-border);
    }
    /* Emoji / icon picker */
    .te-icon-row{display:flex;align-items:center;gap:var(--space-3);}
    .te-icon-preview{
      width:52px;height:52px;font-size:2rem;background:var(--color-surface);
      border:1.5px solid var(--color-border);border-radius:var(--radius-lg);
      display:flex;align-items:center;justify-content:center;flex-shrink:0;
    }
    .te-emoji-toggle{
      padding:6px 12px;border:1px solid var(--color-border);border-radius:var(--radius-md);
      background:var(--color-surface);color:var(--color-text-muted);font-size:var(--text-sm);cursor:pointer;
    }
    .te-emoji-toggle:hover{border-color:var(--color-accent);color:var(--color-text);}
    .te-emoji-grid{
      display:grid;grid-template-columns:repeat(10,1fr);gap:3px;
      max-height:140px;overflow-y:auto;margin-top:var(--space-1);
    }
    .te-emoji-btn{
      aspect-ratio:1;font-size:18px;border:1.5px solid transparent;border-radius:var(--radius-sm);
      background:none;cursor:pointer;display:flex;align-items:center;justify-content:center;
      transition:all 0.1s;
    }
    .te-emoji-btn:hover{background:var(--color-surface-2);}
    .te-emoji-btn.selected{border-color:var(--color-accent);background:var(--color-accent-muted);}
    /* Color swatches */
    .te-color-row{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;}
    .te-swatch{
      width:28px;height:28px;border-radius:var(--radius-md);border:2px solid transparent;
      cursor:pointer;transition:transform 0.1s;flex-shrink:0;
    }
    .te-swatch:hover{transform:scale(1.15);}
    .te-swatch.selected{border-color:var(--color-text);transform:scale(1.1);}
    .te-color-custom{
      width:28px;height:28px;border-radius:var(--radius-md);
      border:1.5px dashed var(--color-border);cursor:pointer;padding:0;
      background:transparent;overflow:hidden;flex-shrink:0;
    }
    /* Properties list */
    .te-props-list{display:flex;flex-direction:column;gap:var(--space-2);}
    .te-prop-row{
      background:var(--color-surface);border:1px solid var(--color-border);
      border-radius:var(--radius-md);overflow:hidden;transition:border-color 0.12s;
    }
    .te-prop-row.expanded{border-color:var(--color-accent);}
    .te-prop-hdr{
      display:flex;align-items:center;gap:var(--space-2);
      padding:var(--space-2) var(--space-3);cursor:pointer;
    }
    .te-prop-ico{font-size:14px;flex-shrink:0;}
    .te-prop-lbl{flex:1;font-size:var(--text-sm);font-weight:var(--weight-medium);color:var(--color-text);}
    .te-prop-badge{
      font-size:var(--text-xs);padding:1px 6px;background:var(--color-surface-2);
      border:1px solid var(--color-border);border-radius:var(--radius-full);color:var(--color-text-muted);
    }
    .te-prop-exp{
      width:22px;height:22px;border:none;background:none;color:var(--color-text-muted);
      cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;
      border-radius:3px;flex-shrink:0;
    }
    .te-prop-exp:hover{background:var(--color-surface-2);}
    .te-prop-del{
      width:22px;height:22px;border:none;background:none;color:var(--color-text-muted);
      cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;
      border-radius:3px;flex-shrink:0;
    }
    .te-prop-del:hover{color:var(--color-danger);background:rgba(239,68,68,0.08);}
    .te-prop-body{
      padding:var(--space-3);border-top:1px solid var(--color-border);
      display:flex;flex-direction:column;gap:var(--space-3);background:var(--color-surface-2);
    }
    .te-prop-body-row{display:grid;grid-template-columns:1fr 1fr;gap:var(--space-2);}
    .te-sublbl{
      font-size:var(--text-xs);font-weight:var(--weight-semibold);color:var(--color-text-muted);
      text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;
    }
    /* Select options */
    .te-opts-list{display:flex;flex-direction:column;gap:var(--space-1);}
    .te-opt-row{display:flex;align-items:center;gap:var(--space-1);}
    .te-opt-input{
      flex:1;padding:4px 8px;border:1px solid var(--color-border);border-radius:var(--radius-sm);
      background:var(--color-bg);color:var(--color-text);font-size:var(--text-xs);
    }
    .te-opt-del{
      width:20px;height:20px;border:none;background:none;color:var(--color-text-muted);
      cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;border-radius:3px;
    }
    .te-opt-del:hover{color:var(--color-danger);}
    .te-add-opt{
      font-size:var(--text-xs);color:var(--color-accent);background:none;border:none;
      cursor:pointer;padding:3px 0;display:flex;align-items:center;gap:4px;
    }
    /* Type picker grid */
    .te-type-grid{
      display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:var(--space-1);
    }
    .te-type-chip{
      display:flex;flex-direction:column;align-items:center;gap:3px;padding:var(--space-2);
      border:1.5px solid var(--color-border);border-radius:var(--radius-md);cursor:pointer;
      font-size:var(--text-xs);color:var(--color-text-muted);text-align:center;transition:all 0.12s;
    }
    .te-type-chip:hover{border-color:var(--color-accent);color:var(--color-text);}
    .te-type-chip-ico{font-size:16px;}
    /* Add prop button */
    .te-add-prop{
      width:100%;padding:10px;border:2px dashed var(--color-border);border-radius:var(--radius-md);
      background:none;color:var(--color-text-muted);font-size:var(--text-sm);cursor:pointer;
      transition:all 0.12s;display:flex;align-items:center;justify-content:center;gap:4px;
    }
    .te-add-prop:hover{border-color:var(--color-accent);color:var(--color-accent);}
    /* Views tab */
    .te-views-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:var(--space-2);}
    .te-view-chip{
      display:flex;flex-direction:column;align-items:center;gap:4px;
      padding:var(--space-3) var(--space-2);border:1.5px solid var(--color-border);
      border-radius:var(--radius-md);cursor:pointer;text-align:center;transition:all 0.12s;
    }
    .te-view-chip:hover{border-color:var(--color-accent);}
    .te-view-chip.selected{border-color:var(--color-accent);background:var(--color-accent-muted);}
    .te-view-ico{font-size:1.5rem;}
    .te-view-lbl{font-size:var(--text-xs);font-weight:var(--weight-semibold);color:var(--color-text);}
    .te-view-desc{font-size:10px;color:var(--color-text-muted);}
    /* Dashboard sections */
    .te-secs{display:flex;flex-direction:column;gap:var(--space-2);}
    .te-sec-row{
      display:flex;align-items:center;gap:var(--space-2);padding:var(--space-2);
      background:var(--color-surface);border:1px solid var(--color-border);
      border-radius:var(--radius-md);cursor:pointer;transition:border-color 0.12s;
    }
    .te-sec-row:hover{border-color:var(--color-accent);}
    .te-chk{
      width:18px;height:18px;border:1.5px solid var(--color-border);border-radius:4px;
      background:var(--color-bg);flex-shrink:0;display:flex;align-items:center;justify-content:center;
      font-size:11px;
    }
    .te-chk.on{background:var(--color-accent);border-color:var(--color-accent);color:#fff;}
    .te-sec-ico{font-size:1rem;}
    .te-sec-lbl{font-size:var(--text-sm);color:var(--color-text);flex:1;}
    /* Footer */
    .te-footer{
      display:flex;align-items:center;justify-content:space-between;
      padding:var(--space-3) var(--space-5);border-top:1px solid var(--color-border);
      flex-shrink:0;background:var(--color-bg);gap:var(--space-2);
    }
    .te-footer-l,.te-footer-r{display:flex;gap:var(--space-2);}
    .te-btn-del{
      padding:7px 14px;border:1px solid var(--color-danger);border-radius:var(--radius-md);
      background:none;color:var(--color-danger);font-size:var(--text-sm);cursor:pointer;
    }
    .te-btn-del:hover{background:rgba(239,68,68,0.08);}
    .te-btn-cancel{
      padding:7px 14px;border:1px solid var(--color-border);border-radius:var(--radius-md);
      background:none;color:var(--color-text-muted);font-size:var(--text-sm);cursor:pointer;
    }
    .te-btn-cancel:hover{background:var(--color-surface);color:var(--color-text);}
    .te-btn-save{
      padding:7px 20px;background:var(--color-accent);color:#fff;border:none;
      border-radius:var(--radius-md);font-size:var(--text-sm);font-weight:var(--weight-semibold);cursor:pointer;
    }
    .te-btn-save:hover{opacity:0.88;}
    .te-btn-save:disabled{opacity:0.5;cursor:default;}
    .te-builtin-banner{background:var(--color-accent-muted);border:1px solid var(--color-accent);
      border-radius:var(--radius-md);padding:10px 14px;font-size:var(--text-sm);
      color:var(--color-accent);margin-bottom:var(--space-3);}
    .te-ro-field{font-size:var(--text-sm);color:var(--color-text-muted);padding:4px 0;}
    .te-ro-field code{font-family:var(--font-mono,monospace);color:var(--color-text);}
    /* Readonly box */
    .te-ro-box{
      padding:var(--space-4);background:var(--color-surface);border:1px solid var(--color-border);
      border-radius:var(--radius-lg);display:flex;flex-direction:column;gap:var(--space-2);
    }
    .te-ro-title{font-size:var(--text-sm);font-weight:var(--weight-semibold);color:var(--color-text);}
    .te-ro-body{font-size:var(--text-sm);color:var(--color-text-muted);line-height:1.6;}
    /* Error */
    .te-err{
      padding:var(--space-2) var(--space-3);background:rgba(239,68,68,0.08);
      border:1px solid var(--color-danger);border-radius:var(--radius-md);
      font-size:var(--text-sm);color:var(--color-danger);
    }
  `;
  document.head.appendChild(s);
})();

// ── HTML escape ───────────────────────────────────────────────────
function _esc(v) {
  return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Tab content builders ──────────────────────────────────────────

function _renderGeneral(t) {
  if (t.isBuiltIn) {
    const fieldRows = (t.fields||[]).map(f => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;
        background:var(--color-surface);border-radius:var(--radius-sm);margin-top:6px;">
        <span>${PROPERTY_FIELD_TYPES[f.type]?.icon||'\u00B7'}</span>
        <span style="font-size:var(--text-sm);color:var(--color-text)">${_esc(f.label||f.key)}</span>
        <span style="margin-left:auto;font-size:var(--text-xs);color:var(--color-text-muted)">
          ${_esc(PROPERTY_FIELD_TYPES[f.type]?.label||f.type)}</span>
      </div>`).join('');
    const swatchesBI = COLORS.map(c =>
      `<div class="te-swatch${t.color===c?' selected':''}" data-sw="${_esc(c)}"
        style="background:${_esc(c)}" title="${_esc(c)}"></div>`).join('');
    const emojiGridBI = EMOJI_CATALOG.map(e =>
      `<button class="te-emoji-btn${t.icon===e?' selected':''}"
        data-emoji="${_esc(e)}">${_esc(e)}</button>`).join('');
    return `
      <div class="te-builtin-banner">
        \uD83D\uDD12 Built-in type \u2014 core identity and fields are locked.
        Icon, color, and description can be customized.
      </div>
      <div class="te-sec-title">Locked Identity</div>
      <div class="te-ro-field"><span>\uD83D\uDD12</span> Key: <code>${_esc(t.key)}</code></div>
      <div class="te-ro-field"><span>\uD83D\uDD12</span>
        Name: ${_esc(t.label)} / ${_esc(t.labelPlural)}</div>
      <div class="te-sec-title">Customize Appearance</div>
      <div class="te-field"><label class="te-lbl">Icon</label>
        <div class="te-icon-row">
          <div class="te-icon-preview" id="te-icon-prev">${_esc(t.icon||'\u25C7')}</div>
          <button class="te-emoji-toggle" id="te-emoji-tog">Choose emoji\u2026</button>
        </div>
        <div class="te-emoji-grid" id="te-emoji-grid" style="display:none">${emojiGridBI}</div>
      </div>
      <div class="te-field"><label class="te-lbl">Color accent</label>
        <div class="te-color-row">${swatchesBI}
          <input type="color" class="te-color-custom" id="te-custom-clr"
            value="${_esc(t.color||'#6366f1')}" title="Custom color">
        </div>
      </div>
      <div class="te-field"><label class="te-lbl">Description</label>
        <textarea id="te-desc" class="te-textarea"
          maxlength="240">${_esc(t.description||'')}</textarea>
      </div>
      <div class="te-field"><label class="te-lbl">Default view</label>
        <select id="te-defview" class="te-select">
          ${['list','grid','kanban','calendar','table','wall'].map(v =>
            `<option value="${v}"${t.defaultView===v?' selected':''}>${v}</option>`).join('')}
        </select>
      </div>
      <div class="te-field" style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" id="te-graphvis"
          ${t.graphVisible!==false?'checked':''}>
        <label for="te-graphvis" class="te-lbl" style="margin:0">
          Show in Knowledge Graph</label>
      </div>
      <div class="te-sec-title">Locked Fields</div>
      ${fieldRows}
    `;
  }

    const swatches=COLORS.map(c=>
    `<div class="te-swatch${t.color===c?' selected':''}" data-sw="${_esc(c)}" style="background:${_esc(c)}" title="${_esc(c)}"></div>`
  ).join('');
  const emojiGrid=EMOJI_CATALOG.map(e=>
    `<button class="te-emoji-btn${t.icon===e?' selected':''}" data-emoji="${_esc(e)}">${_esc(e)}</button>`
  ).join('');

  return `
    <div class="te-sec-title">Identity</div>
    <div class="te-row">
      <div class="te-field">
        <label class="te-lbl">Singular name<span class="te-req">*</span></label>
        <input id="te-lbl" class="te-input" type="text" value="${_esc(t.label||'')}" placeholder="e.g. Meeting" maxlength="40" autocomplete="off">
        <div class="te-hint">Used for individual objects</div>
      </div>
      <div class="te-field">
        <label class="te-lbl">Plural name<span class="te-req">*</span></label>
        <input id="te-plural" class="te-input" type="text" value="${_esc(t.labelPlural||'')}" placeholder="e.g. Meetings" maxlength="40" autocomplete="off">
        <div class="te-hint">Used in sidebar &amp; headers</div>
      </div>
    </div>
    <div class="te-field">
      <label class="te-lbl">Icon</label>
      <div class="te-icon-row">
        <div class="te-icon-preview" id="te-icon-prev">${_esc(t.icon||'📎')}</div>
        <button class="te-emoji-toggle" id="te-emoji-tog">Choose emoji…</button>
      </div>
      <div class="te-emoji-grid" id="te-emoji-grid" style="display:none">${emojiGrid}</div>
    </div>
    <div class="te-field">
      <label class="te-lbl">Color accent</label>
      <div class="te-color-row">
        ${swatches}
        <input type="color" class="te-color-custom" id="te-custom-clr" value="${_esc(t.color||'#6366f1')}" title="Custom color">
      </div>
    </div>
    <div class="te-sec-title" style="margin-top:var(--space-1)">Details</div>
    <div class="te-field">
      <label class="te-lbl">Description</label>
      <textarea id="te-desc" class="te-textarea" placeholder="What will you track with this type?" maxlength="240">${_esc(t.description||'')}</textarea>
    </div>
    <div class="te-field">
      <label class="te-lbl">Type key</label>
      <input id="te-key" class="te-input" type="text" value="${_esc(t.key||'')}" maxlength="40" autocomplete="off"
             style="font-family:var(--font-mono,monospace);font-size:var(--text-xs);color:var(--color-text-muted)">
      <div class="te-hint">Internal identifier. Change with care — affects existing data.</div>
    </div>
  `;
}

function _renderProperties(t) {
  if (t.isBuiltIn) return `<div class="te-ro-box">
    <div class="te-ro-title">🔒 Built-in properties</div>
    <div class="te-ro-body">Built-in type properties are managed internally and cannot be edited here.</div>
  </div>`;

  const fields=t.fields||[];

  const rows=fields.map(f=>{
    const ftd=PROPERTY_FIELD_TYPES[f.type]||{};
    const isExp=_propEditing===f.key;
    let body='';
    if (isExp) {
      const optHtml=['select','multiselect'].includes(f.type)?`
        <div class="te-field">
          <div class="te-sublbl">Options</div>
          <div class="te-opts-list">
            ${(f.options||[]).map((opt,oi)=>`
              <div class="te-opt-row">
                <input class="te-opt-input" type="text" value="${_esc(opt)}" data-of="${_esc(f.key)}" data-oi="${oi}" placeholder="Option ${oi+1}">
                <button class="te-opt-del" data-of="${_esc(f.key)}" data-oi="${oi}" title="Remove">✕</button>
              </div>`).join('')}
          </div>
          <button class="te-add-opt" data-addopt="${_esc(f.key)}">+ Add option</button>
        </div>`:''
      ;
      const relHtml=f.type==='relation'?`
        <div class="te-field">
          <div class="te-sublbl">Target type key</div>
          <input class="te-input" type="text" value="${_esc(f.targetType||'')}"
                 data-pk="${_esc(f.key)}" data-pf="targetType" placeholder="e.g. person">
        </div>`:''
      ;
      body=`<div class="te-prop-body">
        <div class="te-prop-body-row">
          <div class="te-field">
            <div class="te-sublbl">Label</div>
            <input class="te-input" type="text" value="${_esc(f.label||'')}"
                   data-pk="${_esc(f.key)}" data-pf="label" maxlength="40" ${f.isTitle?'disabled':''}>
          </div>
          <div class="te-field">
            <div class="te-sublbl">Field type</div>
            <select class="te-select" data-pk="${_esc(f.key)}" data-pf="type" ${f.isTitle?'disabled':''}>
              ${Object.entries(PROPERTY_FIELD_TYPES).map(([k,v])=>
                `<option value="${k}"${f.type===k?' selected':''}>${_esc(v.icon)} ${_esc(v.label)}</option>`
              ).join('')}
            </select>
          </div>
        </div>
        ${optHtml}${relHtml}
        ${f.type==='number'?`
          <div class="te-field" style="margin-top:6px">
            <div class="te-sublbl">Constraints (optional)</div>
            <div style="display:flex;gap:6px;">
              <input class="te-input" style="width:68px" type="number" placeholder="Min"
                data-pk="${_esc(f.key)}" data-pf="min" value="${_esc(f.min!=null?f.min:'')}">
              <input class="te-input" style="width:68px" type="number" placeholder="Max"
                data-pk="${_esc(f.key)}" data-pf="max" value="${_esc(f.max!=null?f.max:'')}">
              <input class="te-input" style="width:68px" type="number" placeholder="Step"
                data-pk="${_esc(f.key)}" data-pf="step" value="${_esc(f.step!=null?f.step:'')}">
            </div>
          </div>`:''}
        ${!f.isTitle?`
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:var(--text-sm)">
            <input type="checkbox" data-pk="${_esc(f.key)}" data-pf="required" ${f.required?'checked':''}>
            Required field
          </label>`:''
        }
      </div>`;
    }
    return `<div class="te-prop-row${isExp?' expanded':''}" data-pr="${_esc(f.key)}">
      <div class="te-prop-hdr" data-expand="${_esc(f.key)}">
        <span class="te-prop-ico">${_esc(ftd.icon||'·')}</span>
        <span class="te-prop-lbl">${_esc(f.label||f.key)}${f.isTitle?' <small style="color:var(--color-text-muted)">(title)</small>':''}${f.required?' <span style="color:var(--color-danger);font-size:11px">*</span>':''}</span>
        <span class="te-prop-badge">${_esc(ftd.label||f.type)}</span>
        <button class="te-prop-exp" data-expand="${_esc(f.key)}" title="${isExp?'Collapse':'Expand'}">${isExp?'▲':'▼'}</button>
        ${!f.isTitle?`<button class="te-prop-del" data-del="${_esc(f.key)}" title="Remove field">✕</button>`:''}
      </div>${body}
    </div>`;
  }).join('');

  const catSections=PROPERTY_CATEGORIES.map(cat=>`
    <div>
      <div style="font-size:var(--text-xs);color:var(--color-text-muted);font-weight:var(--weight-semibold);margin:var(--space-1) 0">${_esc(cat.label)}</div>
      <div class="te-type-grid">
        ${Object.entries(PROPERTY_FIELD_TYPES)
          .filter(([,v])=>v.category===cat.key)
          .map(([k,v])=>`
            <div class="te-type-chip" data-addpt="${_esc(k)}" title="${_esc(v.description||'')}">
              <span class="te-type-chip-ico">${_esc(v.icon)}</span>
              <span>${_esc(v.label)}</span>
            </div>`).join('')}
      </div>
    </div>`).join('');

  return `
    <div class="te-sec-title">Properties (${fields.length})</div>
    <div class="te-props-list">
      ${rows||'<div style="color:var(--color-text-muted);font-size:var(--text-sm);padding:var(--space-2)">No properties yet.</div>'}
    </div>
    <div style="margin-top:var(--space-2)">
      <button class="te-add-prop" id="te-add-prop">+ Add Property</button>
    </div>
    <div class="te-sec-title" style="margin-top:var(--space-3)">Quick add by type</div>
    ${catSections}
  `;
}

function _renderViews(t) {
  const dv=t.defaultView||'list';
  const secs=t.dashboardSections||[];
  const viewChips=VIEW_MODES.map(vm=>`
    <div class="te-view-chip${dv===vm.key?' selected':''}" data-dv="${_esc(vm.key)}">
      <span class="te-view-ico">${_esc(vm.icon)}</span>
      <span class="te-view-lbl">${_esc(vm.label)}</span>
      <span class="te-view-desc">${_esc(vm.description)}</span>
    </div>`).join('');
  const secRows=DASHBOARD_SECTION_DEFS.map(sec=>{
    const on=secs.includes(sec.key);
    return `<div class="te-sec-row" data-ts="${_esc(sec.key)}">
      <div class="te-chk${on?' on':''}">${on?'✓':''}</div>
      <span class="te-sec-ico">${_esc(sec.icon)}</span>
      <span class="te-sec-lbl">${_esc(sec.label)}</span>
    </div>`;
  }).join('');
  return `
    <div class="te-sec-title">Default Data View</div>
    <div class="te-hint" style="margin-bottom:var(--space-2)">How objects appear when you open this type.</div>
    <div class="te-views-grid">${viewChips}</div>
    <div class="te-sec-title" style="margin-top:var(--space-4)">Dashboard Sections</div>
    <div class="te-hint" style="margin-bottom:var(--space-2)">Sections shown on this type's dashboard page.</div>
    <div class="te-secs">${secRows}</div>
    <div class="te-sec-title" style="margin-top:var(--space-4)">Graph</div>
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:var(--text-sm)">
      <input type="checkbox" id="te-gv" ${(t.graphVisible!==false)?'checked':''}>
      Show in Knowledge Graph
    </label>
  `;
}

// ── Render full drawer (replaces innerHTML — no accumulation) ──────
function _renderDrawer() {
  if (!_drawerEl||!_editingType) return;
  const t=_editingType;
  let content='';
  if (_activeTab==='general')    content=_renderGeneral(t);
  if (_activeTab==='properties') content=_renderProperties(t);
  if (_activeTab==='views')      content=_renderViews(t);

  const badge=t.isBuiltIn
    ? `<span class="te-badge">🔒 Built-in</span>`
    : `<span class="te-badge custom">✦ Custom</span>`;

  _drawerEl.innerHTML=`
    <div class="te-drawer" role="dialog" aria-modal="true" aria-label="Type settings">
      <div class="te-hdr">
        <div class="te-hdr-l">
          <div class="te-hdr-icon">${_esc(t.icon||'📎')}</div>
          <div>
            <div class="te-hdr-name">${_esc(t.labelPlural||t.label||t.key)}</div>
            <div class="te-hdr-sub">Object Type Settings ${badge}</div>
          </div>
        </div>
        <button class="te-close" id="te-close" title="Close (Esc)">✕</button>
      </div>
      <div class="te-tabs">
        <button class="te-tab${_activeTab==='general'    ?' active':''}" data-tab="general">General</button>
        <button class="te-tab${_activeTab==='properties' ?' active':''}" data-tab="properties">Properties</button>
        <button class="te-tab${_activeTab==='views'      ?' active':''}" data-tab="views">Views</button>
      </div>
      <div class="te-content" id="te-content">${content}</div>
      <div class="te-footer">
        <div class="te-footer-l">
          ${!t.isBuiltIn?`<button class="te-btn-del" id="te-del">Delete Type</button>`:''}
        </div>
        <div class="te-footer-r">
          <button class="te-btn-cancel" id="te-cancel">Cancel</button>
          <button class="te-btn-save" id="te-save">Save Changes</button>
        </div>
      </div>
    </div>
  `;
  _wire();
}

// ── Wire all events after each render ─────────────────────────────
// Called right after _drawerEl.innerHTML is replaced, so all
// elements are fresh — no risk of accumulation.
function _wire() {
  const d=_drawerEl?.querySelector('.te-drawer');
  if (!d) return;
  const t=_editingType;

  // Close
  d.querySelector('#te-close').addEventListener('click', closeTypeEditor);
  d.querySelector('#te-cancel')?.addEventListener('click', closeTypeEditor);
  _drawerEl.addEventListener('click', e=>{ if(e.target===_drawerEl) closeTypeEditor(); });

  // Tab switch
  d.querySelector('.te-tabs').addEventListener('click', e=>{
    const tab=e.target.closest('[data-tab]');
    if (!tab) return;
    _activeTab=tab.dataset.tab;
    _propEditing=null;
    _renderDrawer();
  });

  // Wire appearance fields for both built-in and custom types
  const emojiTog  = d.querySelector('#te-emoji-tog');
  const emojiGrid = d.querySelector('#te-emoji-grid');
  const iconPrev  = d.querySelector('#te-icon-prev');
  if (emojiTog && emojiGrid && iconPrev) {
    emojiTog.addEventListener('click', () => {
      emojiGrid.style.display = emojiGrid.style.display === 'none' ? 'grid' : 'none';
    });
    emojiGrid.addEventListener('click', e => {
      const btn = e.target.closest('.te-emoji-btn');
      if (!btn) return;
      t.icon = btn.dataset.emoji;
      iconPrev.textContent = t.icon;
      d.querySelectorAll('.te-emoji-btn').forEach(b =>
        b.classList.toggle('selected', b === btn));
      emojiGrid.style.display = 'none';
    });
  }
  const customClr = d.querySelector('#te-custom-clr');
  if (customClr) {
    customClr.addEventListener('input', e => {
      t.color = e.target.value;
      d.querySelectorAll('.te-swatch').forEach(s => s.classList.remove('selected'));
    });
  }
  d.querySelectorAll('.te-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      t.color = sw.dataset.sw;
      d.querySelectorAll('.te-swatch').forEach(s =>
        s.classList.toggle('selected', s === sw));
      if (customClr) customClr.value = t.color;
    });
  });
  const descEl = d.querySelector('#te-desc');
  if (descEl) descEl.addEventListener('input', e => { t.description = e.target.value; });
  const defViewEl = d.querySelector('#te-defview');
  if (defViewEl) defViewEl.addEventListener('change', e => { t.defaultView = e.target.value; });
  const graphVisEl = d.querySelector('#te-graphvis');
  if (graphVisEl) graphVisEl.addEventListener('change', e => { t.graphVisible = e.target.checked; });

  if (t.isBuiltIn) {
    const sb = d.querySelector('#te-save');
    if (sb) {
      sb.addEventListener('click', async () => {
        sb.disabled = true; sb.textContent = 'Saving…';
        try {
          await saveEntityType({
            key:         t.key,
            icon:        t.icon,
            color:       t.color,
            description: t.description,
            graphVisible:t.graphVisible,
            defaultView: t.defaultView,
            isBuiltIn:   true,
          });
          toast.success('Built-in type updated');
          if (_onSavedCb) _onSavedCb(t);
          closeTypeEditor();
        } catch (err) {
          console.error('[type-editor] save built-in:', err);
          toast.error('Save failed — see console');
          sb.disabled = false; sb.textContent = 'Save Changes';
        }
      });
    }
    return; // Skip custom-type-only wiring below
  }

  // ── General tab ───────────────────────────────────────────────
  if (_activeTab==='general') {
    d.querySelector('#te-lbl')?.addEventListener('input', e=>{ t.label=e.target.value; });
    d.querySelector('#te-plural')?.addEventListener('input', e=>{ t.labelPlural=e.target.value; });
    d.querySelector('#te-key')?.addEventListener('input', e=>{ t.key=e.target.value; });

    // Emoji picker, color swatches handled by shared wiring block above.
  }

  // ── Properties tab ────────────────────────────────────────────
  if (_activeTab==='properties') {
    // Expand / collapse property rows
    // Wire on the prop-hdr divs (via data-expand) — stopPropagation prevents
    // delete button from also triggering expand.
    d.querySelectorAll('[data-expand]').forEach(el=>{
      el.addEventListener('click', e=>{
        e.stopPropagation();
        const k=el.dataset.expand;
        if (!k) return;
        _propEditing=(_propEditing===k)?null:k;
        _renderDrawer();
      });
    });

    // Delete property
    d.querySelectorAll('[data-del]').forEach(el=>{
      el.addEventListener('click', e=>{
        e.stopPropagation();
        const k=el.dataset.del;
        if (!k||!confirm(`Remove property "${k}"? Existing data for this field is not deleted.`)) return;
        t.fields=(t.fields||[]).filter(f=>f.key!==k);
        if (_propEditing===k) _propEditing=null;
        emit(EVENTS.TYPE_FIELD_REMOVED,{typeKey:t.key,fieldKey:k});
        _renderDrawer();
      });
    });

    // Edit property: label / type / required / targetType
    d.querySelectorAll('[data-pk][data-pf]').forEach(inp=>{
      const ev=(inp.tagName==='SELECT'||inp.type==='checkbox')?'change':'input';
      inp.addEventListener(ev, ()=>{
        const k=inp.dataset.pk, field=inp.dataset.pf;
        const fi=(t.fields||[]).findIndex(f=>f.key===k);
        if (fi<0) return;
        if (inp.type==='checkbox') {
          t.fields[fi][field]=inp.checked;
        } else if (['min','max','step'].includes(field)) {
          // Coerce numeric constraint fields to Number (or null if empty)
          t.fields[fi][field] = inp.value !== '' ? Number(inp.value) : null;
        } else {
          t.fields[fi][field]=inp.value;
        }
        // CRITICAL: entity-form reads relatesTo, not targetType
        if (field==='targetType') { t.fields[fi].relatesTo=inp.value; }
        // Re-render on type change so options / relation UI appears
        if (field==='type') { _propEditing=k; _renderDrawer(); }
      });
    });

    // Select/multiselect option edit
    d.querySelectorAll('[data-of]').forEach(inp=>{
      if (inp.tagName!=='INPUT') return;
      inp.addEventListener('input', ()=>{
        const fk=inp.dataset.of, oi=Number(inp.dataset.oi);
        const fi=(t.fields||[]).findIndex(f=>f.key===fk);
        if (fi>=0) t.fields[fi].options[oi]=inp.value;
      });
    });
    d.querySelectorAll('.te-opt-del').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const fk=btn.dataset.of, oi=Number(btn.dataset.oi);
        const fi=(t.fields||[]).findIndex(f=>f.key===fk);
        if (fi>=0) { t.fields[fi].options.splice(oi,1); _renderDrawer(); }
      });
    });
    d.querySelectorAll('[data-addopt]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const fk=btn.dataset.addopt;
        const fi=(t.fields||[]).findIndex(f=>f.key===fk);
        if (fi>=0) { t.fields[fi].options=[...(t.fields[fi].options||[]),'']; _renderDrawer(); }
      });
    });

    // Quick-add via type chip
    d.querySelectorAll('[data-addpt]').forEach(chip=>{
      chip.addEventListener('click', ()=>{
        const ftype=chip.dataset.addpt;
        const ftd=PROPERTY_FIELD_TYPES[ftype]||{};
        const nf=makeDefaultField({
          type:ftype, label:ftd.label||'New Property',
          key:`${ftype}_${Date.now()}`,
          options:['select','multiselect'].includes(ftype)?[]:undefined,
        });
        t.fields=[...(t.fields||[]),nf];
        _propEditing=nf.key;
        emit(EVENTS.TYPE_FIELD_ADDED,{typeKey:t.key,field:nf});
        _renderDrawer();
      });
    });

    // Plain add property button
    d.querySelector('#te-add-prop')?.addEventListener('click', ()=>{
      const nf=makeDefaultField({type:'text',label:'New Property',key:`prop_${Date.now()}`});
      t.fields=[...(t.fields||[]),nf];
      _propEditing=nf.key;
      _renderDrawer();
    });
  }

  // ── Views tab ─────────────────────────────────────────────────
  if (_activeTab==='views') {
    d.querySelectorAll('[data-dv]').forEach(chip=>{
      chip.addEventListener('click', ()=>{
        t.defaultView=chip.dataset.dv;
        d.querySelectorAll('[data-dv]').forEach(c=>c.classList.toggle('selected',c===chip));
      });
    });
    d.querySelectorAll('[data-ts]').forEach(row=>{
      row.addEventListener('click', ()=>{
        const k=row.dataset.ts;
        const secs=t.dashboardSections||[];
        const isOn=secs.includes(k);
        t.dashboardSections=isOn?secs.filter(s=>s!==k):[...secs,k];
        const chk=row.querySelector('.te-chk');
        chk.classList.toggle('on',!isOn);
        chk.textContent=isOn?'':'✓';
      });
    });
    d.querySelector('#te-gv')?.addEventListener('change', e=>{
      t.graphVisible=e.target.checked;
    });
  }

  // ── Save ──────────────────────────────────────────────────────
  d.querySelector('#te-save')?.addEventListener('click', async ()=>{
    const sb=d.querySelector('#te-save');
    // Sync any still-live General inputs into working copy
    const lbl=d.querySelector('#te-lbl');
    const pl=d.querySelector('#te-plural');
    const ds=d.querySelector('#te-desc');
    const kk=d.querySelector('#te-key');
    if (lbl)           t.label=lbl.value.trim();
    if (pl)            t.labelPlural=pl.value.trim()||(t.label+'s');
    if (ds)            t.description=ds.value.trim();
    if (kk?.value.trim()) t.key=kk.value.trim();

    if (!t.label) { _showErr(d,'Singular name is required.'); return; }
    sb.disabled=true; sb.textContent='Saving…';
    try {
      const badRelations = (t.fields||[]).filter(f => f.type==='relation' && !f.targetType);
      if (badRelations.length) {
        toast.error(`Relation '${badRelations[0].label||badRelations[0].key}' needs a target type`);
        sb.disabled=false; sb.textContent='Save Changes'; return;
      }
      await saveCustomObjectType(t);
      if (_onSavedCb) _onSavedCb(t);
      closeTypeEditor();
    } catch(err) {
      console.error('[type-editor] save error:',err);
      _showErr(d,err.message||'Save failed. Please try again.');
      sb.disabled=false; sb.textContent='Save Changes';
    }
  });

  // ── Delete ────────────────────────────────────────────────────
  d.querySelector('#te-del')?.addEventListener('click', async ()=>{
    const nm=t.labelPlural||t.label||t.key;
    if (!confirm(`Delete the "${nm}" type?\n\nExisting objects of this type remain in the database but won't appear in any type view.`)) return;
    try {
      await deleteCustomObjectType(t.key);
      if (_onSavedCb) _onSavedCb(null);
      closeTypeEditor();
    } catch(err) { alert(err.message||'Cannot delete this type.'); }
  });
}

function _showErr(drawer, msg) {
  let el=drawer.querySelector('#te-err');
  if (!el) {
    el=document.createElement('div');
    el.id='te-err'; el.className='te-err';
    drawer.querySelector('#te-content').prepend(el);
  }
  el.textContent=msg;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Open the type editor drawer.
 * @param {string}    typeKey  Entity type key to edit
 * @param {Function}  [onSaved]  Called with config on save, null on delete
 */
export async function openTypeEditor(typeKey, onSaved) {
  closeTypeEditor();  // clean up any existing drawer
  _onSavedCb   = onSaved || null;
  _activeTab   = 'general';
  _propEditing = null;

  // Load config (registry → graph-engine → minimal fallback)
  let config=null;
  try { config=await getObjectTypeConfig(typeKey); } catch { /* ok */ }
  if (!config) {
    config = {
      key:typeKey, label:typeKey, labelPlural:typeKey+'s',
      icon:'📎', color:'#6366f1',
      isBuiltIn:isBuiltInType(typeKey), canDelete:!isBuiltInType(typeKey),
      fields:[{key:'title',label:'Title',type:'text',isTitle:true,required:true}],
      defaultView:'list', dashboardSections:['recentlyOpened','allObjects'], description:'',
    };
  }

  // Deep-clone so mutations don't affect the registry cache until Save
  _editingType=JSON.parse(JSON.stringify(config));
  if (!Array.isArray(_editingType.fields)) _editingType.fields=[];
  if (!_editingType.fields.some(f=>f.isTitle)) {
    _editingType.fields.unshift({key:'title',label:'Title',type:'text',isTitle:true,required:true});
  }

  // Mount overlay
  _drawerEl=document.createElement('div');
  _drawerEl.className='te-overlay';
  document.body.appendChild(_drawerEl);
  _renderDrawer();

  // ESC closes the drawer
  const _kd=e=>{ if(e.key==='Escape') closeTypeEditor(); };
  document.addEventListener('keydown',_kd);
  _drawerEl._kd=_kd;
}

/** Programmatically close the type editor. */
export function closeTypeEditor() {
  if (_drawerEl?._kd) document.removeEventListener('keydown',_drawerEl._kd);
  _drawerEl?.remove();
  _drawerEl=null; _editingType=null; _onSavedCb=null; _propEditing=null;
}
