import { emptyProps, props } from '@ngrx/store';

import type { Credentials, User } from '../models/user';
import { createEventGroup } from '../../shared/utils/create-event-group';

export const AuthEvents = createEventGroup('Auth', {
  logout: emptyProps(),
  logoutConfirmation: emptyProps(),
  logoutConfirmationDismiss: emptyProps(),
});

export const AuthApiEvents = createEventGroup('Auth/API', {
  loginSuccess: props<{ user: User }>(),
  loginFailure: props<{ error: string }>(),
  loginRedirect: emptyProps(),
});

export const LoginPageEvents = createEventGroup('Login Page', {
  login: props<{ credentials: Credentials }>(),
});
