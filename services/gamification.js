/**
 * FamilyHub v6.1.0 — services/gamification.js
 * ─────────────────────────────────────────────
 * Project Gamification Engine
 *
 * Features:
 *   • XP economy — earn XP for completing tasks, streaks, finishing projects
 *   • Levels (1–20) with named tiers (Apprentice → Legend)
 *   • Badges — unlocked once, stored permanently in IDB
 *   • Project completion streaks — consecutive days with ≥1 task done
 *   • Family leaderboard — per-member XP ranking
 *   • All state persisted in IDB settings (key: 'gamification:state')
 *
 * Public API:
 *   initGamification()           — wire event listeners, call once at boot
 *   awardXP(memberId, xp, reason)— grant XP and check level/badge triggers
 *   getGamificationState()       — { members: {[id]: MemberState}, badges: Badge[] }
 *   getProjectStreak(projectId)  — { current, best, lastDate }
 *   recordTaskDone(task, projectId) — called by projects.js on task completion
 */

import { getSetting, setSetting, getEntitiesByType } from '../core/db.js';
import { on, emit, EVENTS }                          from '../core/events.js';
import { showToast }                                 from '../core/toast.js';

// ── Constants ────────────────────────────────────────────────────
const SETTINGS_KEY  = 'gamification:state';
const STREAK_KEY    = 'gamification:streaks';   // projectId → streak data

// ── XP values ────────────────────────────────────────────────────
export const XP = {
  TASK_DONE:          10,
  TASK_CRITICAL:      25,   // critical priority task
  TASK_OVERDUE_SAVE:  -5,   // completing an overdue task (still positive net)
  STREAK_3:           15,
  STREAK_7:           40,
  STREAK_14:          80,
  STREAK_30:          200,
  PROJECT_COMPLETE:   150,
  PROJECT_ON_TIME:    75,   // bonus: finished before deadline
  FIRST_TASK:         20,   // first ever task completed
};

// ── Level thresholds ─────────────────────────────────────────────
export const LEVELS = [
  { level: 1,  xp: 0,    title: 'Newcomer',     icon: '🌱' },
  { level: 2,  xp: 50,   title: 'Apprentice',   icon: '📝' },
  { level: 3,  xp: 150,  title: 'Contributor',  icon: '⚡' },
  { level: 4,  xp: 300,  title: 'Builder',      icon: '🔨' },
  { level: 5,  xp: 500,  title: 'Achiever',     icon: '🎯' },
  { level: 6,  xp: 750,  title: 'Hustler',      icon: '🚀' },
  { level: 7,  xp: 1100, title: 'Expert',       icon: '💡' },
  { level: 8,  xp: 1500, title: 'Specialist',   icon: '🏅' },
  { level: 9,  xp: 2000, title: 'Pro',          icon: '⭐' },
  { level: 10, xp: 2700, title: 'Master',       icon: '🏆' },
  { level: 11, xp: 3500, title: 'Elite',        icon: '💎' },
  { level: 12, xp: 4500, title: 'Champion',     icon: '👑' },
  { level: 13, xp: 5800, title: 'Veteran',      icon: '🌟' },
  { level: 14, xp: 7500, title: 'Grandmaster',  icon: '🔱' },
  { level: 15, xp: 9500, title: 'Legend',       icon: '🌠' },
];

