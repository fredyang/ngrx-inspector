import { ofType } from '@ngrx/effects';
import { Events } from './events';

const testEffect = ofType(Events.login);
