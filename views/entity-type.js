/**
 * FamilyHub v3 — views/entity-type.js
 * [MAJOR] 2-A v2 — Capacities-Inspired Entity Type View
 *
 * Multi-view entity listing with:
 *   • List    — compact rows
 *   • Gallery — card grid
 *   • Table   — sortable spreadsheet (all property columns)
 *   • Wall    — masonry card layout with rich-text preview
 *
 * Plus: search bar, sort popover, ⚙ settings for custom types,
 * description banner, live count display.
 *
 * BUG FIX (v2): Body click listener is wired ONCE to the stable
 * container element via event delegation — no accumulation on search.
 *
 * Registration: registerView('entity-type', renderEntityTypeView)
 * Container:    #view-entity-type
 */

import { registerView, navigate }      from '../core/router.js';
import { on, emit, EVENTS }            from '../core/events.js';
import { getEntitiesByType }           from '../core/db.js';
import { filterByContext }             from '../core/context.js';
import { getEntityTypeConfig }         from '../core/graph-engine.js';
import { getObjectTypeConfig, VIEW_MODES } from '../core/object-type-registry.js';
import { openForm }                    from '../components/entity-form.js';
import { openTypeEditor }              from '../components/type-editor-modal.js';

// ── Module state ──────────────────────────────────────────────────
let _currentType = null;
let _currentMode = 'list';
let _searchQ     = '';
let _sortField   = null;  // null = use config.defaultSort
let _sortDir     = 'desc';
let _unsubList   = [];

