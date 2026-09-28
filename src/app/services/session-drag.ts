import { NgZone } from '@angular/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';

// Press-and-drag to reschedule, shared by the Schedule page and the package
// session calendar. Pointer events cover mouse, finger and Pencil alike:
//
//   mouse / pen  the drag starts once the pointer moves a few pixels
//   touch        the drag starts after a short hold, so an ordinary swipe
//                still scrolls the page; moving before the hold is up
//                cancels and lets the scroll happen
//
// Once a drag is live, touchmove is cancelled so the page can't scroll out
// from under the finger (the page auto-scrolls near its top/bottom edge
// instead), and the click that ends a drag is swallowed so dropping a card
// doesn't also open it. Everything runs outside Angular's zone — a drag
// fires dozens of moves a second — and only re-enters it for the callbacks.
export interface SessionDragConfig {
  zone: NgZone;
  // The element under the finger, cloned as the floating ghost.
  source: HTMLElement;
  // A ready-made ghost instead of the clone (the source's styles don't
  // travel with it, e.g. a day inside ion-datetime's shadow DOM). It floats
  // just above the pointer so a finger doesn't hide it.
  ghost?: HTMLElement;
  // Drop key (a YYYY-MM-DD date, or 'prev'/'next' for page flips) under the
  // pointer, or null.
  targetAt(x: number, y: number): string | null;
  canDrop(key: string): boolean;
  // The hovered key changed. Also called with null when the drag ends.
  onOver(key: string | null, ok: boolean): void;
  onDrop(key: string): void;
  // A started drag ended, dropped or not.
  onEnd?(): void;
  // Hovering a 'prev'/'next' key for a moment calls this, then keeps
  // flipping while the pointer stays there.
  onFlip?(dir: 'prev' | 'next'): void;
  // Checked the moment the drag would start; return false to refuse it
  // (the callback says why, e.g. attendance is already taken).
  canStart?(): boolean;
  // Page scroller to auto-scroll near its top/bottom edge.
  scrollEl?: HTMLElement | null;
}

const HOLD_MS = 260;
const SLOP_PX = 8;
const MOUSE_START_PX = 5;
const EDGE_PX = 72;
const FLIP_MS = 650;

export class SessionDrag {
  private cfg: SessionDragConfig | null = null;
  private pointerId = -1;
  private startX = 0;
  private startY = 0;
  private lastX = 0;
  private lastY = 0;
  private active = false;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private flipTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollRaf = 0;
  private ghost: HTMLElement | null = null;
  private sourceRect: DOMRect | null = null;
  private sourceClone: HTMLElement | null = null;
  private ghostOffsetX = 0;
  private ghostOffsetY = 0;
  private over: string | null = null;

  get dragging(): boolean {
    return this.active;
  }

