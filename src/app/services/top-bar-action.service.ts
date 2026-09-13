import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

// Lets a page put ONE primary action button (e.g. "+ New Client") into the
// shared mobile top bar's right side, instead of it living in the page's
// own header row below. Set it in ngOnInit, clear it in ngOnDestroy —
// Angular always finishes destroying the outgoing route component before
// activating the next one, so a page that doesn't set its own action
// reliably sees a clean slate (the previous page's ngOnDestroy already
// cleared it) rather than inheriting a stale button.
export interface TopBarAction {
  label: string;
  icon: string;
  onClick: () => void;
}

@Injectable({ providedIn: 'root' })
export class TopBarActionService {
  private actionSubject = new BehaviorSubject<TopBarAction | null>(null);
  action$ = this.actionSubject.asObservable();

  set(action: TopBarAction): void {
    this.actionSubject.next(action);
  }

  clear(): void {
    this.actionSubject.next(null);
  }
}
