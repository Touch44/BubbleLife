# FamilyHub Changelog

---

## v5.2.0-bugfix2 — 2026-05-16

### Reminders Tab (New)
- **New dedicated Reminders tab** (Tab 4 — 🔔) added to all entity forms
- Reminder section moved out of Connections tab into its own Reminders tab
- Reminders tab accessible in both create and edit mode
  - Create mode: shows "Save first to add reminders" + Save Now button
  - Edit mode: full reminder management (chips, quick-add, sorted ascending)
- Reminders sorted ascending by nextFireAt (earliest first)
- Empty state shown when no reminders set

### Connections Tab
- Reminder entities and  edges removed from Connections list (now exclusively in Reminders tab)
- Create mode: shows "Save first to add connections" + Save Now button
- Action toolbar, relation picker, and entity connections remain

### Activity Tab
- Create mode: shows "Activity is tracked after saving" + Save Now button

### Tabs — All Modes
- **All four tabs now accessible during entity creation** (tabs 2-4 were not clickable in create mode)
- Each tab shows an appropriate create-mode message when content requires a saved entity

### Reminder Management
- X button on reminder chips DELETES the reminder (not just dismisses)
  - No other entity connections → reminder fully deleted from database
  - Has other connections → only the edge to this entity is removed
- Cascade delete: when entity is deleted, orphaned reminders (only connected to that entity) are auto-deleted
- Reminders sorted by nextFireAt ascending in all views

### Reminders Page
- Clicking a reminder TITLE now opens the full entity center form for that reminder
- ✏️ button still opens the quick-edit reminder modal
- 📎 linked entity chip opens the linked entity form

### Reminder Form
- Linked entity chip clickable — opens entity center form while reminder form stays open
- Chain <details> auto-opens when editing reminder with existing chain
- Chain delay: days max 365, hours max 8760 (removed incorrect 23-hour cap)

### Reminder Analytics
- ← Reminders back button added to header
- Data covers last 90 days (prevents slow loads)
- Summary cards neutral color when no data
- Daily chart 1px baseline for zero-fire days
- Heatmap tooltip shows correct hour
- Top Reminders shows actual reminder names
- Empty state: full page message (not partial render)
- Auto-refreshes on reminder events

---

## v5.2.0-bugfix1 — 2026-05-16

### Bug Fixes (from 70-bug audit)
- ENTITY_SAVED payload now includes prevStatus (status:changed rules fire correctly)
- reminderTitle field added to reminderLog entities (analytics shows correct names)
- Heatmap tooltip uses forEach hour index not indexOf (correct hour shown)
- Chain fires when chainTitle set, even with 0 delay (min 60s enforced)
- Analytics reachable via 📊 Analytics button in reminders view
- rule type added to activity.js SKIP_TYPES (no activity feed noise)
- lastFiredAt, fireCount, reminderTitle added to SKIP_FIELDS (no Change History noise)
- rule, reminderLog, activityLog excluded from Change History audit entirely
- Unused emit import removed from auto-reminder-rules.js
- set:status loop prevention via _ruleModified flag
- Debounce map pruned when > 500 entries (prevents unbounded growth)
- Hidden entity types filtered from Convert picker and Add Connection search
- Analytics subscribes to REMINDER_* events for live refresh
- Chain <details> auto-opens on edit when chain is configured
- due:overdue fires once per entity+rule per session (_firedOnce set)
- Stale claude-nlp.js comment removed from reminder.js
- Rule exclusion list extended (activityLog, post, comment)
- Heatmap corner uses <th> not <td>
- Full empty state when no analytics data
- Chain dedup (_chainedFiring set, 5s window)
- reminderTitle fallback: l.reminderTitle || l.title.split(" — fire #")[0]
- Rules with missing actionType skipped silently
- var(--space-8) replaced with hardcoded 48px
- lastFiredAt uses local ISO format (not UTC Z-suffix)
- reminderLog filtered to last 90 days
- create:reminder dedup check before creating
- Hardcoded colors replaced with CSS variables
- Matching rules execute in parallel (Promise.all)
- Refresh button wired in analytics header
- DB error guard in analytics with recovery hint

---

## v5.2.0 — 2026-05-15

### Phase 3: Auto-Rules Engine
- New rule entity type (hidden from sidebar, managed via object studio)
- services/auto-reminder-rules.js — evaluates rules on every ENTITY_SAVED
- Triggers: entity:saved, entity:created, status:changed, due:overdue
- Actions: create:reminder, set:status, notify

### Phase 3: Chained Reminders
- chainedTo, chainDelayDays, chainDelayHours, chainTitle fields on reminder
- _fireChainedReminder() auto-fires on dismiss when chain is configured
- Zero-delay chains: minimum 60 seconds enforced

