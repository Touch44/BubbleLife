/**
 * FamilyHub v4.7.0 — views/messages.js
 * [MAJOR] M-01 — Direct Family Messaging
 *
 * Two-panel layout: inbox (conversation list) + thread (message bubbles).
 * Entity types: 'conversation', 'message'
 * Edges: person→conversation (participates-in), message→conversation (belongs-to)
 *
 * Privacy model (Phase 1): client-side filtering on participantIds.
 * Read receipts: _silentMarkRead() — guarded by _markingRead flag to
 *   prevent ENTITY_SAVED re-render cascade.
 * Unread count: denormalized on conversation.unreadCounts[personId].
 */

import { registerView, navigate, VIEW_KEYS }    from '../core/router.js';
import { getEntitiesByType, getEntity,
         saveEntity, saveEdge,
         getEdgesFrom, getEdgesTo, uid }         from '../core/db.js';
import { on, EVENTS }                            from '../core/events.js';
import { getAccount }                            from '../core/auth.js';
import { toast }                                 from '../core/toast.js';

// ── Module state ──────────────────────────────────────────────

let _activeConvoId = null;
let _persons       = [];
let _personMap     = new Map();
let _markingRead   = false;   // guard: prevents ENTITY_SAVED re-render cascade during markRead

// ── Helpers ───────────────────────────────────────────────────

function _esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000)     return 'just now';
  if (diff < 3600000)   return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000)  return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
  return new Date(iso).toLocaleDateString();
}

function _localDateStr(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function _formatDateLabel(iso) {
  const str   = _localDateStr(iso);
  const today = _localDateStr(new Date().toISOString());
  const yest  = _localDateStr(new Date(Date.now() - 86400000).toISOString());
  if (str === today) return 'Today';
  if (str === yest)  return 'Yesterday';
  return new Date(iso).toLocaleDateString(undefined, { weekday:'long', month:'short', day:'numeric' });
}

function _convoName(convo, selfPersonId) {
  if (convo.title) return convo.title;
  const others = (convo.participantIds || [])
    .filter(id => id !== selfPersonId)
    .map(id => _personMap.get(id)?.name || _personMap.get(id)?.title || 'Unknown');
  return others.length ? others.join(', ') : 'Conversation';
}

function _initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length-1][0]).toUpperCase()
    : (parts[0][0] || '?').toUpperCase();
}

async function _loadMyConversations(personId) {
  const edges  = await getEdgesFrom(personId, 'participates-in');
  const convos = (await Promise.all(edges.map(e => getEntity(e.toId)))).filter(Boolean);
  return convos.sort((a, b) => {
    const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    return tb - ta;
  });
}

