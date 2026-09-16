import {
  Action,
  combineReducers,
  createFeatureSelector,
  createReducer,
  createSelector,
  on,
} from '@ngrx/store';

import type { State as AppState } from '../../core/store/core.state';
import type { User } from '../models/user';
import { AuthEvents, AuthApiEvents, LoginPageEvents } from './auth.events';

export interface StatusState {
  user: User | null;
}

export interface LoginPageState {
  error: string | null;
  pending: boolean;
}

export interface AuthState {
  status: StatusState;
  loginPage: LoginPageState;
}

export interface State extends AppState {
  auth: AuthState;
}

const authFeatureKey = 'auth';

export const initialStatusState: StatusState = { user: null };
export const initialLoginPageState: LoginPageState = {
  error: null,
  pending: false,
};

export const statusReducer = createReducer(
  initialStatusState,
  on(AuthApiEvents.loginSuccess, (state, { user }) => ({ ...state, user })),
  on(AuthEvents.logout, () => initialStatusState)
);

const loginPageReducer = createReducer(
  initialLoginPageState,
  on(LoginPageEvents.login, (state) => ({
    ...state,
    error: null,
    pending: true,
  })),
  on(AuthApiEvents.loginSuccess, (state) => ({
    ...state,
    error: null,
    pending: false,
  })),
  on(AuthApiEvents.loginFailure, (state, { error }) => ({
    ...state,
    error,
    pending: false,
  }))
);

function reducer(state: AuthState | undefined, action: Action) {
  return combineReducers({
    status: statusReducer,
    loginPage: loginPageReducer,
  })(state, action);
}

export const featureSlice = {
  name: authFeatureKey,
  reducer: reducer,
};

const selectAuthState = createFeatureSelector<AuthState>(authFeatureKey);
const selectStatus = createSelector(selectAuthState, (state) => state.status);
const selectLoginPage = createSelector(
  selectAuthState,
  (state) => state.loginPage
);

export const selectUser = createSelector(selectStatus, (state) => state.user);
export const selectLoggedIn = createSelector(selectUser, Boolean);
export const selectLoginPageError = createSelector(
  selectLoginPage,
  (state) => state.error
);
export const selectLoginPagePending = createSelector(
  selectLoginPage,
  (state) => state.pending
);
