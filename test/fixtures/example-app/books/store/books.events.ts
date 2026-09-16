import { emptyProps, props } from '@ngrx/store';
import { createEventGroup } from '../../shared/utils/create-event-group';

import type { Book } from '../models/book';

export const BookEvents = createEventGroup('Book Exists Guard', {
  loadBook: props<{ book: Book }>(),
});

export const BooksApiEvents = createEventGroup('Books/API', {
  searchSuccess: props<{ books: Book[] }>(),
  searchFailure: props<{ errorMsg: string }>(),
});

export const CollectionApiEvents = createEventGroup('Collection/API', {
  addBookSuccess: props<{ book: Book }>(),
  addBookFailure: props<{ book: Book }>(),
  removeBookSuccess: props<{ book: Book }>(),
  removeBookFailure: props<{ book: Book }>(),
  loadBooksSuccess: props<{ books: Book[] }>(),
  loadBooksFailure: props<{ error: unknown }>(),
});

export const CollectionPageEvents = createEventGroup('Collection Page', {
  enter: emptyProps(),
});

export const FindBookPageEvents = createEventGroup('Find Book Page', {
  searchBooks: props<{ query: string }>(),
});

export const SelectedBookPageEvents = createEventGroup('Selected Book Page', {
  addBook: props<{ book: Book }>(),
  removeBook: props<{ book: Book }>(),
});

export const ViewBookPageEvents = createEventGroup('View Book Page', {
  selectBook: props<{ id: string }>(),
});
