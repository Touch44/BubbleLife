# FamilyHub v5.1.0 — Integration Test Scenarios

> Phase 2 acceptance criteria. Run manually in-browser after deployment.
> Each scenario is pass/fail with clear expected outcome.

---

## 1. Entity Form — Tab Restructure

### 1.1 Task form tab labels
**Steps:** Open any existing Task → edit form opens
**Expected:**
- Tab 1: "📝 Fields"
- Tab 2: "📋 Activity" ← (task-specific)
- Tab 3: "🔗 Details ⏱" ← (task-specific, includes timer icon)

### 1.2 Non-task form tab labels
**Steps:** Open any Event → edit form opens
**Expected:**
- Tab 2: "📋 Details" ← (not "Activity")
- Tab 3: "🔗 Details" ← (no timer icon)

### 1.3 Action buttons in Details tab
**Steps:** Open Task → click "Details ⏱" tab
**Expected:** Archive, Duplicate, Add to Project, Convert, Delete buttons appear at the TOP of the tab, before the time-tracking widget

### 1.4 Activity tab content
**Steps:** Open Task → click "Activity" tab
**Expected:** Shows metadata (Created, Updated, ID, By) and "📋 Activity Log" — NO action buttons here

### 1.5 Mark Complete in Details tab
**Steps:** Open Task → "Details ⏱" → click "Mark Complete"
**Expected:** Task saved as Completed, button changes to "↩ Mark In Progress", status field in Fields tab updates

---

## 2. Status Field Fix

### 2.1 Valid task status options only
**Steps:** Open Task in edit form → click "Fields" tab → find "Status" dropdown
**Expected:** Only shows: Not Started, Next Up, In Progress, Completed

### 2.2 Legacy status preserved
**Steps:** Use IDB DevTools to set a task's status to "Done" (legacy) → open that task
**Expected:** Status dropdown shows "Done (legacy)" as the selected option (not blank)

---

## 3. Time Tracking — Full Flow

### 3.1 Free-run timer start/stop
**Steps:** Open Task → "Details ⏱" → click "▶ Start"
**Expected:** Large display starts counting up (MM:SS), breakdown shows d/h/m/s units, status badge shows "⏱ Running — Xs elapsed"

### 3.2 Timer continues across tab switches
**Steps:** Start timer → switch to "Fields" tab → switch back to "Details ⏱"
**Expected:** Timer is still running and time is correct

### 3.3 Pause saves to timeTracked
**Steps:** Let timer run 30s → click "⏸ Pause" → check task entity in IDB
**Expected:** Toast "Time saved ✓", task.timeTracked ≈ 30

### 3.4 Reset clears timeTracked
**Steps:** After stopping session → click "↺ Reset" → confirm dialog → check task
**Expected:** Timer returns to 00:00, task.timeTracked = 0

### 3.5 Block timer countdown
**Steps:** Open task → select "25 min (Pomodoro)" → click "▶ Start Block"
**Expected:** Block section shows countdown from 25:00, badge shows "⏲ Block — 25m remaining"

### 3.6 Block alarm fires
**Steps:** Set 5 min block → wait 5 minutes (or dev-tool shortcut)
**Expected:**
- Browser notification fires (if permission granted)
- Dashboard shows task in Timers widget with "🔔 Block complete" badge
- Kanban badge on the task card shows 🔔

### 3.7 Manual adjust
**Steps:** Open timer widget → enter 1h 30m in adjust inputs → click "Set & Continue"
**Expected:** Large display jumps to 01:30:00, breakdown shows 1/30/0/0

### 3.8 Active task shows badge in kanban
**Steps:** Start a timer → navigate to Kanban
**Expected:** The task's card shows a small "🔔N" badge in the card bottom-right

---

## 4. Reminder Condition UI

### 4.1 Condition builder hidden by default
**Steps:** New Reminder → "Condition" section shows "No condition" mode
**Expected:** Condition builder (field/op/value rows) is hidden

### 4.2 Condition builder visible on mode change
**Steps:** Change dropdown to "Fire if ANY condition passes"
**Expected:** Builder appears with "+ Add condition row" button

### 4.3 Add and populate a condition row
**Steps:** Click "+ Add condition row" → select field "Status", op "equals", value "In Progress"
**Expected:** Preview text appears: "→ Fire if ANY: status equals "In Progress""

### 4.4 Condition serialised on save
**Steps:** Save reminder with condition → inspect entity in IDB
**Expected:** entity.conditionMode = "any", entity.conditionJson = JSON string with {op:"or", conditions:[...]}

### 4.5 Condition restored on edit
**Steps:** Open the reminder from 4.4 for edit
**Expected:** Condition mode pre-selected, row pre-filled with field/op/value from saved JSON

### 4.6 isTemplate flag
**Steps:** Check "Save as template" → save
**Expected:** entity.isTemplate = true, reminder appears in Templates section

