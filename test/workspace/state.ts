import { on } from '@ngrx/store';
import { Events } from './events';

const loginReducer = on(Events.login, (state: unknown) => state);
