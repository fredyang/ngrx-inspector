import { emptyProps } from '@ngrx/store';
import { createEventGroup } from '../../shared/utils/create-event-group';

export const UserEvents = createEventGroup('User', {
  idleTimeout: emptyProps(),
});
