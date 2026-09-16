import { isDevMode } from '@angular/core';
import { ActionReducer, ActionReducerMap, MetaReducer } from '@ngrx/store';
import { routerReducer, RouterReducerState } from '@ngrx/router-store';

export interface State {
  router: RouterReducerState;
}

export const rootReducers: ActionReducerMap<State> = {
  router: routerReducer,
};

function logger(reducer: ActionReducer<State>): ActionReducer<State> {
  return (state, action) => {
    const result = reducer(state, action);
    console.groupCollapsed(action.type);
    console.log('prev state', state);
    console.log('action', action);
    console.log('next state', result);
    console.groupEnd();
    return result;
  };
}

export const metaReducers: MetaReducer[] = isDevMode() ? [logger] : [];