// ── Styles ────────────────────────────────────────────────────────
(function _injectStyles() {
  if (document.getElementById('entity-type-view-styles')) return;
  const s = document.createElement('style');
  s.id = 'entity-type-view-styles';
  s.textContent = `
    #view-entity-type.active {
      padding:0; overflow:hidden; display:flex; flex-direction:column; height:100%;
    }
    /* Header */
    .etv-header {
      display:flex; align-items:center; justify-content:space-between;
      padding:var(--space-4) var(--space-6) var(--space-3);
      border-bottom:1px solid var(--color-border);
      background:var(--color-bg); position:sticky; top:0; z-index:10;
      flex-shrink:0; gap:var(--space-3); flex-wrap:wrap;
    }
    .etv-title {
      display:flex; align-items:center; gap:var(--space-2);
      font-size:var(--text-xl); font-weight:var(--weight-bold); color:var(--color-text);
    }
    .etv-header-right { display:flex; align-items:center; gap:var(--space-2); }
    .etv-mode-toggle {
      display:flex; gap:2px; background:var(--color-surface);
      border:1px solid var(--color-border); border-radius:var(--radius-md); padding:2px;
    }
    .etv-mode-btn {
      padding:4px 10px; border:none; border-radius:calc(var(--radius-md) - 2px);
      background:transparent; color:var(--color-text-muted);
      font-size:var(--text-sm); cursor:pointer;
      transition:background 0.15s, color 0.15s; line-height:1;
    }
    .etv-mode-btn.active { background:var(--color-accent); color:#fff; }
    .etv-mode-btn:not(.active):hover {
      background:var(--color-surface-2,rgba(255,255,255,0.06)); color:var(--color-text);
    }
    .etv-icon-btn {
      width:32px; height:32px; border:1px solid var(--color-border);
      border-radius:var(--radius-md); background:var(--color-surface);
      color:var(--color-text-muted); font-size:16px; cursor:pointer;
      display:flex; align-items:center; justify-content:center; transition:all 0.12s;
    }
    .etv-icon-btn:hover { color:var(--color-text); border-color:var(--color-accent); }
    .etv-new-btn {
      display:flex; align-items:center; gap:4px;
      padding:6px 14px; background:var(--color-accent); color:#fff; border:none;
      border-radius:var(--radius-md); font-size:var(--text-sm);
      font-weight:var(--weight-semibold); cursor:pointer; white-space:nowrap;
    }
    .etv-new-btn:hover { opacity:0.88; }
    .etv-count {
      display:inline-block; padding:1px 7px;
      background:var(--color-surface); border:1px solid var(--color-border);
      border-radius:var(--radius-full); font-size:var(--text-xs); color:var(--color-text-muted);
    }
    /* Description banner */
    .etv-desc-banner {
      padding:var(--space-2) var(--space-6); background:var(--color-accent-muted);
      border-bottom:1px solid var(--color-border); font-size:var(--text-sm);
      color:var(--color-text); display:flex; align-items:center; gap:var(--space-2); flex-shrink:0;
    }
    /* Toolbar */
    .etv-toolbar {
      display:flex; align-items:center; gap:var(--space-2);
      padding:var(--space-2) var(--space-6);
      border-bottom:1px solid var(--color-border);
      background:var(--color-surface); flex-shrink:0; flex-wrap:wrap;
    }
    .etv-search-wrap { position:relative; flex:1; min-width:140px; max-width:280px; }
    .etv-search-wrap::before {
      content:'⌕'; position:absolute; left:7px; top:50%; transform:translateY(-50%);
      color:var(--color-text-muted); font-size:15px; pointer-events:none; z-index:1;
    }
    .etv-search {
      width:100%; padding:5px 10px 5px 28px;
      border:1px solid var(--color-border); border-radius:var(--radius-md);
      background:var(--color-bg); color:var(--color-text); font-size:var(--text-sm);
    }
    .etv-search:focus { outline:none; border-color:var(--color-accent); }
    .etv-sort-btn {
      display:flex; align-items:center; gap:4px;
      padding:5px 10px; border:1px solid var(--color-border); border-radius:var(--radius-md);
      background:var(--color-bg); color:var(--color-text-muted); font-size:var(--text-sm);
      cursor:pointer; white-space:nowrap;
    }
    .etv-sort-btn:hover { color:var(--color-text); border-color:var(--color-accent); }
    .etv-sort-btn.active { color:var(--color-accent); border-color:var(--color-accent); }
    .etv-count-lbl { margin-left:auto; font-size:var(--text-xs); color:var(--color-text-muted); white-space:nowrap; }
    /* Sort popover */
    .etv-sort-popover {
      position:absolute; top:calc(100% + 4px); left:0;
      background:var(--color-bg); border:1px solid var(--color-border);
      border-radius:var(--radius-lg); box-shadow:0 8px 24px rgba(0,0,0,0.12);
      z-index:50; min-width:200px; padding:var(--space-1);
    }
    .etv-sort-opt {
      display:flex; align-items:center; gap:var(--space-2); padding:7px 12px;
      border-radius:var(--radius-sm); cursor:pointer; font-size:var(--text-sm); color:var(--color-text);
    }
    .etv-sort-opt:hover { background:var(--color-surface); }
    .etv-sort-opt.selected { color:var(--color-accent); background:var(--color-accent-muted); }
    .etv-sort-dir { margin-left:auto; font-size:11px; color:var(--color-text-muted); }
    /* Scrollable body */
    .etv-body { flex:1; padding:var(--space-4) var(--space-6); overflow-y:auto; }
    /* Empty state */
    .etv-empty {
      display:flex; flex-direction:column; align-items:center; justify-content:center;
      padding:var(--space-10) var(--space-4); text-align:center; gap:var(--space-3);
    }
    .etv-empty-icon { font-size:3rem; opacity:0.4; }
    .etv-empty-title { font-size:var(--text-lg); font-weight:var(--weight-semibold); color:var(--color-text); }
    .etv-empty-sub { font-size:var(--text-sm); color:var(--color-text-muted); }
    .etv-empty-btn {
      padding:8px 20px; background:var(--color-accent); color:#fff; border:none;
      border-radius:var(--radius-md); font-size:var(--text-sm);
      font-weight:var(--weight-semibold); cursor:pointer; margin-top:var(--space-2);
    }
    .etv-empty-btn:hover { opacity:0.88; }
    /* Shared tag chip */
    .etv-tag {
      display:inline-block; padding:1px 6px; background:var(--color-accent-muted);
      color:var(--color-accent); border-radius:var(--radius-full);
      font-size:var(--text-xs); font-weight:var(--weight-medium);
    }
    /* LIST */
    .etv-list { display:flex; flex-direction:column; gap:var(--space-2); }
    .etv-list-item {
      display:flex; align-items:flex-start; gap:var(--space-3);
      padding:var(--space-3) var(--space-4); background:var(--color-surface);
      border:1px solid var(--color-border); border-radius:var(--radius-md);
      cursor:pointer; transition:border-color 0.15s, background 0.15s;
    }
    .etv-list-item:hover { border-color:var(--color-accent); background:var(--color-surface-2,var(--color-surface)); }
    .etv-list-icon { font-size:1.25rem; flex-shrink:0; margin-top:1px; }
    .etv-list-content { flex:1; min-width:0; }
    .etv-list-title {
      font-size:var(--text-sm); font-weight:var(--weight-semibold); color:var(--color-text);
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    }
    .etv-list-meta { display:flex; flex-wrap:wrap; gap:var(--space-2); margin-top:3px; }
    .etv-list-field { font-size:var(--text-xs); color:var(--color-text-muted); display:flex; align-items:center; gap:3px; }
    .etv-list-date { font-size:var(--text-xs); color:var(--color-text-muted); flex-shrink:0; white-space:nowrap; align-self:flex-start; margin-top:2px; }
    /* GALLERY (GRID) */
    .etv-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:var(--space-3); }
    .etv-grid-card {
      background:var(--color-surface); border:1px solid var(--color-border);
      border-radius:var(--radius-lg); padding:var(--space-4); cursor:pointer;
      transition:border-color 0.15s, transform 0.1s;
      display:flex; flex-direction:column; gap:var(--space-2);
    }
    .etv-grid-card:hover { border-color:var(--color-accent); transform:translateY(-1px); }
    .etv-grid-icon { font-size:1.75rem; }
    .etv-grid-title {
      font-size:var(--text-sm); font-weight:var(--weight-bold); color:var(--color-text);
      line-height:1.35; display:-webkit-box; -webkit-line-clamp:2;
      -webkit-box-orient:vertical; overflow:hidden;
    }
    .etv-grid-fields { display:flex; flex-direction:column; gap:4px; }
    .etv-grid-field { font-size:var(--text-xs); color:var(--color-text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .etv-grid-tags { display:flex; flex-wrap:wrap; gap:4px; margin-top:auto; }
    /* TABLE */
    .etv-table-wrap { overflow-x:auto; border:1px solid var(--color-border); border-radius:var(--radius-lg); }
    .etv-table { width:100%; border-collapse:collapse; font-size:var(--text-sm); min-width:500px; }
    .etv-table thead { background:var(--color-surface); border-bottom:2px solid var(--color-border); }
    .etv-table th {
      padding:var(--space-2) var(--space-3); text-align:left;
      font-size:var(--text-xs); font-weight:var(--weight-semibold); color:var(--color-text-muted);
      text-transform:uppercase; letter-spacing:0.06em;
      cursor:pointer; white-space:nowrap; user-select:none;
      border-right:1px solid var(--color-border);
    }
    .etv-table th:last-child { border-right:none; cursor:default; }
    .etv-table th:hover:not(:last-child) { color:var(--color-text); background:var(--color-surface-2); }
    .etv-table th.th-sorted { color:var(--color-accent); }
    .etv-table tbody tr { border-bottom:1px solid var(--color-border); cursor:pointer; transition:background 0.1s; }
    .etv-table tbody tr:last-child { border-bottom:none; }
    .etv-table tbody tr:hover { background:var(--color-surface); }
    .etv-table td {
      padding:var(--space-2) var(--space-3); color:var(--color-text);
      border-right:1px solid var(--color-border);
      max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    }
    .etv-table td:last-child { border-right:none; }
    .etv-td-title { font-weight:var(--weight-semibold); }
    .etv-td-muted { color:var(--color-text-muted) !important; font-size:var(--text-xs); }
    .etv-tbl-open {
      width:26px; height:26px; border:none; background:none; color:var(--color-text-muted);
      cursor:pointer; border-radius:var(--radius-sm);
      display:inline-flex; align-items:center; justify-content:center; font-size:14px;
    }
    .etv-tbl-open:hover { background:var(--color-surface-2); color:var(--color-accent); }
    /* WALL */
    .etv-wall { columns:3; column-gap:var(--space-3); }
    @media(max-width:900px){.etv-wall{columns:2;}}
    @media(max-width:560px){.etv-wall{columns:1;}}
    .etv-wall-card {
      break-inside:avoid; background:var(--color-surface); border:1px solid var(--color-border);
      border-radius:var(--radius-lg); padding:var(--space-4); margin-bottom:var(--space-3);
      cursor:pointer; display:flex; flex-direction:column; gap:var(--space-2);
      transition:border-color 0.15s, box-shadow 0.15s;
    }
    .etv-wall-card:hover { border-color:var(--color-accent); box-shadow:0 4px 12px rgba(0,0,0,0.06); }
    .etv-wall-hdr { display:flex; align-items:flex-start; gap:var(--space-2); }
    .etv-wall-icon { font-size:1.5rem; flex-shrink:0; }
    .etv-wall-title { font-size:var(--text-base); font-weight:var(--weight-bold); color:var(--color-text); line-height:1.3; flex:1; }
    .etv-wall-preview {
      font-size:var(--text-xs); color:var(--color-text-muted); line-height:1.6;
      display:-webkit-box; -webkit-line-clamp:4; -webkit-box-orient:vertical; overflow:hidden;
    }
    .etv-wall-props { display:flex; flex-direction:column; gap:3px; padding-top:var(--space-1); border-top:1px solid var(--color-border); }
    .etv-wall-prop { display:flex; align-items:baseline; gap:var(--space-1); font-size:var(--text-xs); }
    .etv-wall-pk { color:var(--color-text-muted); flex-shrink:0; }
    .etv-wall-pv { color:var(--color-text); font-weight:var(--weight-medium); }
    .etv-wall-tags { display:flex; flex-wrap:wrap; gap:4px; }
    .etv-wall-date { font-size:var(--text-xs); color:var(--color-text-muted); }
  `;
  document.head.appendChild(s);
})();

