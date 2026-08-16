// Gift effects — v1.
//
// giftFly(): the gift emoji arcs from the dock up to the recipient's mic
// ring, pops, ripples the ring and floats the value up as 💚.
// bigGiftFx(): fullscreen celebration for broadcast-tier gifts — giant
// emoji zoom + a canvas confetti burst in the hall's jade/gold palette.
//
// Everything cleans itself up; nothing here touches game state.

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

const CONFETTI_COLORS = ['#8fbc6e', '#c9a94f', '#ffffff', '#f2ead0', '#64934a', '#d9e7c4'];

/* Fly one emoji from the bottom of the screen to the target seat ring. */
export function giftFly({ emoji, value = 0, targetEl }) {
  if (reduced) return;

  // Recipient not seated (or seat not rendered): a simple center pop.
  if (!targetEl || !targetEl.isConnected) return centerPop(emoji);

  const to = targetEl.getBoundingClientRect();
  const toX = to.left + to.width / 2;
  const toY = to.top + to.height / 2;
  const fromX = innerWidth / 2 + (Math.random() * 120 - 60);
  const fromY = innerHeight - 70;
  const midX = (fromX + toX) / 2 + (Math.random() * 80 - 40);
  const midY = Math.min(fromY, toY) - 130;   // arc apex

  const el = document.createElement('span');
  el.className = 'fx-fly';
  el.textContent = emoji;
  document.body.append(el);

  const anim = el.animate([
    { transform: `translate(${fromX}px, ${fromY}px) scale(0.7)`, opacity: 0.2 },
    { transform: `translate(${midX}px, ${midY}px) scale(1.35)`, opacity: 1, offset: 0.55 },
    { transform: `translate(${toX}px, ${toY}px) scale(1)`, opacity: 1 },
  ], { duration: 760, easing: 'cubic-bezier(0.3, 0.6, 0.4, 1)' });

  anim.onfinish = () => {
    el.remove();
    ringRipple(targetEl);
    floatValue(targetEl, value);
    // little pop where it lands
    const pop = document.createElement('span');
    pop.className = 'fx-fly';
    pop.textContent = emoji;
    document.body.append(pop);
    pop.animate([
      { transform: `translate(${toX}px, ${toY}px) scale(1)`, opacity: 1 },
      { transform: `translate(${toX}px, ${toY}px) scale(1.9)`, opacity: 0 },
    ], { duration: 420, easing: 'ease-out' }).onfinish = () => pop.remove();
  };
}

function centerPop(emoji) {
  const el = document.createElement('span');
  el.className = 'fx-fly';
  el.textContent = emoji;
  document.body.append(el);
  const x = innerWidth / 2, y = innerHeight / 2;
  el.animate([
    { transform: `translate(${x}px, ${y}px) scale(0.4)`, opacity: 0 },
    { transform: `translate(${x}px, ${y}px) scale(1.6)`, opacity: 1, offset: 0.4 },
    { transform: `translate(${x}px, ${y - 60}px) scale(1.2)`, opacity: 0 },
  ], { duration: 900, easing: 'ease-out' }).onfinish = () => el.remove();
}

/* Expanding ring on the seat. */
function ringRipple(targetEl) {
  const r = document.createElement('span');
  r.className = 'fx-ripple';
  targetEl.append(r);
  r.addEventListener('animationend', () => r.remove());
}

/* "💚 +123" drifting up from the seat. */
function floatValue(targetEl, value) {
  if (!value) return;
  const seat = targetEl.closest('.seat') ?? targetEl;
  const f = document.createElement('span');
  f.className = 'fx-float';
  f.textContent = `💚 +${Number(value).toLocaleString('en-US')}`;
  seat.append(f);
  f.addEventListener('animationend', () => f.remove());
}

/* Fullscreen celebration for broadcast-tier gifts. */
export function bigGiftFx({ emoji, tier = 'silver' }) {
  if (reduced) return;
  if (document.querySelector('.fx-big')) return;   // one at a time

  const wrap = document.createElement('div');
  wrap.className = 'fx-big';
  const face = document.createElement('span');
  face.className = 'fx-big-emoji';
  face.textContent = emoji;
  wrap.append(face);
  document.body.append(wrap);
  setTimeout(() => wrap.remove(), 2400);

  confetti(tier === 'gold' ? 170 : 110);
}

/* Lightweight canvas confetti burst. */
function confetti(count) {
  const canvas = document.createElement('canvas');
  canvas.className = 'fx-canvas';
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');

  const parts = Array.from({ length: count }, () => ({
    x: innerWidth / 2 + (Math.random() * 200 - 100),
    y: innerHeight * 0.45,
    vx: Math.random() * 14 - 7,
    vy: -(Math.random() * 11 + 4),
    size: Math.random() * 7 + 4,
    rot: Math.random() * Math.PI,
    vr: Math.random() * 0.3 - 0.15,
    color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
  }));

  const t0 = performance.now();
  const LIFE = 2100;

  (function frame(now) {
    const age = now - t0;
    if (age > LIFE) return canvas.remove();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = Math.max(0, 1 - age / LIFE);
    for (const p of parts) {
      p.vy += 0.22;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }
    requestAnimationFrame(frame);
  })(t0);
}