---

## 5. Reminders View — Template Library

### 5.1 Template panel opens
**Steps:** Navigate to Reminders → click "📋 Templates"
**Expected:** Template Library panel slides in, lists all reminders with isTemplate=true

### 5.2 Apply template modal
**Steps:** In template panel → click "▶ Apply" on a template
**Expected:** Modal opens with entity-type selector and "Apply Template" button

### 5.3 Apply to entities
**Steps:** Select "Tasks" → click "Apply Template"
**Expected:** Modal shows "✓ Created N reminder(s) from template." and closes after 1.8s

---

## 6. Completion Tracking

### 6.1 Snooze button (adaptive)
**Steps:** On an active reminder row → click "💤" snooze
**Expected:** Toast shows "Snoozed Xm" where X = adaptive minutes based on fire count

### 6.2 Skip occurrence
**Steps:** On recurring reminder → click "⏭" skip
**Expected:** Reminder's nextFireAt advances to next occurrence; reminderLog entity written with outcome='skipped'

### 6.3 Mark done
**Steps:** On active reminder → click "✓"
**Expected:** Reminder dismissed, reminderLog entity written with outcome='done'

---

## 7. Kanban Reminder Badges

### 7.1 Badge appears on active reminder
**Steps:** Create a reminder linked to a task → navigate to Kanban
**Expected:** Task card shows "🔔1" badge in the meta row

### 7.2 Badge clears after dismiss
**Steps:** Dismiss the reminder → badge disappears from card (no full re-render needed, DOM is patched)

### 7.3 Badge count is correct
**Steps:** Link 3 reminders to one task
**Expected:** Card shows "🔔3"

---

## 8. Calendar — Reminder Indicators

### 8.1 🔔 in month popover
**Steps:** Navigate to Calendar → click a day with a task that has a reminder
**Expected:** Task item in the day popover shows a "🔔1" badge next to the title

### 8.2 🔔 in week view blocks
**Steps:** Switch to Week view → hover over an event/task block with a reminder
**Expected:** Block title includes a small 🔔 emoji

### 8.3 Filter toggle
**Steps:** Click "🔔 Reminders only" toggle button in header
**Expected:** Calendar items without active reminders are hidden; button turns blue (accent color)

### 8.4 Toggle off restores all items
**Steps:** Click "🔔 Reminders only" again
**Expected:** All calendar items visible again; button returns to outline style

---

## 9. Settings — Notifications & Reminders

### 9.1 Push permission button
**Steps:** Settings → Notifications & Reminders section → "Enable" button visible if not granted
**Expected:** Clicking "Enable" triggers browser permission dialog; on grant, status badge changes to "✓ Granted"

### 9.2 Audio test button
**Steps:** Select "Ping" tone → click "▶ Test"
**Expected:** Short tone plays through speakers (browser may require prior user interaction)

### 9.3 Quiet hours save
**Steps:** Enable quiet hours, set 23:00–06:00, click Save
**Expected:** Toast/button text changes to "✓ Saved", ISetting 'reminderQuietHours' in IDB = {enabled:true, start:"23:00", end:"06:00"}

### 9.4 Quiet hours gate
**Steps:** Set quiet hours to cover current time → trigger a reminder (set fireAt 1s from now)
**Expected:** Reminder does NOT fire during quiet hours

---

## 10. Phase 3 Scaffolding

### 10.1 phase3Stubs export exists
**Steps:** In browser console: `import('/services/reminder.js').then(m => console.log(Object.keys(m.phase3Stubs)))`
**Expected:** Logs `["autoRulesEngine", "chainedReminders", "nlpInput", "geofence"]`

### 10.2 Stubs throw on call
**Steps:** `m.phase3Stubs.autoRulesEngine()` in console
**Expected:** Throws `Error: [Phase 3] Auto-rules engine not yet implemented`

---

## 11. Regression Tests

### 11.1 Existing reminder flow unbroken
**Steps:** Create reminder from entity panel → check FAB badge → open alert drawer → dismiss
**Expected:** Full flow works as in v5.0.0

### 11.2 Kanban drag-drop unbroken
**Steps:** Drag a task card from "Not Started" to "In Progress"
**Expected:** Card moves, status updates — reminder badge remains if present

### 11.3 Calendar navigation unbroken
**Steps:** Navigate Month → Week → Agenda → back
**Expected:** No JS errors, all views render correctly

### 11.4 Quiet hours toggle doesn't break scheduler
**Steps:** Enable quiet hours with window that does NOT cover current time → wait for reminder tick
**Expected:** Reminders still fire correctly

### 11.5 Service worker cache busted
**Steps:** Hard-refresh after deploying → check SW version in DevTools > Application > Service Workers
**Expected:** Shows v5.1.0

---

*Total: 42 integration test scenarios across 11 areas*