// ── Helpers ───────────────────────────────────────────────────────
function _esc(v) {
  return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _stripHtml(h) { return String(h||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(); }
function _fmtDate(s) {
  if (!s) return '';
  try { return new Date(s+(s.length===10?'T00:00:00':'')).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}); }
  catch { return s; }
}
function _fmtVal(val,f) {
  if (val===null||val===undefined||val==='') return '';
  if (f?.type==='date') return _fmtDate(String(val));
  if (f?.type==='checkbox') return val?'✓':'✗';
  if (f?.type==='rating') return '⭐'.repeat(Math.min(5,Number(val)||0));
  if (Array.isArray(val)) return val.join(', ');
  if (typeof val==='boolean') return val?'Yes':'No';
  return _stripHtml(String(val));
}
function _getTitle(entity,config) {
  const tf=config?.fields?.find(f=>f.isTitle);
  if (tf&&entity[tf.key]) return entity[tf.key];
  for (const k of ['title','name','question','heading']) if (entity[k]) return entity[k];
  return config?.fields?.[0] ? entity[config.fields[0].key]||'' : '';
}
function _getKeyFields(entity,config,max=3) {
  if (!config?.fields) return [];
  const skip=new Set(['title','name','tags','photoUrl','imageUrl','body','content','notes']);
  return config.fields
    .filter(f=>!skip.has(f.key)&&!f.isTitle&&!['richtext','relation','multirelation'].includes(f.type))
    .slice(0,max)
    .map(f=>{
      const val=entity[f.key];
      if (val===null||val===undefined||val==='') return null;
      return {label:f.label||f.key, value:_fmtVal(val,f)};
    }).filter(Boolean);
}
function _getTags(entity) {
  const r=entity.tags;
  if (!r) return [];
  if (Array.isArray(r)) return r.slice(0,5);
  if (typeof r==='string') return r.split(',').map(t=>t.trim()).filter(Boolean).slice(0,5);
  return [];
}
function _getPreview(entity,config) {
  const rf=config?.fields?.find(f=>f.type==='richtext');
  if (rf&&entity[rf.key]) return _stripHtml(entity[rf.key]).slice(0,200);
  const tf=config?.fields?.find(f=>f.type==='textarea'&&!f.isTitle);
  if (tf&&entity[tf.key]) return String(entity[tf.key]).slice(0,200);
  return '';
}
function _sortEntities(list,field,dir) {
  if (!field) return list;
  const desc=dir==='desc';
  return [...list].sort((a,b)=>{
    const va=a[field]??'', vb=b[field]??'';
    if (va<vb) return desc?1:-1;
    if (va>vb) return desc?-1:1;
    return 0;
  });
}
function _filterEntities(list,q) {
  if (!q) return list;
  const lq=q.toLowerCase();
  return list.filter(e=>
    Object.values(e)
      .map(v=>typeof v==='string'?v:typeof v==='number'?String(v):'')
      .join(' ').toLowerCase().includes(lq)
  );
}