async function _loadMessages(convoId) {
  const edges    = await getEdgesTo(convoId, 'belongs-to');
  const messages = (await Promise.all(edges.map(e => getEntity(e.fromId)))).filter(Boolean);
  return messages.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

async function _updateNavBadge() {
  const acct  = getAccount();
  const badge = document.getElementById('messages-nav-badge');
  if (!badge || !acct?.memberId) return;
  try {
    const convos = await _loadMyConversations(acct.memberId);
    const total  = convos.reduce((s, c) => s + (c.unreadCounts?.[acct.memberId] ?? 0), 0);
    badge.textContent    = total > 99 ? '99+' : String(total || '');
    badge.style.display  = total > 0 ? '' : 'none';
    badge.setAttribute('aria-label',
      total > 0 ? `${total} unread message${total !== 1 ? 's' : ''}` : 'no unread messages');
  } catch (e) {
    console.warn('[messages] badge update failed:', e);
  }
}

/**
 * Mark unread messages as read.
 * Guarded by _markingRead to prevent ENTITY_SAVED re-render cascade:
 *   saveEntity(message) → ENTITY_SAVED → listener → _renderThread →
 *   _silentMarkRead again → _markingRead === true → returns immediately
 */
async function _silentMarkRead(messages, myPersonId, convoId) {
  if (!myPersonId || _markingRead) return;
  const unread = messages.filter(m =>
    m.fromPersonId !== myPersonId && !(m.readBy || []).includes(myPersonId)
  );
  if (!unread.length) return;

  _markingRead = true;
  try {
    // Clear the unread counter on the conversation (syncs to MySQL)
    const convo = await getEntity(convoId);
    if (convo) {
      const counts = { ...(convo.unreadCounts || {}) };
      counts[myPersonId] = 0;
      await saveEntity({ ...convo, unreadCounts: counts });
    }
    // Update readBy on individual messages (≤5 only — avoid audit storm)
    if (unread.length <= 5) {
      const now = new Date().toISOString();
      for (const msg of unread) {
        await saveEntity({ ...msg, readBy: [...(msg.readBy || []), myPersonId], updatedAt: now });
      }
    }
  } catch (e) {
    console.warn('[messages] markRead failed:', e);
  } finally {
    _markingRead = false;
  }
}

function _openMsgPhoto(src) {
  const ov  = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
  const img = document.createElement('img');
  img.src              = src;
  img.style.cssText    = 'max-width:90vw;max-height:90vh;border-radius:var(--radius-md);';
  img.alt              = 'Photo message';
  ov.appendChild(img);
  ov.addEventListener('click', () => ov.remove());
  document.body.appendChild(ov);
}

// ── CSS injection ─────────────────────────────────────────────

function _injectStyles() {
  if (document.getElementById('messages-styles')) return;
  const s = document.createElement('style');
  s.id = 'messages-styles';
  s.textContent = `
    #view-messages.active {
      display: flex !important;
      flex-direction: column;
      height: 100%;
      padding: 0;
      overflow: hidden;
    }
    .msg-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: var(--space-4) var(--space-6);
      border-bottom: 1px solid var(--color-border);
      flex-shrink: 0; background: var(--color-surface);
    }
    .msg-header h1 { font-size: var(--text-lg); font-weight: var(--weight-semibold); margin: 0; }
    .msg-layout { display: flex; flex: 1; overflow: hidden; }
    .msg-inbox {
      width: 280px; flex-shrink: 0;
      border-right: 1px solid var(--color-border);
      overflow-y: auto; display: flex; flex-direction: column;
    }
    .msg-inbox-row {
      display: flex; align-items: flex-start; gap: var(--space-3);
      padding: var(--space-3) var(--space-4); cursor: pointer;
      border-bottom: 1px solid var(--color-border);
      transition: background var(--transition-fast);
    }
    .msg-inbox-row:hover  { background: var(--color-surface-2); }
    .msg-inbox-row.active { background: var(--color-surface-2); outline: 2px solid var(--color-accent); outline-offset: -2px; }
    .msg-inbox-row.unread .msg-inbox-name { font-weight: var(--weight-semibold); }
    .msg-avatar {
      width: 36px; height: 36px; border-radius: var(--radius-full);
      background: var(--color-accent); color: var(--color-on-accent, #fff);
      display: flex; align-items: center; justify-content: center;
      font-size: var(--text-xs); font-weight: var(--weight-bold); flex-shrink: 0;
    }
    .msg-inbox-meta { flex: 1; min-width: 0; }
    .msg-inbox-name    { font-size: var(--text-sm); color: var(--color-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .msg-inbox-snippet { font-size: var(--text-xs); color: var(--color-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
    .msg-inbox-time    { font-size: 10px; color: var(--color-text-muted); white-space: nowrap; }
    .msg-inbox-badge {
      min-width: 18px; height: 18px; background: var(--color-accent);
      color: var(--color-on-accent, #fff); border-radius: var(--radius-full);
      font-size: 10px; font-weight: var(--weight-bold);
      display: flex; align-items: center; justify-content: center;
      padding: 0 4px; flex-shrink: 0;
    }
    .msg-thread {
      flex: 1; display: flex; flex-direction: column;
      overflow: hidden; background: var(--color-bg);
    }
    .msg-thread-header {
      display: flex; align-items: center; gap: var(--space-3);
      padding: var(--space-3) var(--space-4);
      border-bottom: 1px solid var(--color-border);
      flex-shrink: 0; background: var(--color-surface);
    }
    .msg-thread-back {
      display: none; background: none; border: none; cursor: pointer;
      font-size: var(--text-lg); padding: 0 var(--space-2) 0 0;
      color: var(--color-accent);
    }
    .msg-thread-name { font-size: var(--text-base); font-weight: var(--weight-semibold); flex: 1; }
    .msg-thread-body {
      flex: 1; overflow-y: auto; padding: var(--space-4);
      display: flex; flex-direction: column; gap: var(--space-2);
    }
    .msg-date-divider { text-align: center; font-size: var(--text-xs); color: var(--color-text-muted); margin: var(--space-2) 0; }
    .msg-row { display: flex; align-items: flex-end; gap: var(--space-2); }
    .msg-row.sent     { flex-direction: row-reverse; }
    .msg-row.received { flex-direction: row; }
    .msg-bubble {
      max-width: 72%; border-radius: var(--radius-lg);
      padding: var(--space-2) var(--space-3);
      font-size: var(--text-sm); line-height: 1.45; word-break: break-word;
    }
    .msg-bubble.sent     { background: var(--color-accent); color: var(--color-on-accent, #fff); border-bottom-right-radius: 4px; }
    .msg-bubble.received { background: var(--color-surface-2); color: var(--color-text); border-bottom-left-radius: 4px; }
    .msg-bubble img { max-width: 220px; border-radius: var(--radius-sm); cursor: zoom-in; display: block; margin-top: var(--space-1); }
    .msg-time { font-size: 10px; color: var(--color-text-muted); flex-shrink: 0; }
    .msg-empty {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: var(--space-4); color: var(--color-text-muted); font-size: var(--text-sm);
    }
    .msg-empty-icon { font-size: 3rem; }
    .msg-compose {
      display: flex; align-items: flex-end; gap: var(--space-2);
      padding: var(--space-3) var(--space-4);
      border-top: 1px solid var(--color-border);
      background: var(--color-surface); flex-shrink: 0;
    }
    .msg-compose-input {
      flex: 1; resize: none;
      border: 1px solid var(--color-border); border-radius: var(--radius-md);
      padding: var(--space-2) var(--space-3);
      font-size: var(--text-sm); font-family: var(--font-body);
      background: var(--color-bg); color: var(--color-text);
      max-height: 120px; min-height: 38px;
    }
    .msg-compose-input:focus { outline: 2px solid var(--color-accent); }
    .msg-send-btn {
      width: 36px; height: 36px; border-radius: var(--radius-full);
      background: var(--color-accent); color: var(--color-on-accent, #fff);
      border: none; cursor: pointer; font-size: var(--text-base);
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; transition: opacity var(--transition-fast);
    }
    .msg-send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .msg-photo-btn {
      width: 36px; height: 36px; border-radius: var(--radius-full);
      background: var(--color-surface-2); border: 1px solid var(--color-border);
      cursor: pointer; font-size: var(--text-base);
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .msg-modal-backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,.4);
      z-index: 1000; display: flex; align-items: center; justify-content: center;
    }
    .msg-modal {
      background: var(--color-surface); border-radius: var(--radius-lg);
      padding: var(--space-6); width: min(400px, 90vw);
      display: flex; flex-direction: column; gap: var(--space-4);
      box-shadow: var(--shadow-xl, 0 20px 60px rgba(0,0,0,.3));
    }
    .msg-modal h2 { margin: 0; font-size: var(--text-base); font-weight: var(--weight-semibold); }
    .msg-person-list { display: flex; flex-direction: column; gap: var(--space-1); max-height: 200px; overflow-y: auto; }
    .msg-person-item {
      display: flex; align-items: center; gap: var(--space-3);
      padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm);
      cursor: pointer; transition: background var(--transition-fast);
    }
    .msg-person-item:hover    { background: var(--color-surface-2); }
    .msg-person-item.selected { background: var(--color-surface-2); outline: 2px solid var(--color-accent); outline-offset: -2px; }
    .msg-group-name { border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-2) var(--space-3); font-size: var(--text-sm); font-family: var(--font-body); background: var(--color-bg); color: var(--color-text); width: 100%; box-sizing: border-box; }
    .msg-group-name:focus { outline: 2px solid var(--color-accent); }
    .msg-modal-actions { display: flex; gap: var(--space-2); justify-content: flex-end; }
    @media (max-width: 640px) {
      .msg-inbox  { width: 100%; border-right: none; }
      .msg-thread { display: none; }
      .msg-thread-back { display: block; }
      #view-messages.active.msg-thread-open .msg-inbox  { display: none; }
      #view-messages.active.msg-thread-open .msg-thread { display: flex; }
    }
  `;
  document.head.appendChild(s);
}

// ── Inbox ─────────────────────────────────────────────────────

function _renderInbox(inboxEl, convos, acct) {
  inboxEl.innerHTML = '';
  if (!convos.length) {
    const d = document.createElement('div');
    d.className = 'msg-empty';
    d.innerHTML = `<div class="msg-empty-icon">💬</div>
      <div>No conversations yet</div>
      <div style="font-size:var(--text-xs)">Start one with the ✏️ button</div>`;
    inboxEl.appendChild(d);
    return;
  }
  for (const convo of convos) {
    const myUnread = convo.unreadCounts?.[acct.memberId] ?? 0;
    const name     = _convoName(convo, acct.memberId);
    const row = document.createElement('div');
    row.className = 'msg-inbox-row' + (myUnread > 0 ? ' unread' : '') + (convo.id === _activeConvoId ? ' active' : '');
    row.dataset.convoId = convo.id;
    row.innerHTML = `
      <div class="msg-avatar">${_esc(_initials(name))}</div>
      <div class="msg-inbox-meta">
        <div class="msg-inbox-name">${_esc(name)}</div>
        <div class="msg-inbox-snippet">${_esc((convo.lastMessageSnippet || '').slice(0,60) || 'No messages yet')}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex-shrink:0;">
        <span class="msg-inbox-time">${_timeAgo(convo.lastMessageAt)}</span>
        ${myUnread > 0 ? `<span class="msg-inbox-badge">${myUnread > 99 ? '99+' : myUnread}</span>` : ''}
      </div>`;
    row.addEventListener('click', () => _openConversation(convo.id));
    inboxEl.appendChild(row);
  }
}

// ── Thread ────────────────────────────────────────────────────

async function _renderThread(threadEl, convoId, acct) {
  threadEl.innerHTML = '';
  const convo = await getEntity(convoId);
  if (!convo) {
    threadEl.innerHTML = '<div class="msg-empty"><div>Conversation not found.</div></div>';
    return;
  }
  const messages = await _loadMessages(convoId);
  const name     = _convoName(convo, acct.memberId);

  const hdr = document.createElement('div');
  hdr.className = 'msg-thread-header';
  const backBtn = document.createElement('button');
  backBtn.className = 'msg-thread-back';
  backBtn.setAttribute('aria-label', 'Back to inbox');
  backBtn.textContent = '‹';
  backBtn.addEventListener('click', () => {
    document.getElementById('view-messages')?.classList.remove('msg-thread-open');
    _activeConvoId = null;
  });
  const av = document.createElement('div');
  av.className = 'msg-avatar';
  av.style.flexShrink = '0';
  av.textContent = _initials(name);
  const nm = document.createElement('span');
  nm.className   = 'msg-thread-name';
  nm.textContent = name;
  hdr.appendChild(backBtn);
  hdr.appendChild(av);
  hdr.appendChild(nm);
  threadEl.appendChild(hdr);

  const body = document.createElement('div');
  body.className = 'msg-thread-body';

  if (!messages.length) {
    const e = document.createElement('div');
    e.className = 'msg-empty';
    e.style.flex = '1';
    e.innerHTML = '<div class="msg-empty-icon">✉️</div><div>No messages yet — say hello!</div>';
    body.appendChild(e);
  } else {
    let lastDateStr = '';
    for (const msg of messages) {
      const msgDate = _localDateStr(msg.createdAt);
      if (msgDate !== lastDateStr) {
        const div = document.createElement('div');
        div.className   = 'msg-date-divider';
        div.textContent = _formatDateLabel(msg.createdAt);
        body.appendChild(div);
        lastDateStr = msgDate;
      }
      const isSent = msg.fromPersonId === acct.memberId;
      const row    = document.createElement('div');
      row.className = 'msg-row ' + (isSent ? 'sent' : 'received');
      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble ' + (isSent ? 'sent' : 'received');
      if (msg.postType === 'Photo' && msg.photoUrl) {
        if (msg.body) { const t = document.createElement('div'); t.textContent = msg.body; bubble.appendChild(t); }
        const img = document.createElement('img');
        img.src     = msg.photoUrl;
        img.alt     = 'Photo message';
        img.loading = 'lazy';
        img.addEventListener('click', () => _openMsgPhoto(msg.photoUrl));
        bubble.appendChild(img);
      } else {
        bubble.textContent = msg.body || '';
      }
      const time = document.createElement('span');
      time.className   = 'msg-time';
      time.title       = msg.createdAt ? new Date(msg.createdAt).toLocaleString() : '';
      time.textContent = _timeAgo(msg.createdAt);
      if (isSent) { row.appendChild(time); row.appendChild(bubble); }
      else        { row.appendChild(bubble); row.appendChild(time); }
      body.appendChild(row);
    }
  }
  threadEl.appendChild(body);
  threadEl.appendChild(_buildComposeBar(convoId, acct));
  requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
  _silentMarkRead(messages, acct.memberId, convoId).then(_updateNavBadge);
}

// ── Compose bar ───────────────────────────────────────────────

function _buildComposeBar(convoId, acct) {
  const bar = document.createElement('div');
  bar.className = 'msg-compose';

  const fileInput = document.createElement('input');
  fileInput.type   = 'file';
  fileInput.accept = 'image/*';
  fileInput.style.display = 'none';

  const photoBtn = document.createElement('button');
  photoBtn.className   = 'msg-photo-btn';
  photoBtn.type        = 'button';
  photoBtn.textContent = '📷';
  photoBtn.title       = 'Send a photo';

  const ta = document.createElement('textarea');
  ta.className   = 'msg-compose-input';
  ta.placeholder = 'Write a message…';
  ta.rows        = 1;
  ta.setAttribute('aria-label', 'Message input');
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    sendBtn.disabled = !ta.value.trim() && !_pendingPhotoUrl;
  });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!sendBtn.disabled) sendBtn.click(); }
  });

  const sendBtn = document.createElement('button');
  sendBtn.className   = 'msg-send-btn';
  sendBtn.type        = 'button';
  sendBtn.textContent = '▶';
  sendBtn.title       = 'Send';
  sendBtn.disabled    = true;

  let _pendingPhotoUrl = null;
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      _pendingPhotoUrl     = ev.target.result;
      photoBtn.textContent = '🖼️';
      photoBtn.title       = 'Photo ready — click Send';
      sendBtn.disabled     = false;
    };
    reader.readAsDataURL(file);
  });
  photoBtn.addEventListener('click', () => fileInput.click());

  sendBtn.addEventListener('click', async () => {
    const body = ta.value.trim();
    if (!body && !_pendingPhotoUrl) return;
    sendBtn.disabled = true;
    try {
      const msgId = uid();
      const now   = new Date().toISOString();
      await saveEntity({
        id:             msgId,
        type:           'message',
        conversationId: convoId,
        body,
        postType:       _pendingPhotoUrl ? 'Photo' : 'Text',
        photoUrl:       _pendingPhotoUrl || null,
        fromPersonId:   acct.memberId,
        readBy:         acct.memberId ? [acct.memberId] : [],
      }, acct.id);

      await saveEdge({ fromId: msgId, toId: convoId, relation: 'belongs-to' }, acct.id);

      // Denormalize onto conversation
      const fresh  = await getEntity(convoId);
      const snippet = body ? body.slice(0,80) : '📷 Photo';
      const counts  = { ...(fresh?.unreadCounts || {}) };
      (fresh?.participantIds || []).forEach(pid => {
        if (pid !== acct.memberId) counts[pid] = (counts[pid] || 0) + 1;
      });
      await saveEntity({ ...fresh, lastMessageAt: now, lastMessageSnippet: snippet, unreadCounts: counts });

      ta.value = ''; ta.style.height = '';
      sendBtn.disabled     = true;
      _pendingPhotoUrl     = null;
      photoBtn.textContent = '📷';
      photoBtn.title       = 'Send a photo';

      // Re-render thread (ENTITY_SAVED listener will fire but _markingRead guards re-entry)
      const viewEl   = document.getElementById('view-messages');
      const threadEl = viewEl?.querySelector('.msg-thread');
      if (threadEl) await _renderThread(threadEl, convoId, acct);

    } catch (err) {
      console.error('[messages] send failed:', err);
      toast.error('Could not send — please try again.');
      sendBtn.disabled = false;
    }
  });

  bar.appendChild(fileInput);
  bar.appendChild(photoBtn);
  bar.appendChild(ta);
  bar.appendChild(sendBtn);
  return bar;
}

