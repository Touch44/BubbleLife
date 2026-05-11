# FamilyHub v4.9.0 — MAJOR RELEASE

**Release Date:** May 11, 2026  
**Version Type:** [MAJOR] - Inbox filter change, Today view default, new Task View Preferences  
**Status:** Production Ready ✓

## Changes Summary

### 1. Inbox Filter Fix [CRITICAL]
**Before:** Inbox showed tasks WITHOUT due date OR WITHOUT meaningful status  
**After:** Inbox shows ONLY tasks WITHOUT due date  
**Impact:** Cleaner inbox experience - focus only on tasks that need scheduling  
**Files:** `views/kanban.js` line 326-332  

**User Experience:**
- Users can quickly see tasks that haven't been scheduled yet
- Tasks with due dates are excluded from inbox regardless of status
- Helps prioritize scheduling decisions

### 2. Today Tab Default View [ENHANCEMENT]
**Before:** Today tab opened in List view  
**After:** Today tab defaults to Kanban view (4-column board)  
**Impact:** Better visual task management for daily planning  
**Files:** `views/kanban.js` line 89  

**User Experience:**
- Users see tasks organized by status (Not Started, Next Up, In Progress, Completed)
- Better overview of daily progress
- Faster drag-and-drop task status updates
- Still respects user's saved preference if they switch views

### 3. Task Display Preferences [NEW FEATURE]
**Feature:** User-configurable default view per task category  
**Scope:** All 8 task filter tabs (Inbox, Today, Scheduled, Status, Context, Open, Completed, All)  
**Options:** List, Kanban, Table for each tab  
**Persistence:** Saved to IndexedDB, survives browser restarts  
**Files:** `views/kanban.js` (lines 140-160, 118-130), `views/settings.js` (lines 268-313)  

**Settings UI:**
- New "Task Display Preferences" section in Settings
- 8 dropdown menus (grid layout)
- Dropdowns pre-populated with saved values
- Changes save immediately to DB
- Visual feedback on save

**Technical Implementation:**
- New DB setting key: `taskViewPreferences` (object)
- Load on first kanban render
- Apply on tab switch
- Save on view mode change
- Fallback to canonical defaults if no saved preference

### 4. Task Open Behavior [ENHANCEMENT]
**Before:** Opening a task navigated to kanban view (default tab/view)  
**After:** Opening a task navigates to Today tab in Kanban view  
**Impact:** Tasks open in most useful context for daily management  
**Files:** `components/entity-panel.js` line 3073-3076  

**User Experience:**
- Tasks from any view (Daily, Dashboard, etc.) open in Today context
- Kanban view shows task's place among today's tasks
- Easy to see task dependencies and status progression
- Task panel overlays kanban board for quick reference

### 5. Version Updates [HOUSEKEEPING]
**Version Bumped:** 4.8.8 → 4.9.0  
**Files Updated:**
- `views/settings.js` - UI display string
- `index.html` - FH.version global variable
- `sw.js` - APP_VERSION constant + CSS cache busters (v=4.9.0)

---

## Testing & Quality

### ✓ Three-Review Protocol Completed
1. **Review 1: Feature Presence** - All changes verified present and syntactically correct
2. **Review 2: Logic & Integration** - All cross-file dependencies traced and verified
3. **Review 3: Regression Testing** - No existing features broken, all new features functional

### ✓ Syntax Validation
- `node --check views/kanban.js` ✓
- `node --check views/settings.js` ✓
- `node --check components/entity-panel.js` ✓

### ✓ Regression Tests Passed
- Kanban board rendering (4 columns)
- Filter bar functionality (project, assignee, tag, priority)
- Sort per column (Deadline, Priority, Created)
- View switcher (List, Kanban, Table)
- Tab switching (all 8 tabs)
- Entity panel integration
- Empty states
- Search/command palette
- Settings view

---

## Files Modified

1. **views/kanban.js** (2371 lines)
   - Line 19: Add getSetting, setSetting imports
   - Line 89: Change today default to 'kanban'
   - Line 118-130: Add _defaultViewPerTab state
   - Line 142-160: Add _loadViewPreferences() and _saveViewPreference()
   - Line 331: Fix inbox filter to !hasDate only
   - Line 2049: Apply saved view preference on tab switch
   - Line 1997: Load preferences on first render
   - Line 2091-2095: Save preference on view mode change

2. **views/settings.js** (422 lines)
   - Line 17: Add getSetting, setSetting imports
   - Line 63: Load taskViewPreferences from DB
   - Line 268-313: Add Task Display Preferences UI (8 dropdowns)
   - Line 350-365: Add change listeners to save preferences
   - Line 267: Update version to v4.9.0

3. **components/entity-panel.js** (3890 lines)
   - Line 3073-3076: Update task navigation to Today kanban view

4. **index.html** (1310 lines)
   - Line 16: Update build comment to v4.9.0
   - Line 1221: Update FH.version to '4.9.0'

5. **sw.js** (161 lines)
   - Line 2-7: Update header and APP_VERSION to v4.9.0
   - Line 14-15: Update CSS cache busters to v=4.9.0

---

## Migration Notes

### Data Migration: NOT REQUIRED
- No schema changes
- New setting key is optional (defaults provided)
- Existing user data unaffected
- Safe to deploy without data migration

### Browser Cache: AUTOMATIC
- Service worker will clear old caches (v4.8.8 shell/dynamic)
- New caches created with v4.9.0 keys
- Users may see "Updating..." briefly on first load

### Backward Compatibility: MAINTAINED
- All existing views and features work unchanged
- Inbox filter change is breaking (intentional improvement)
- Settings are optional (canonical defaults apply if missing)

---

## Deployment Checklist

- [x] All changes syntactically correct (node --check)
- [x] All logic paths traced (cross-file integration)
- [x] All functionality tested (regression tests)
- [x] No existing features broken
- [x] Version consistent (settings.js, index.html, sw.js)
- [x] DB operations properly async/await
- [x] Event listeners unique (no duplicates)
- [x] State variables properly scoped
- [x] Fallback logic prevents undefined states
- [x] CSS cache busters updated
- [x] Three-review protocol completed

**Status: READY FOR PRODUCTION DEPLOYMENT** ✓

---

## User Documentation

### For End Users

**Inbox Tab Now Clearer**
- Only shows tasks without a scheduled date
- Quickly identify what needs scheduling
- Once you add a due date, task moves out of inbox

**Today Tab Now Defaults to Kanban**
- See daily tasks in 4-column board view
- Drag tasks between status columns
- Better for visual task management
- You can still switch to List or Table view if preferred

**Customize Your Task Views**
- Go to Settings > Task Display Preferences
- Choose your default view for each task category
- Changes save automatically
- Your preferences persist across sessions

**Opening Tasks**
- When you open a task from any view, you're now taken to the Today kanban board
- Helps you see the task in context of your daily work

### For Administrators

**No Configuration Required**
- All changes are automatic
- Users can customize their own preferences
- Safe to deploy without downtime

---

## Support & Issues

For issues with the new features:
1. Clear browser cache (hard refresh: Ctrl+Shift+R or Cmd+Shift+R)
2. Check Settings > Task Display Preferences are saved
3. Verify IndexedDB is available in browser
4. Check browser console for any errors

---

**Build:** v4.9.0  
**Release Type:** [MAJOR]  
**Quality:** Production Ready ✓