// ── View renderers ────────────────────────────────────────────────
function _renderList(items,config) {
  if (!items.length) return '';
  return `<div class="etv-list">${items.map(e=>{
    const title=_esc(_getTitle(e,config));
    const fields=_getKeyFields(e,config,3);
    const tags=_getTags(e);
    const meta=fields.map(f=>`<span class="etv-list-field">${_esc(f.label)}: <strong style="color:var(--color-text)">${_esc(f.value)}</strong></span>`).join('');
    const tHtml=tags.map(t=>`<span class="etv-tag">${_esc(t)}</span>`).join('');
    const upd=e.updatedAt?`<span class="etv-list-date">${_fmtDate(e.updatedAt.toString().slice(0,10))}</span>`:'';
    return `<div class="etv-list-item" data-entity-id="${_esc(e.id)}">
      <div class="etv-list-icon">${_esc(config.icon||'📎')}</div>
      <div class="etv-list-content">
        <div class="etv-list-title">${title||'(Untitled)'}</div>
        ${(meta||tHtml)?`<div class="etv-list-meta">${meta}${tHtml}</div>`:''}
      </div>${upd}
    </div>`;
  }).join('')}</div>`;
}

function _renderGrid(items,config) {
  if (!items.length) return '';
  return `<div class="etv-grid">${items.map(e=>{
    const title=_esc(_getTitle(e,config));
    const fields=_getKeyFields(e,config,2);
    const tags=_getTags(e);
    const fHtml=fields.map(f=>`<div class="etv-grid-field"><span style="color:var(--color-text-muted)">${_esc(f.label)}:</span> ${_esc(f.value)}</div>`).join('');
    const tHtml=tags.length?`<div class="etv-grid-tags">${tags.map(t=>`<span class="etv-tag">${_esc(t)}</span>`).join('')}</div>`:'';
    return `<div class="etv-grid-card" data-entity-id="${_esc(e.id)}">
      <div class="etv-grid-icon">${_esc(config.icon||'📎')}</div>
      <div class="etv-grid-title">${title||'(Untitled)'}</div>
      ${fHtml?`<div class="etv-grid-fields">${fHtml}</div>`:''}${tHtml}
    </div>`;
  }).join('')}</div>`;
}

