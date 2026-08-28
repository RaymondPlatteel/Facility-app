import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

// Admin routes require the PIN. Unauthenticated visitors land back on the
// kiosk home with the keypad already open.
export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (auth.getCurrentAuthState()) {
    return true;
  }
  auth.requestKeypad();
  return router.createUrlTree(['/home']);
};
