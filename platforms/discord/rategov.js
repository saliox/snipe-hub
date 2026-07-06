// Régulateur de cadence ADAPTATIF (AIMD — Additive Increase / Multiplicative
// Decrease), comme l'anti-rate-limit du sniper MC.
//
// Principe (façon contrôle de congestion TCP) :
//  - succès RÉPÉTÉS (streak) → on accélère par petits pas (interval × 0.85),
//    seulement après `speedupAfter` sondes propres → évite l'oscillation ;
//  - 429 (rate limit) → on ralentit FORT (interval × 2) + pause globale qui
//    respecte `Retry-After` ;
//  - Cloudflare 1015 → plafond + longue pause.
// Borné par un plancher (floor) et un plafond (ceil). Rapide quand l'API suit,
// prudent dès qu'elle proteste.
export class RateGov {
  constructor({
    floorMs = 800, ceilMs = 15000, startMs = null,
    speedupAfter = 8, speedupFactor = 0.85, slowdownFactor = 2,
  } = {}) {
    this.floor = Math.max(1, floorMs);
    this.ceil = Math.max(this.floor, ceilMs);
    this.interval = Math.min(this.ceil, Math.max(this.floor, startMs ?? floorMs));
    this.speedupAfter = speedupAfter;
    this.speedupFactor = speedupFactor;
    this.slowdownFactor = slowdownFactor;
    this.streak = 0;
    this.pauseUntil = 0;
    this.throttleEvents = 0;
  }

  // Une sonde propre : on accélère après assez de succès consécutifs.
  onSuccess() {
    if (++this.streak >= this.speedupAfter && this.interval > this.floor) {
      this.interval = Math.max(this.floor, Math.round(this.interval * this.speedupFactor));
      this.streak = 0;
    }
  }

  // 429 : ralentissement multiplicatif + pause respectant Retry-After.
  onRateLimit(retryAfterSec) {
    this.throttleEvents++;
    this.streak = 0;
    this.interval = Math.min(this.ceil, Math.round(this.interval * this.slowdownFactor));
    const backoff = retryAfterSec ? retryAfterSec * 1000 : Math.min(this.interval * 2, 8000);
    this.pauseUntil = Math.max(this.pauseUntil, Date.now() + backoff);
  }

  // Cloudflare 1015 : IP bloquée un moment → plafond + longue pause.
  onCloudflare(banMs = 60000) {
    this.throttleEvents++;
    this.streak = 0;
    this.interval = this.ceil;
    this.pauseUntil = Math.max(this.pauseUntil, Date.now() + banMs);
  }

  throttled() { return Date.now() < this.pauseUntil; }

  // Délai avant la prochaine sonde : la pause (backoff) est prioritaire ; sinon
  // l'intervalle courant, jamais sous `minMs`.
  nextDelay(minMs = 0) {
    const now = Date.now();
    if (now < this.pauseUntil) return this.pauseUntil - now;
    return Math.max(minMs, this.interval);
  }
}