// ── Badge definitions ─────────────────────────────────────────────
export const BADGE_DEFS = [
  // Task milestones
  { id: 'first_task',    label: 'First Step',      icon: '👣', desc: 'Complete your first task',          color: '#10b981' },
  { id: 'tasks_10',      label: 'Getting Started',  icon: '🔟', desc: '10 tasks completed',                color: '#3b82f6' },
  { id: 'tasks_50',      label: 'On a Roll',        icon: '🎲', desc: '50 tasks completed',                color: '#6366f1' },
  { id: 'tasks_100',     label: 'Centurion',        icon: '💯', desc: '100 tasks completed',               color: '#f59e0b' },
  { id: 'tasks_250',     label: 'Workhorse',        icon: '🐎', desc: '250 tasks completed',               color: '#ec4899' },
  { id: 'tasks_500',     label: 'Unstoppable',      icon: '🌋', desc: '500 tasks completed',               color: '#ef4444' },
  // Streak badges
  { id: 'streak_3',      label: 'Habit Forming',    icon: '🔥', desc: '3-day project streak',              color: '#f97316' },
  { id: 'streak_7',      label: 'Week Warrior',     icon: '⚡', desc: '7-day project streak',              color: '#eab308' },
  { id: 'streak_14',     label: 'Two Week Titan',   icon: '💪', desc: '14-day project streak',             color: '#a855f7' },
  { id: 'streak_30',     label: 'Iron Discipline',  icon: '🏋️', desc: '30-day project streak',             color: '#06b6d4' },
  // Project badges
  { id: 'proj_first',    label: 'Launcher',         icon: '🚀', desc: 'Complete your first project',       color: '#22c55e' },
  { id: 'proj_5',        label: 'Serial Builder',   icon: '🏗️', desc: '5 projects completed',              color: '#3b82f6' },
  { id: 'proj_on_time',  label: 'On Time, Every Time', icon: '⏱️', desc: 'Finish a project before deadline', color: '#10b981' },
  { id: 'proj_speedrun', label: 'Speedrunner',      icon: '⚡', desc: 'Complete a project in under 7 days', color: '#f59e0b' },
  // Priority badges
  { id: 'critical_5',   label: 'Crisis Manager',   icon: '🚨', desc: '5 critical-priority tasks done',    color: '#ef4444' },
  { id: 'critical_20',  label: 'Firefighter',      icon: '🧯', desc: '20 critical-priority tasks done',   color: '#dc2626' },
  // Level-up badges
  { id: 'level_5',      label: 'Rising Star',      icon: '🌟', desc: 'Reach Level 5',                     color: '#f59e0b' },
  { id: 'level_10',     label: 'Hall of Fame',     icon: '🏆', desc: 'Reach Level 10',                    color: '#a855f7' },
  { id: 'level_15',     label: 'Legend Status',    icon: '🌠', desc: 'Reach Level 15',                    color: '#ec4899' },
];

// ── State ────────────────────────────────────────────────────────
let _state   = null;   // { members: {[memberId]: MemberState}, version: 1 }
let _streaks = null;   // { [projectId]: { current, best, lastDate } }
let _loading = null;

// MemberState shape:
// { xp: number, totalTasksDone: number, criticalDone: number,
//   projectsDone: number, projectsOnTime: number,
//   earnedBadgeIds: string[], history: [{xp, reason, ts}] }

// ── Init ─────────────────────────────────────────────────────────
export async function initGamification() {
  await _ensureLoaded();
  // React to task completions via ENTITY_SAVED
  on(EVENTS.ENTITY_SAVED, ({ entity } = {}) => {
    if (entity?.type === 'task' && _isTaskDone(entity)) {
      _handleTaskDone(entity).catch(e => console.warn('[gam] task handler:', e));
    }
    if (entity?.type === 'project' && _isProjectDone(entity)) {
      _handleProjectDone(entity).catch(e => console.warn('[gam] project handler:', e));
    }
  });
}

// ── Public API ───────────────────────────────────────────────────
export async function getGamificationState() {
  await _ensureLoaded();
  return { members: { ...(_state?.members || {}) }, badges: BADGE_DEFS };
}

export async function getProjectStreak(projectId) {
  await _ensureLoaded();
  return _streaks?.[projectId] || { current: 0, best: 0, lastDate: null };
}

export async function getMemberStats(memberId) {
  await _ensureLoaded();
  const m = _state?.members?.[memberId] || _emptyMember();
  return { ...m, level: _levelFor(m.xp), nextLevel: _nextLevel(m.xp) };
}

export async function getLeaderboard() {
  await _ensureLoaded();
  const persons = await getEntitiesByType('person').catch(() => []);
  const rows = [];
  for (const [id, m] of Object.entries(_state?.members || {})) {
    const person = persons.find(p => p.id === id);
    if (!person || person.deleted) continue;
    const lv = _levelFor(m.xp);
    rows.push({
      memberId:   id,
      name:       person.name || person.title || 'Unknown',
      avatar:     person.emoji || person.avatar || null,
      xp:         m.xp,
      level:      lv.level,
      levelTitle: lv.title,
      levelIcon:  lv.icon,
      tasksDone:  m.totalTasksDone || 0,
      badges:     (m.earnedBadgeIds || []).length,
    });
  }
  return rows.sort((a, b) => b.xp - a.xp);
}

