/**
 * FamilyHub v3.0 — services/effects.js
 * EffectsService — registered celebration/feedback animations.
 * Implements Prompt 21 spec exactly.
 *
 * Registered as env.services.effects via serviceRegistry.
 *
 * Public API:
 *   play(effectName, options?) — run a registered effect
 *
 * Built-in effects:
 *   'confetti' — canvas particle burst from click point (options: {x, y, count})
 *   'sparkle'  — stars emanate from a target element (options: {target: HTMLElement})
 *   'pulse'    — target element glows briefly (options: {target: HTMLElement, color?})
 *
 * Triggers (wired by kanban/recipe views via play()):
 *   'confetti' — Kanban card moved to Done column, budget goal reached
 *   'sparkle'  — Recipe completed, milestone note saved
 *
 * All effects:
 *   - Clean up after 2 seconds (no DOM residue)
 *   - Respect prefers-reduced-motion — skipped entirely if enabled
 */

import { effectRegistry } from '../core/registry.js';

// ── Reduced-motion guard ──────────────────────────────────── //

const _mq = typeof window !== 'undefined'
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;

function _isReducedMotion() {
  return _mq?.matches ?? false;
}

// ── Built-in: confetti ────────────────────────────────────── //

/**
 * Particle burst from a click point using an ephemeral canvas.
 * @param {{ x?: number, y?: number, count?: number }} opts
 */
function _playConfetti(opts = {}) {
  const x     = opts.x ?? window.innerWidth  / 2;
  const y     = opts.y ?? window.innerHeight / 3;
  const count = opts.count ?? 72;

  const canvas = document.createElement('canvas');
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  Object.assign(canvas.style, {
    position: 'fixed', top: '0', left: '0', pointerEvents: 'none',
    zIndex: '99999', width: '100%', height: '100%',
  });
  document.body.appendChild(canvas);

  const ctx   = canvas.getContext('2d');
  const COLORS = ['#f7c948','#4f8ef7','#e85252','#4caf7d','#b48bfa','#f97316'];

  const particles = Array.from({ length: count }, () => ({
    x, y,
    vx: (Math.random() - 0.5) * 14,
    vy: (Math.random() - 1.2) * 12,
    size:  Math.random() * 6 + 3,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    rotation: Math.random() * Math.PI * 2,
    rotSpeed: (Math.random() - 0.5) * 0.3,
    shape: Math.random() > 0.5 ? 'rect' : 'circle',
    alpha: 1,
  }));

  const GRAVITY = 0.55;
  const DRAG    = 0.98;
  let   frame   = null;
  const start   = performance.now();
  const DURATION = 1800;

  function tick(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / DURATION, 1);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let alive = false;
    for (const p of particles) {
      p.vy += GRAVITY;
      p.vx *= DRAG;
      p.x += p.vx;
      p.y += p.vy;
      p.rotation += p.rotSpeed;
      p.alpha = Math.max(0, 1 - progress * 1.4);

      if (p.alpha <= 0 || p.y > canvas.height + 20) continue;
      alive = true;

      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;

      if (p.shape === 'rect') {
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    if (alive && elapsed < DURATION + 400) {
      frame = requestAnimationFrame(tick);
    } else {
      canvas.remove();
    }
  }

  frame = requestAnimationFrame(tick);

  // Hard cleanup after 2s
  setTimeout(() => {
    if (frame) cancelAnimationFrame(frame);
    canvas.remove();
  }, 2000);
}

// ── Built-in: sparkle ─────────────────────────────────────── //

/**
 * Stars emanate from a target element.
 * @param {{ target?: HTMLElement }} opts
 */
function _playSparkle(opts = {}) {
  const target = opts.target ?? document.body;
  const rect   = target.getBoundingClientRect();
  const cx     = rect.left + rect.width  / 2;
  const cy     = rect.top  + rect.height / 2;
  const count  = 12;

  const container = document.createElement('div');
  Object.assign(container.style, {
    position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
    pointerEvents: 'none', zIndex: '99999', overflow: 'hidden',
  });
  document.body.appendChild(container);

  for (let i = 0; i < count; i++) {
    const star = document.createElement('span');
    const angle  = (i / count) * Math.PI * 2;
    const dist   = 30 + Math.random() * 50;
    const size   = 10 + Math.random() * 12;
    const delay  = Math.random() * 200;
    const tx     = Math.cos(angle) * dist;
    const ty     = Math.sin(angle) * dist;

    star.textContent = '✦';
    Object.assign(star.style, {
      position:   'absolute',
      left:       `${cx}px`,
      top:        `${cy}px`,
      fontSize:   `${size}px`,
      color:      `hsl(${45 + Math.random() * 60}, 100%, 60%)`,
      transform:  'translate(-50%, -50%) scale(0)',
      opacity:    '0',
      transition: `transform 0.5s ease ${delay}ms, opacity 0.5s ease ${delay}ms`,
      willChange: 'transform, opacity',
    });
    container.appendChild(star);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        star.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(1)`;
        star.style.opacity   = '1';
      });
    });

    // Fade out
    setTimeout(() => {
      star.style.opacity   = '0';
      star.style.transform = `translate(calc(-50% + ${tx * 1.6}px), calc(-50% + ${ty * 1.6}px)) scale(0)`;
    }, 600 + delay);
  }

  setTimeout(() => container.remove(), 2000);
}

// ── Built-in: pulse ───────────────────────────────────────── //

/**
 * Target element glows briefly.
 * @param {{ target?: HTMLElement, color?: string }} opts
 */
function _playPulse(opts = {}) {
  const target = opts.target ?? document.body;
  const color  = opts.color  ?? '#4f8ef7';

  const prev = target.style.transition;
  const prevShadow = target.style.boxShadow;

  target.style.transition = 'box-shadow 0.15s ease, transform 0.15s ease';
  target.style.boxShadow  = `0 0 0 4px ${color}66, 0 0 20px 6px ${color}33`;
  target.style.transform  = 'scale(1.03)';

  setTimeout(() => {
    target.style.boxShadow = prevShadow;
    target.style.transform = '';
    setTimeout(() => {
      target.style.transition = prev;
    }, 200);
  }, 350);
}

// ── Register built-in effects ─────────────────────────────── //

effectRegistry.add('confetti', _playConfetti);
effectRegistry.add('sparkle',  _playSparkle);
effectRegistry.add('pulse',    _playPulse);

// ── Service factory ───────────────────────────────────────── //

export function createEffectsService() {
  /**
   * Play a registered effect by name.
   * Silently no-ops if effect not found or user prefers reduced motion.
   * @param {string} effectName
   * @param {object} [opts]
   */
  function play(effectName, opts = {}) {
    if (_isReducedMotion()) return;  // Respect prefers-reduced-motion

    const effectFn = effectRegistry.get(effectName);
    if (!effectFn) {
      console.warn(`[effects] Unknown effect: "${effectName}"`);
      return;
    }

    try {
      effectFn(opts);
    } catch (err) {
      console.error(`[effects] Error playing "${effectName}":`, err);
    }
  }

  /**
   * Register a custom effect.
   * @param {string} name
   * @param {(opts: object) => void} fn
   */
  function register(name, fn) {
    if (typeof fn !== 'function') throw new TypeError('[effects] Effect must be a function');
    if (effectRegistry.has(name)) effectRegistry.remove(name);
    effectRegistry.add(name, fn);
  }

  return { play, register };
}

// ── Service descriptor ────────────────────────────────────── //

export const effectsServiceDescriptor = {
  dependencies: [],
  start() {
    return createEffectsService();
  },
};