function _renderTable(items,config,sortCol,sortDir) {
  if (!items.length) return '';
  const tfld=config?.fields?.find(f=>f.isTitle)||config?.fields?.[0];
  const dFlds=(config?.fields||[]).filter(f=>!f.isTitle&&!['richtext','relation','multirelation','tags','multiselect','checklist'].includes(f.type)).slice(0,6);
  const arrow=k=>k!==sortCol?'':`<span style="margin-left:3px">${sortDir==='desc'?'↓':'↑'}</span>`;
  const thCls=k=>k===sortCol?'th-sorted':'';
  const thead=`<thead><tr>
    <th data-sort-col="${_esc(tfld?.key||'title')}" class="${thCls(tfld?.key||'title')}">
      ${_esc(tfld?.label||'Title')}${arrow(tfld?.key||'title')}
    </th>
    ${dFlds.map(f=>`<th data-sort-col="${_esc(f.key)}" class="${thCls(f.key)}">${_esc(f.label||f.key)}${arrow(f.key)}</th>`).join('')}
    <th data-sort-col="updatedAt" class="${thCls('updatedAt')}">Updated${arrow('updatedAt')}</th>
    <th style="width:38px"></th>
  </tr></thead>`;
  const tbody=items.map(e=>{
    const tv=_esc(_getTitle(e,config)||'(Untitled)');
    const cells=dFlds.map(f=>{
      const d=_fmtVal(e[f.key],f);
      return `<td class="${(!e[f.key]&&e[f.key]!==0)?'etv-td-muted':''}">${_esc(d||'—')}</td>`;
    }).join('');
    const upd=e.updatedAt?_fmtDate(e.updatedAt.toString().slice(0,10)):'—';
    return `<tr data-entity-id="${_esc(e.id)}">
      <td class="etv-td-title">${tv}</td>${cells}
      <td class="etv-td-muted">${_esc(upd)}</td>
      <td style="text-align:center">
        <button class="etv-tbl-open" data-open-id="${_esc(e.id)}" title="Open">↗</button>
      </td>
    </tr>`;
  }).join('');
  return `<div class="etv-table-wrap"><table class="etv-table">${thead}<tbody>${tbody}</tbody></table></div>`;
}