  begin(ev: PointerEvent, cfg: SessionDragConfig) {
    if (this.cfg || !ev.isPrimary || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
    this.cfg = cfg;
    this.pointerId = ev.pointerId;
    this.startX = this.lastX = ev.clientX;
    this.startY = this.lastY = ev.clientY;
    // Measured and copied now, not when the drag starts: a schedule reload
    // landing in between re-renders the card and detaches this element.
    this.sourceRect = cfg.source.getBoundingClientRect();
    this.sourceClone = cfg.ghost ? null : (cfg.source.cloneNode(true) as HTMLElement);
    cfg.zone.runOutsideAngular(() => {
      window.addEventListener('pointermove', this.onMove, { passive: true });
      window.addEventListener('pointerup', this.onUp);
      window.addEventListener('pointercancel', this.onCancel);
      window.addEventListener('touchmove', this.onTouchMove, { passive: false });
      window.addEventListener('keydown', this.onKey);
      window.addEventListener('contextmenu', this.onContextMenu);
      if (ev.pointerType !== 'mouse') {
        this.holdTimer = setTimeout(() => this.activate(), HOLD_MS);
      }
    });
  }

  cancel() {
    this.finish(false);
  }

  private activate() {
    const cfg = this.cfg;
    if (!cfg || this.active) return;
    this.holdTimer = null;
    if (cfg.canStart && !cfg.zone.run(() => cfg.canStart!())) {
      this.finish(false);
      return;
    }
    this.active = true;
    Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {});

    const rect = this.sourceRect!;
    const ghost = cfg.ghost ?? this.sourceClone!;
    ghost.classList.add('drag-ghost');
    this.ghostOffsetX = this.startX - rect.left;
    this.ghostOffsetY = this.startY - rect.top;
    Object.assign(ghost.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      margin: '0',
      zIndex: '100000',
      pointerEvents: 'none',
      boxShadow: '0 18px 40px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(0, 212, 255, 0.55)',
      opacity: '0.95',
      transition: 'none',
      willChange: 'transform'
    } as Partial<CSSStyleDeclaration>);
    if (!cfg.ghost) ghost.style.width = `${rect.width}px`;
    document.body.appendChild(ghost);
    if (cfg.ghost) {
      const g = ghost.getBoundingClientRect();
      this.ghostOffsetX = g.width / 2;
      this.ghostOffsetY = g.height + 22;
    }
    this.ghost = ghost;
    cfg.source.classList.add('drag-source');
    document.body.classList.add('session-dragging');
    this.positionGhost();
    this.hover();
  }

  private positionGhost() {
    if (!this.ghost) return;
    const x = this.lastX - this.ghostOffsetX;
    const y = this.lastY - this.ghostOffsetY;
    this.ghost.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(-1.5deg) scale(1.03)`;
  }

  private hover() {
    const cfg = this.cfg;
    if (!cfg) return;
    const key = cfg.targetAt(this.lastX, this.lastY);
    if (key === this.over) return;
    this.over = key;
    if (this.flipTimer) {
      clearTimeout(this.flipTimer);
      this.flipTimer = null;
    }
    if ((key === 'prev' || key === 'next') && cfg.onFlip) {
      const flip = () => {
        cfg.zone.run(() => cfg.onFlip!(key));
        Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
        this.flipTimer = setTimeout(flip, FLIP_MS * 1.4);
      };
      this.flipTimer = setTimeout(flip, FLIP_MS);
    }
    const ok = !!key && key !== 'prev' && key !== 'next' && cfg.canDrop(key);
    if (ok) Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
    cfg.zone.run(() => cfg.onOver(key, ok));
  }

  // Scroll the page while the pointer sits near its top or bottom edge.
  private autoScroll() {
    const el = this.cfg?.scrollEl;
    if (!el || !this.active) return;
    const rect = el.getBoundingClientRect();
    const top = Math.max(rect.top, 0);
    const bottom = Math.min(rect.bottom, window.innerHeight);
    let dy = 0;
    if (this.lastY < top + EDGE_PX) dy = -Math.ceil((top + EDGE_PX - this.lastY) / 5);
    else if (this.lastY > bottom - EDGE_PX) dy = Math.ceil((this.lastY - (bottom - EDGE_PX)) / 5);
    if (dy) {
      el.scrollTop += dy;
      this.hover();
      this.scrollRaf = requestAnimationFrame(() => this.autoScroll());
    } else {
      this.scrollRaf = 0;
    }
  }

  private onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== this.pointerId) return;
    this.lastX = ev.clientX;
    this.lastY = ev.clientY;
    const moved = Math.hypot(ev.clientX - this.startX, ev.clientY - this.startY);
    if (!this.active) {
      if (ev.pointerType === 'mouse') {
        if (moved > MOUSE_START_PX) this.activate();
      } else if (moved > SLOP_PX) {
        // Moved before the hold finished: a scroll, not a drag.
        this.finish(false);
      }
      return;
    }
    this.positionGhost();
    this.hover();
    if (!this.scrollRaf) this.scrollRaf = requestAnimationFrame(() => this.autoScroll());
  };

  private onTouchMove = (ev: TouchEvent) => {
    if (this.active && ev.cancelable) ev.preventDefault();
  };

  private onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== this.pointerId) return;
    this.lastX = ev.clientX;
    this.lastY = ev.clientY;
    this.finish(this.active);
  };

  private onCancel = (ev: PointerEvent) => {
    if (ev.pointerId === this.pointerId) this.finish(false);
  };

  private onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') this.finish(false);
  };

  // A long press would otherwise open the browser's own context menu.
  private onContextMenu = (ev: Event) => {
    if (this.cfg) ev.preventDefault();
  };

  private finish(drop: boolean) {
    const cfg = this.cfg;
    if (!cfg) return;
    const wasActive = this.active;
    const key = wasActive ? cfg.targetAt(this.lastX, this.lastY) : null;

    if (this.holdTimer) clearTimeout(this.holdTimer);
    if (this.flipTimer) clearTimeout(this.flipTimer);
    if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
    this.holdTimer = this.flipTimer = null;
    this.scrollRaf = 0;
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onCancel);
    window.removeEventListener('touchmove', this.onTouchMove);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('contextmenu', this.onContextMenu);
    this.ghost?.remove();
    this.ghost = this.sourceClone = this.sourceRect = null;
    cfg.source.classList.remove('drag-source');
    document.body.classList.remove('session-dragging');
    this.cfg = null;
    this.active = false;
    this.over = null;

    if (!wasActive) return;
    const swallow = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
      window.removeEventListener('click', swallow, true);
    };
    window.addEventListener('click', swallow, true);
    setTimeout(() => window.removeEventListener('click', swallow, true), 400);
    cfg.zone.run(() => {
      cfg.onOver(null, false);
      cfg.onEnd?.();
      if (drop && key && key !== 'prev' && key !== 'next' && cfg.canDrop(key)) cfg.onDrop(key);
    });
  }
}