export async function awardXP(memberId, xp, reason) {
  if (!memberId || !xp) return;
  await _ensureLoaded();
  const prev = _getMember(memberId);
  const prevLevel = _levelFor(prev.xp);
  prev.xp  += xp;
  if (xp > 0) {
    prev.history = [{ xp, reason, ts: new Date().toISOString() }, ...(prev.history || [])].slice(0, 50);
  }
  const newLevel = _levelFor(prev.xp);
  _state.members[memberId] = prev;
  await _saveState();

  if (newLevel.level > prevLevel.level) {
    showToast(`${newLevel.icon} Level up! You reached ${newLevel.title} (Level ${newLevel.level})`, 'success', { duration: 5000 });
    emit('gamification:levelup', { memberId, level: newLevel });
    await _checkLevelBadges(memberId, newLevel.level);
  }
  emit('gamification:xp', { memberId, xp, reason, total: prev.xp });
}

export async function recordTaskDone(task, projectId) {
  await _handleTaskDone(task, projectId);
}

// ── Internal: event handlers ─────────────────────────────────────
async function _handleTaskDone(task) {
  const memberId = task.assignedTo || task.createdBy;
  if (!memberId) return;
  await _ensureLoaded();
  const m = _getMember(memberId);

  const isFirst    = (m.totalTasksDone || 0) === 0;
  const isCritical = task.priority === 'Critical';
  const wasOverdue = task.dueDate && _isOverdueDate(task.dueDate);

  // Accumulate counters
  m.totalTasksDone   = (m.totalTasksDone || 0) + 1;
  if (isCritical) m.criticalDone = (m.criticalDone || 0) + 1;
  _state.members[memberId] = m;

  // Award XP
  let xpTotal = XP.TASK_DONE;
  if (isFirst)    xpTotal += XP.FIRST_TASK;
  if (isCritical) xpTotal += XP.TASK_CRITICAL - XP.TASK_DONE; // differential
  if (wasOverdue) xpTotal += XP.TASK_OVERDUE_SAVE;

  await awardXP(memberId, xpTotal,
    isCritical ? '🚨 Critical task completed' : '✅ Task completed');

  // Check task-count badges
  await _checkTaskBadges(memberId, m.totalTasksDone, m.criticalDone || 0);

  // Update project streak
  if (task._projectId || task.projectId) {
    await _updateProjectStreak(task._projectId || task.projectId, memberId);
  }
}

async function _handleProjectDone(project) {
  const memberId = project.assignedTo || project.createdBy;
  if (!memberId) return;
  await _ensureLoaded();
  const m = _getMember(memberId);
  m.projectsDone = (m.projectsDone || 0) + 1;

  const onTime = project.deadline && !_isOverdueDate(project.deadline);
  if (onTime) m.projectsOnTime = (m.projectsOnTime || 0) + 1;

  // Speedrun: created + completed within 7 days
  const created  = project.createdAt ? new Date(project.createdAt) : null;
  const speedrun = created && ((Date.now() - created.getTime()) < 7 * 86400000);

  _state.members[memberId] = m;
  let xp = XP.PROJECT_COMPLETE;
  if (onTime)   xp += XP.PROJECT_ON_TIME;
  await awardXP(memberId, xp, '🎉 Project completed' + (onTime ? ' on time!' : ''));

  await _checkProjectBadges(memberId, m.projectsDone, onTime, speedrun);
}

// ── Project streak tracking ───────────────────────────────────────
async function _updateProjectStreak(projectId, memberId) {
  const today     = _today();
  const streak    = _streaks[projectId] || { current: 0, best: 0, lastDate: null };
  const yesterday = _dateOffset(-1);

  if (streak.lastDate === today) {
    // Already recorded today — no change
  } else if (streak.lastDate === yesterday) {
    // Continuing streak
    streak.current += 1;
    streak.best     = Math.max(streak.best, streak.current);
  } else {
    // Streak broken (or first day)
    streak.current = 1;
    streak.best    = Math.max(streak.best || 0, 1);
  }
  streak.lastDate = today;
  _streaks[projectId] = streak;
  await _saveStreaks();

  // Award streak XP milestones
  const xpMap = { 3: XP.STREAK_3, 7: XP.STREAK_7, 14: XP.STREAK_14, 30: XP.STREAK_30 };
  if (xpMap[streak.current] && memberId) {
    await awardXP(memberId, xpMap[streak.current], `🔥 ${streak.current}-day streak on project`);
    showToast(`🔥 ${streak.current}-day streak! Keep it up!`, 'success', { duration: 4000 });
  }
  await _checkStreakBadges(memberId, streak.current);

  emit('gamification:streak', { projectId, streak: streak.current, best: streak.best });
}