function _renderWall(items,config) {
  if (!items.length) return '';
  return `<div class="etv-wall">${items.map(e=>{
    const title=_esc(_getTitle(e,config));
    const preview=_esc(_getPreview(e,config));
    const fields=_getKeyFields(e,config,3);
    const tags=_getTags(e);
    const upd=e.updatedAt?_fmtDate(e.updatedAt.toString().slice(0,10)):'';
    const propsHtml=fields.length?`<div class="etv-wall-props">${fields.map(f=>
      `<div class="etv-wall-prop"><span class="etv-wall-pk">${_esc(f.label)}:</span><span class="etv-wall-pv">${_esc(f.value)}</span></div>`
    ).join('')}</div>`:'';
    const tHtml=tags.length?`<div class="etv-wall-tags">${tags.map(t=>`<span class="etv-tag">${_esc(t)}</span>`).join('')}</div>`:'';
    return `<div class="etv-wall-card" data-entity-id="${_esc(e.id)}">
      <div class="etv-wall-hdr">
        <div class="etv-wall-icon">${_esc(config.icon||'📎')}</div>
        <div class="etv-wall-title">${title||'(Untitled)'}</div>
      </div>
      ${preview?`<div class="etv-wall-preview">${preview}</div>`:''}
      ${propsHtml}${tHtml}
      ${upd?`<div class="etv-wall-date">Updated ${_esc(upd)}</div>`:''}
    </div>`;
  }).join('')}</div>`;
}

function _renderEmpty(config,entityType,isFiltered) {
  if (isFiltered) return `<div class="etv-empty">
    <div class="etv-empty-icon">🔍</div>
    <div class="etv-empty-title">No results</div>
    <div class="etv-empty-sub">Try a different search term.</div>
  </div>`;
  const label=config?.label||entityType, plural=config?.labelPlural||label+'s', icon=config?.icon||'📎';
  return `<div class="etv-empty">
    <div class="etv-empty-icon">${_esc(icon)}</div>
    <div class="etv-empty-title">No ${_esc(plural)} yet</div>
    <div class="etv-empty-sub">Create your first ${_esc(label)} to get started.</div>
    <button class="etv-empty-btn" data-action="new">+ New ${_esc(label)}</button>
  </div>`;
}

// ── Sort popover ──────────────────────────────────────────────────
function _openSortPopover(anchorEl, config, onSort) {
  document.getElementById('etv-sort-popover')?.remove();
  const sortable=[
    {key:'updatedAt',label:'Updated'},{key:'createdAt',label:'Created'},
    ...(config?.fields||[])
      .filter(f=>!['richtext','relation','multirelation','tags'].includes(f.type))
      .map(f=>({key:f.key,label:f.label||f.key})),
  ];
  const pop=document.createElement('div');
  pop.id='etv-sort-popover'; pop.className='etv-sort-popover';
  pop.innerHTML=sortable.map(f=>`
    <div class="etv-sort-opt${_sortField===f.key?' selected':''}" data-sf="${_esc(f.key)}">
      ${_esc(f.label)}
      ${_sortField===f.key?`<span class="etv-sort-dir">${_sortDir==='desc'?'↓ Desc':'↑ Asc'}</span>`:''}
    </div>`).join('');
  anchorEl.parentElement.style.position='relative';
  anchorEl.parentElement.appendChild(pop);
  pop.addEventListener('click', e=>{
    const opt=e.target.closest('[data-sf]');
    if (!opt) return;
    const f=opt.dataset.sf;
    if (_sortField===f) { _sortDir=_sortDir==='desc'?'asc':'desc'; }
    else { _sortField=f; _sortDir='desc'; }
    pop.remove(); onSort();
  });
  setTimeout(()=>{
    document.addEventListener('click', function _cl(e){
      if (!pop.contains(e.target)&&e.target!==anchorEl){ pop.remove(); document.removeEventListener('click',_cl); }
    });
  },0);
}

