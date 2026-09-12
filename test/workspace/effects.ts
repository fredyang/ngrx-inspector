import { createEffect, ofType } from '@ngrx/effects';
import { of } from 'rxjs';
import { Events } from './events';

// The extension-host test finds these declarations through TypeScript references.
const loginEffect = ofType(Events.login);
const publishLogin = createEffect(() => of(Events.login()));
