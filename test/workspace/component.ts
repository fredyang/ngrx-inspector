import { Events } from './events';
import { Store } from '@ngrx/store';

declare const store: Store;
store.dispatch(Events.login());