// ── Open conversation ─────────────────────────────────────────

async function _openConversation(convoId) {
  _activeConvoId   = convoId;
  const acct       = getAccount();
  const viewEl     = document.getElementById('view-messages');
  const threadEl   = viewEl?.querySelector('.msg-thread');
  const inboxEl    = viewEl?.querySelector('.msg-inbox');
  if (!threadEl || !acct) return;

  viewEl.classList.add('msg-thread-open');
  inboxEl?.querySelectorAll('.msg-inbox-row').forEach(r => {
    r.classList.toggle('active', r.dataset.convoId === convoId);
  });
  await _renderThread(threadEl, convoId, acct);
  _updateNavBadge();
}

// ── New conversation modal ────────────────────────────────────

function _openNewConvoModal(acct, preselectedPersonId = null) {
  const others = _persons.filter(p => p.id !== acct.memberId);
  if (!others.length) {
    toast.info('No other family members found. Invite members in Settings.');
    return;
  }
  const backdrop = document.createElement('div');
  backdrop.className = 'msg-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'msg-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'New conversation');

  const h2 = document.createElement('h2');
  h2.textContent = 'New Conversation';

  const nameInput = document.createElement('input');
  nameInput.type        = 'text';
  nameInput.className   = 'msg-group-name';
  nameInput.placeholder = 'Group name (optional for 2+ people)';
  nameInput.setAttribute('aria-label', 'Conversation name');

  const personList = document.createElement('div');
  personList.className = 'msg-person-list';

  const checks = new Map();
  for (const person of others) {
    const item = document.createElement('div');
    item.className = 'msg-person-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.id = 'msgp-' + person.id;
    cb.setAttribute('aria-label', person.name || person.title || 'Unknown');
    const lbl = document.createElement('label');
    lbl.htmlFor = cb.id;
    lbl.style.cssText = 'display:flex;align-items:center;gap:var(--space-2);cursor:pointer;flex:1;';
    const av = document.createElement('div');
    av.className = 'msg-avatar';
    av.style.cssText = 'width:28px;height:28px;font-size:10px;flex-shrink:0;';
    av.textContent = _initials(person.name || person.title || '?');
    const nm = document.createElement('span');
    nm.style.fontSize = 'var(--text-sm)';
    nm.textContent    = person.name || person.title || 'Unknown';
    lbl.appendChild(av); lbl.appendChild(nm);
    item.appendChild(cb); item.appendChild(lbl);
    item.addEventListener('click', e => {
      if (e.target !== cb) { cb.checked = !cb.checked; }
      item.classList.toggle('selected', cb.checked);
    });
    personList.appendChild(item);
    checks.set(person.id, cb);
  }

  // Pre-select person if navigated from wall Message button
  if (preselectedPersonId && checks.has(preselectedPersonId)) {
    const cb = checks.get(preselectedPersonId);
    cb.checked = true;
    cb.closest('.msg-person-item')?.classList.add('selected');
  }

  const actions = document.createElement('div');
  actions.className = 'msg-modal-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className   = 'btn btn-ghost';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.type        = 'button';
  cancelBtn.addEventListener('click', () => backdrop.remove());

  const createBtn = document.createElement('button');
  createBtn.className   = 'btn btn-primary';
  createBtn.textContent = 'Start Conversation';
  createBtn.type        = 'button';
  createBtn.addEventListener('click', async () => {
    const selected = [...checks.entries()].filter(([, cb]) => cb.checked).map(([id]) => id);
    if (!selected.length) { toast.info('Select at least one person.'); return; }
    createBtn.disabled = true;
    try {
      const participantIds = acct.memberId ? [acct.memberId, ...selected] : selected;
      const convoId        = uid();
      const title          = nameInput.value.trim() || null;
      await saveEntity({
        id: convoId, type: 'conversation',
        title, participantIds,
        lastMessageAt: null, lastMessageSnippet: null, unreadCounts: {},
      }, acct.id);
      for (const pid of participantIds) {
        await saveEdge({ fromId: pid, toId: convoId, relation: 'participates-in' }, acct.id);
      }
      backdrop.remove();
      await _openConversation(convoId);
      // Inbox refreshed automatically via ENTITY_SAVED listener from saveEntity(convo)
    } catch (err) {
      console.error('[messages] create convo failed:', err);
      toast.error('Could not create conversation.');
      createBtn.disabled = false;
    }
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(createBtn);
  modal.appendChild(h2);
  modal.appendChild(nameInput);
  modal.appendChild(personList);
  modal.appendChild(actions);
  backdrop.appendChild(modal);                 // single append — no double-append bug
  backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => personList.querySelector('input[type=checkbox]')?.focus());
}

