import { inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { of } from 'rxjs';
import { catchError, exhaustMap, map, tap } from 'rxjs/operators';

import { AuthEvents, AuthApiEvents, LoginPageEvents } from './auth.events';
import { LogoutConfirmationDialogComponent } from '../components/logout-confirmation-dialog.component';
import { AuthService } from '../services/auth.service';
import { UserEvents } from '../../core/store/core.events';

const login = createEffect(
  (actions$ = inject(Actions), authService = inject(AuthService)) =>
    actions$.pipe(
      ofType(LoginPageEvents.login),
      exhaustMap(({ credentials }) =>
        authService.login(credentials).pipe(
          map((user) => AuthApiEvents.loginSuccess({ user })),
          catchError((error) => of(AuthApiEvents.loginFailure({ error })))
        )
      )
    ),
  { functional: true }
);

const loginSuccess = createEffect(
  (actions$ = inject(Actions), router = inject(Router)) =>
    actions$.pipe(
      ofType(AuthApiEvents.loginSuccess),
      tap(() => router.navigate(['/']))
    ),
  { functional: true, dispatch: false }
);

const loginRedirect = createEffect(
  (actions$ = inject(Actions), router = inject(Router)) =>
    actions$.pipe(
      ofType(AuthApiEvents.loginRedirect, AuthEvents.logout),
      tap(() => router.navigate(['/login']))
    ),
  { functional: true, dispatch: false }
);

const logoutConfirmation = createEffect(
  (actions$ = inject(Actions), dialog = inject(MatDialog)) =>
    actions$.pipe(
      ofType(AuthEvents.logoutConfirmation),
      exhaustMap(() =>
        dialog
          .open<LogoutConfirmationDialogComponent, undefined, boolean>(
            LogoutConfirmationDialogComponent
          )
          .afterClosed()
      ),
      map((result) =>
        result ? AuthEvents.logout() : AuthEvents.logoutConfirmationDismiss()
      )
    ),
  { functional: true }
);

const logoutIdleUser = createEffect(
  (actions$ = inject(Actions)) =>
    actions$.pipe(
      ofType(UserEvents.idleTimeout),
      map(() => AuthEvents.logout())
    ),
  { functional: true }
);

export const authEffects = {
  login,
  loginSuccess,
  loginRedirect,
  logoutConfirmation,
  logoutIdleUser,
};
