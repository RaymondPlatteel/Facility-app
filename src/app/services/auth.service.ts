import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';

// A trainer who can run the facility. Each has their own PIN, so unlocking the
// app also establishes *who* is working — that identity is what gets attached
// to sessions they're assigned to.
export interface Trainer {
  id: string;
  name: string;
  pin: string;
}

// The facility's trainers. Small and fixed — this is a single-gym app, so a
// hardcoded roster beats a Firestore collection nobody would ever administer.
export const TRAINERS: Trainer[] = [
  { id: 'raymond', name: 'Raymond', pin: '7210' },
  { id: 'abram', name: 'Abram', pin: '1811' }
];

export function trainerById(id: string | null | undefined): Trainer | null {
  if (!id) return null;
  return TRAINERS.find(t => t.id === id) ?? null;
}

export function trainerName(id: string | null | undefined): string {
  return trainerById(id)?.name ?? 'Unassigned';
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private readonly STORAGE_KEY = 'facility_auth_state';
  private readonly TRAINER_KEY = 'facility_auth_trainer';
  private isAuthenticatedSubject = new BehaviorSubject<boolean>(false);
  private currentTrainerSubject = new BehaviorSubject<Trainer | null>(null);
  private keypadRequestSubject = new Subject<void>();

  public isAuthenticated$ = this.isAuthenticatedSubject.asObservable();
  // Who is currently signed in (null when locked).
  public currentTrainer$ = this.currentTrainerSubject.asObservable();
  // App shell hosts the PIN keypad; anything can summon it through here.
  public keypadRequest$ = this.keypadRequestSubject.asObservable();

  readonly trainers = TRAINERS;

  constructor() {
    this.loadAuthState();
  }

  private loadAuthState(): void {
    const savedState = localStorage.getItem(this.STORAGE_KEY);
    if (savedState !== 'true') return;

    // Sessions saved before per-trainer login have no trainer recorded; treat
    // them as authenticated-but-unattributed rather than forcing a re-login.
    const trainer = trainerById(localStorage.getItem(this.TRAINER_KEY));
    this.isAuthenticatedSubject.next(true);
    this.currentTrainerSubject.next(trainer);
  }

  private saveAuthState(isAuthenticated: boolean, trainer: Trainer | null): void {
    localStorage.setItem(this.STORAGE_KEY, isAuthenticated.toString());
    if (trainer) {
      localStorage.setItem(this.TRAINER_KEY, trainer.id);
    } else {
      localStorage.removeItem(this.TRAINER_KEY);
    }
  }

  requestKeypad(): void {
    this.keypadRequestSubject.next();
  }

  // Any trainer's PIN unlocks the app — whose PIN it was decides who's signed in.
  verifyPin(code: string): boolean {
    const trainer = TRAINERS.find(t => t.pin === code);
    if (!trainer) return false;
    this.authenticate(trainer);
    return true;
  }

  authenticate(trainer: Trainer | null = null): void {
    this.isAuthenticatedSubject.next(true);
    this.currentTrainerSubject.next(trainer);
    this.saveAuthState(true, trainer);
  }

  logout(): void {
    this.isAuthenticatedSubject.next(false);
    this.currentTrainerSubject.next(null);
    this.saveAuthState(false, null);
  }

  getCurrentAuthState(): boolean {
    return this.isAuthenticatedSubject.value;
  }

  getCurrentTrainer(): Trainer | null {
    return this.currentTrainerSubject.value;
  }

  getCurrentTrainerId(): string | null {
    return this.currentTrainerSubject.value?.id ?? null;
  }
}