// ── Badge checks ─────────────────────────────────────────────────
async function _checkTaskBadges(memberId, total, critical) {
  const milestones = [
    [1,   'first_task'],
    [10,  'tasks_10'],
    [50,  'tasks_50'],
    [100, 'tasks_100'],
    [250, 'tasks_250'],
    [500, 'tasks_500'],
  ];
  for (const [n, id] of milestones) {
    if (total >= n) await _awardBadge(memberId, id);
  }
  if (critical >= 5)  await _awardBadge(memberId, 'critical_5');
  if (critical >= 20) await _awardBadge(memberId, 'critical_20');
}

async function _checkStreakBadges(memberId, streak) {
  if (!memberId) return;
  if (streak >= 3)  await _awardBadge(memberId, 'streak_3');
  if (streak >= 7)  await _awardBadge(memberId, 'streak_7');
  if (streak >= 14) await _awardBadge(memberId, 'streak_14');
  if (streak >= 30) await _awardBadge(memberId, 'streak_30');
}

async function _checkProjectBadges(memberId, count, onTime, speedrun) {
  if (count >= 1)  await _awardBadge(memberId, 'proj_first');
  if (count >= 5)  await _awardBadge(memberId, 'proj_5');
  if (onTime)      await _awardBadge(memberId, 'proj_on_time');
  if (speedrun)    await _awardBadge(memberId, 'proj_speedrun');
}

async function _checkLevelBadges(memberId, level) {
  if (level >= 5)  await _awardBadge(memberId, 'level_5');
  if (level >= 10) await _awardBadge(memberId, 'level_10');
  if (level >= 15) await _awardBadge(memberId, 'level_15');
}

async function _awardBadge(memberId, badgeId) {
  if (!memberId) return;
  const m = _getMember(memberId);
  if ((m.earnedBadgeIds || []).includes(badgeId)) return; // already earned
  m.earnedBadgeIds = [...(m.earnedBadgeIds || []), badgeId];
  _state.members[memberId] = m;
  await _saveState();
  const def = BADGE_DEFS.find(b => b.id === badgeId);
  if (def) {
    showToast(`${def.icon} Badge unlocked: ${def.label}!`, 'success', { duration: 5000 });
    emit('gamification:badge', { memberId, badge: def });
  }
}

// ── Persistence ───────────────────────────────────────────────────
async function _ensureLoaded() {
  if (_state) return;
  if (_loading) return _loading;
  _loading = (async () => {
    try {
      _state   = (await getSetting(SETTINGS_KEY))   || { members: {}, version: 1 };
      _streaks = (await getSetting(STREAK_KEY))      || {};
    } catch {
      _state   = { members: {}, version: 1 };
      _streaks = {};
    }
    _loading = null;
  })();
  return _loading;
}

async function _saveState() {
  try { await setSetting(SETTINGS_KEY, _state); } catch { /* non-fatal */ }
}

async function _saveStreaks() {
  try { await setSetting(STREAK_KEY, _streaks); } catch { /* non-fatal */ }
}

// ── Helpers ───────────────────────────────────────────────────────
function _getMember(id) {
  if (!_state.members[id]) _state.members[id] = _emptyMember();
  return _state.members[id];
}

function _emptyMember() {
  return { xp: 0, totalTasksDone: 0, criticalDone: 0, projectsDone: 0,
           projectsOnTime: 0, earnedBadgeIds: [], history: [] };
}

export function _levelFor(xp) {
  let lv = LEVELS[0];
  for (const l of LEVELS) { if (xp >= l.xp) lv = l; else break; }
  return lv;
}

export function _nextLevel(xp) {
  return LEVELS.find(l => l.xp > xp) || null;
}

function _isTaskDone(t) {
  const s = (t?.status || '').toLowerCase();
  return s === 'done' || s === 'completed' || s === 'complete';
}

function _isProjectDone(p) {
  const s = (p?.status || '').toLowerCase();
  return s === 'completed' || s === 'complete' || s === 'done';
}

function _isOverdueDate(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr + 'T00:00:00');
  const t = new Date(); t.setHours(0,0,0,0);
  return d < t;
}

function _today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function _dateOffset(days) {
  const d = new Date(); d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