### Phase 3: Reminder Analytics View
- views/reminder-analytics.js registered as reminder-analytics
- Sections: summary cards, 30-day bar chart, top 10 reminders, snooze heatmap

---

## v5.1.0 — 2026-05-12

### Phase 2: Reminder System (Complete — all 12 features)
1. Condition evaluation engine (services/condition-eval.js)
2. Condition UI in reminder form (field/operator/value, AND/OR/NOT)
3. Push notification channel (browser Notification API)
4. Audio alert channel (AudioContext, tone selector, Test button)
5. Template library (save/apply/manage reusable reminder templates)
6. applyTemplate (apply template to matching entity types)
7. Kanban badges (🔔 count badge on task cards)
8. Calendar indicators (🔔 dot on reminder-linked dates)
9. Settings — Notifications & Reminders section
10. Quiet hours (configurable suppression window)
11. Completion tracking (reminderLog entity on every fire/snooze/dismiss)
12. Adaptive snooze (calculates recommended duration from history)

---

## v5.0.0 — 2026-04

### Phase 1: Core Architecture
- Modular ES module PWA (replacing single-file monolith)
- IndexedDB via Dexie.js (replacing localStorage)
- Service worker with full offline support
- MySQL sync via Hostinger PHP (api/sync.php)
- Graph engine: entity types, fields, relations, edges

### Tab Renames
- Tab 1: Details (was Fields)
- Tab 2: Activity (was Details)
- Tab 3: Connections (was Relations)

### Time Tracking
- Start / Pause / Continue toggle
- Block timer with alarm
- Manual Adjust (d/h/m/s)
- Reset to 0 (two-step inline confirm)
- timeTracked excluded from Change History
- Friendly duration format (5m, 1h 23m, 47s)

---

## Verification Checklist — v5.2.0-bugfix2

### Timer / Activity Tab
- [ ] Start → Pause → Continue works correctly
- [ ] Resume continues from exact paused position
- [ ] Reset: first click arms, second click zeros; auto-reverts after 5s
- [ ] Total saved shows correct value with no trailing 0s
- [ ] timeTracked does NOT appear in Change History
- [ ] timeTracked NOT visible as a raw field in Details tab
- [ ] Activity tab in create mode shows informative message

### Tabs (Create Mode)
- [ ] All 4 tabs clickable during create (no disabled state)
- [ ] Connections tab: shows save-first message
- [ ] Reminders tab: shows save-first message
- [ ] Activity tab: shows save-first message

### Connections Tab (Edit Mode)
- [ ] Action toolbar at top
- [ ] Add Connection: relation label + search + results
- [ ] Connections list shows only non-reminder entities
- [ ] Reminder entities do NOT appear in connections list
- [ ] reminds edges do NOT appear in connections list

### Reminders Tab
- [ ] 4th tab (🔔 Reminders) visible in entity form
- [ ] Chips sorted by nextFireAt ascending (earliest first)
- [ ] ✏️ chip button opens quick-edit reminder modal
- [ ] ✕ chip button: deletes reminder if no other connections; removes edge if has other connections
- [ ] Add Reminder toggles quick-set presets
- [ ] Presets (10m, 1h, Tomorrow) create reminder and show chip
- [ ] Custom… opens full reminder form

### Reminder Form
- [ ] 📎 linked entity chip is clickable and opens entity center form
- [ ] Reminder form stays open while entity form is open
- [ ] Chain section auto-opens when editing chained reminder
- [ ] Chain days max 365, hours max 8760

### Reminders Page
- [ ] Clicking reminder title opens entity CENTER FORM for reminder
- [ ] ✏️ button opens quick-edit reminder modal
- [ ] 📎 linked entity chip opens linked entity form
- [ ] 📊 Analytics button navigates to analytics
- [ ] Snooze/Done/Skip update list without full reload

### Reminder Analytics
- [ ] ← Reminders button navigates back to reminders list
- [ ] ↻ Refresh reloads data
- [ ] Summary cards: correct counts and percentages
- [ ] Cards show muted color when total is 0
- [ ] 30-day bar chart visible; zero-fire days show 1px baseline
- [ ] Top Reminders shows actual reminder names (not Untitled)
- [ ] Snooze heatmap tooltip shows correct hour
- [ ] Empty state: full-page message when no log exists

### Cascade Delete
- [ ] Delete entity → orphaned reminders auto-deleted
- [ ] Delete entity → reminders with other connections preserved

### No External Dependencies
- [ ] App works offline
- [ ] No api.anthropic.com requests in DevTools Network tab