// ── Main render ───────────────────────────────────────────────

export async function renderMessages(params = {}) {
  _injectStyles();
  const el = document.getElementById('view-messages');
  if (!el) return;
  el.innerHTML = '';

  const acct = getAccount();
  if (!acct) {
    el.innerHTML = '<div style="padding:var(--space-8);color:var(--color-text-muted)">Please log in.</div>';
    return;
  }

  _persons   = await getEntitiesByType('person');
  _personMap = new Map(_persons.map(p => [p.id, p]));

  const hdr = document.createElement('div');
  hdr.className = 'msg-header';
  const h1 = document.createElement('h1');
  h1.textContent = '💬 Messages';
  const newBtn = document.createElement('button');
  newBtn.className   = 'btn btn-primary';
  newBtn.textContent = '✏️ New';
  newBtn.title       = 'Start a new conversation';
  newBtn.type        = 'button';
  newBtn.addEventListener('click', () => _openNewConvoModal(acct));
  hdr.appendChild(h1);
  hdr.appendChild(newBtn);
  el.appendChild(hdr);

  const layout   = document.createElement('div');
  layout.className = 'msg-layout';
  const inboxEl  = document.createElement('div');
  inboxEl.className = 'msg-inbox';
  const threadEl = document.createElement('div');
  threadEl.className = 'msg-thread';
  const emptyState = document.createElement('div');
  emptyState.className = 'msg-empty';
  emptyState.innerHTML = '<div class="msg-empty-icon">💬</div><div>Select a conversation</div>';
  threadEl.appendChild(emptyState);
  layout.appendChild(inboxEl);
  layout.appendChild(threadEl);
  el.appendChild(layout);

  if (acct.memberId) {
    const convos = await _loadMyConversations(acct.memberId);
    _renderInbox(inboxEl, convos, acct);
    if (params.conversationId) {
      // Deep-link: open a specific conversation (from Daily Review, dashboard, wall button)
      await _openConversation(params.conversationId);
    } else if (params.targetPersonId) {
      // From wall 'Message' button when no existing 1:1 — pre-open new convo modal
      // Find or pre-select the target person
      const target = _personMap.get(params.targetPersonId);
      if (target) {
        _openNewConvoModal(acct, params.targetPersonId);
      } else {
        _openNewConvoModal(acct);
      }
    }
  } else {
    inboxEl.innerHTML = '<div class="msg-empty"><div>Your account needs a member profile to use Messages.</div></div>';
  }
}