// ── Main render ───────────────────────────────────────────────────
async function renderEntityTypeView(params = {}) {
  const el = document.getElementById('view-entity-type');
  if (!el) return;

  const entityType = params.entityType || 'idea';
  const mode       = params.mode || _currentMode || 'list';

  // Reset sort when switching to a different type
  if (entityType !== _currentType) {
    _sortField = null;
    _sortDir   = 'desc';
    _searchQ   = '';
  }

  _currentType = entityType;
  _currentMode = mode;

  _unsubList.forEach(fn=>fn()); _unsubList=[];

  // Get type config: registry first, graph-engine fallback
  let config;
  try { config = await getObjectTypeConfig(entityType); } catch { /* ok */ }
  if (!config) { try { config = getEntityTypeConfig(entityType); } catch { /* ok */ } }
  if (!config) {
    config = {
      label:entityType, labelPlural:entityType+'s', icon:'📎', defaultSort:'-createdAt',
      fields:[{key:'title',label:'Title',type:'text',isTitle:true}],
    };
  }

  const label       = config.label       || entityType;
  const plural      = config.labelPlural || label+'s';
  const icon        = config.icon        || '📎';
  const isCustom    = config.canDelete   === true;
  const description = config.description || '';

  // Load entities
  let raw=[];
  try {
    const allOfType = await getEntitiesByType(entityType);
    raw = filterByContext(allOfType);
  } catch { /* ok */ }
  raw = raw.filter(e=>!e.deleted);

  // Resolve sort
  let sField=_sortField, sDir=_sortDir;
  if (!sField) {
    const ds=config.defaultSort||'-createdAt';
    sDir   = ds.startsWith('-')?'desc':'asc';
    sField = ds.replace(/^-/,'');
  }

  // Reactive helpers
  const _displayed = () => _filterEntities(_sortEntities(raw,sField,sDir), _searchQ);

  function _buildBody(items) {
    if (!items.length) return _renderEmpty(config,entityType,!!_searchQ);
    switch(mode){
      case 'grid':  return _renderGrid(items,config);
      case 'table': return _renderTable(items,config,sField,sDir);
      case 'wall':  return _renderWall(items,config);
      default:      return _renderList(items,config);
    }
  }

  const items=_displayed();
  const sortLabel=sField==='updatedAt'?'Updated':sField==='createdAt'?'Created'
    :config.fields?.find(f=>f.key===sField)?.label||sField;

  const modeBtns=VIEW_MODES.map(vm=>
    `<button class="etv-mode-btn${mode===vm.key?' active':''}" data-mode="${_esc(vm.key)}" title="${_esc(vm.label)}">${_esc(vm.icon)}</button>`
  ).join('');

  // Build full HTML
  el.innerHTML=`
    <div class="etv-header">
      <div class="etv-title">
        <span>${_esc(icon)}</span><span>${_esc(plural)}</span>
        <span class="etv-count">${raw.length}</span>
      </div>
      <div class="etv-header-right">
        <div class="etv-mode-toggle" role="group">${modeBtns}</div>
        ${isCustom?`<button class="etv-icon-btn" data-action="settings" title="Type settings">⚙</button>`:''}
        <button class="etv-new-btn" data-action="new">+ New ${_esc(label)}</button>
      </div>
    </div>
    ${description?`<div class="etv-desc-banner"><span>ℹ</span><span>${_esc(description)}</span></div>`:''}
    <div class="etv-toolbar">
      <div class="etv-search-wrap">
        <input class="etv-search" id="etv-search" type="search"
               placeholder="Search ${_esc(plural.toLowerCase())}…" value="${_esc(_searchQ)}">
      </div>
      <button class="etv-sort-btn${_sortField?' active':''}" id="etv-sort-btn">
        ↕ ${_esc(sortLabel)} ${sDir==='desc'?'↓':'↑'}
      </button>
      <span class="etv-count-lbl" id="etv-count-lbl">${items.length} of ${raw.length}</span>
    </div>
    <div class="etv-body" id="etv-body">${_buildBody(items)}</div>
  `;

  // ── Body content refresh helper ───────────────────────────────
  function _refreshBody() {
    const newItems=_displayed();
    document.getElementById('etv-body').innerHTML=_buildBody(newItems);
    document.getElementById('etv-count-lbl').textContent=`${newItems.length} of ${raw.length}`;
  }

  // ── Single delegated click listener on `el` ───────────────────
  // Handles ALL body interactions: entity open, table sort, empty-state btn,
  // view-mode switch, new-entity btn, settings btn.
  // Lives on the stable container — never accumulates on search/filter.
  el.addEventListener('click', e => {
    // View mode switch
    const modeBtn=e.target.closest('[data-mode]');
    if (modeBtn?.closest('.etv-mode-toggle')) {
      navigate('entity-type',{entityType,mode:modeBtn.dataset.mode},undefined,true);
      return;
    }
    // New entity (header btn + empty-state btn)
    if (e.target.closest('[data-action="new"]')) { openForm(entityType); return; }
    // Settings (custom types only)
    if (e.target.closest('[data-action="settings"]')) {
      openTypeEditor(entityType, ()=>renderEntityTypeView({entityType,mode,_force:true}));
      return;
    }
    // Table open button
    const openBtn=e.target.closest('[data-open-id]');
    if (openBtn) { emit(EVENTS.PANEL_OPENED,{entityId:openBtn.dataset.openId}); return; }
    // Table column sort (click on <th>)
    const th=e.target.closest('[data-sort-col]');
    if (th&&th.closest('.etv-table')) {
      const col=th.dataset.sortCol;
      if (_sortField===col) { _sortDir=_sortDir==='desc'?'asc':'desc'; }
      else { _sortField=col; _sortDir='desc'; }
      sField=_sortField; sDir=_sortDir;
      renderEntityTypeView({entityType,mode});
      return;
    }
    // Entity card/row
    const item=e.target.closest('[data-entity-id]');
    if (item) { emit(EVENTS.PANEL_OPENED,{entityId:item.dataset.entityId}); return; }
  });

  // ── Search ───────────────────────────────────────────────────
  el.querySelector('#etv-search').addEventListener('input', e=>{
    _searchQ=e.target.value;
    _refreshBody();
  });

  // ── Sort popover ─────────────────────────────────────────────
  el.querySelector('#etv-sort-btn').addEventListener('click', ()=>{
    const sb=el.querySelector('#etv-sort-btn');
    _openSortPopover(sb, config, ()=>renderEntityTypeView({entityType,mode}));
  });

  // ── Event subscriptions ───────────────────────────────────────
  _unsubList.push(on(EVENTS.ENTITY_SAVED, ({entity}={})=>{
    if (entity?.type===_currentType) renderEntityTypeView({entityType:_currentType,mode:_currentMode,_force:true});
  }));
  _unsubList.push(on(EVENTS.ENTITY_DELETED, ({entity}={})=>{
    // Refresh when an entity of the current type is deleted so the list updates immediately
    if (!entity || entity.type===_currentType) renderEntityTypeView({entityType:_currentType,mode:_currentMode,_force:true});
  }));
  _unsubList.push(on(EVENTS.TYPE_CREATED, ({typeKey}={})=>{
    if (typeKey===_currentType) renderEntityTypeView({entityType:_currentType,mode:_currentMode,_force:true});
  }));
  _unsubList.push(on('context:changed', ()=>{
    if (_currentType) renderEntityTypeView({entityType:_currentType,mode:_currentMode,_force:true});
  }));
}

registerView('entity-type', renderEntityTypeView);