// ── Module-level event listeners (module load — once only) ────

on(EVENTS.ENTITY_SAVED, ({ entity } = {}) => {
  if (entity?.type !== 'message' && entity?.type !== 'conversation') return;
  if (_markingRead) return;   // guard: skip cascades from _silentMarkRead

  _updateNavBadge();

  const viewEl = document.getElementById('view-messages');
  if (!viewEl?.classList.contains('active')) return;

  const acct = getAccount();
  if (!acct?.memberId) return;

  _loadMyConversations(acct.memberId).then(convos => {
    const inboxEl = viewEl.querySelector('.msg-inbox');
    if (inboxEl) _renderInbox(inboxEl, convos, acct);
  });

  if (entity.type === 'message' && entity.conversationId === _activeConvoId) {
    // Skip re-render for own sent messages — send handler already re-rendered,
    // and re-rendering here would destroy compose bar and lose in-progress text
    if (entity.fromPersonId === acct.memberId) return;
    const threadEl = viewEl.querySelector('.msg-thread');
    if (threadEl) _renderThread(threadEl, _activeConvoId, acct);
  }
});

on('messages:open-new', () => {
  const acct = getAccount();
  if (!acct) return;
  navigate(VIEW_KEYS.MESSAGES);
  setTimeout(() => _openNewConvoModal(acct), 150);
});

on(EVENTS.AUTH_LOGIN, _updateNavBadge);

// ── Register ──────────────────────────────────────────────────

registerView(VIEW_KEYS.MESSAGES, renderMessages);
export { renderMessages as default };