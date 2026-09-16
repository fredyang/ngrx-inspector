import { inject } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { asyncScheduler, defer, EMPTY, of, SchedulerLike } from 'rxjs';
import {
  catchError,
  debounceTime,
  map,
  mergeMap,
  skip,
  switchMap,
  takeUntil,
} from 'rxjs/operators';

import {
  BooksApiEvents,
  CollectionApiEvents,
  CollectionPageEvents,
  FindBookPageEvents,
  SelectedBookPageEvents,
} from './books.events';
import { BookStorageService } from '../../core/services/book-storage.service';
import { GoogleBooksService } from '../../core/services/google-books.service';

const search = createEffect(
  (
    actions$ = inject(Actions),
    googleBooks = inject(GoogleBooksService),
    debounce = 300,
    scheduler: SchedulerLike = asyncScheduler
  ) =>
    actions$.pipe(
      ofType(FindBookPageEvents.searchBooks),
      debounceTime(debounce, scheduler),
      switchMap(({ query }) => {
        if (query === '') {
          return EMPTY;
        }

        const nextSearch$ = actions$.pipe(
          ofType(FindBookPageEvents.searchBooks),
          skip(1)
        );

        return googleBooks.searchBooks(query).pipe(
          takeUntil(nextSearch$),
          map((books) => BooksApiEvents.searchSuccess({ books })),
          catchError((error) =>
            of(BooksApiEvents.searchFailure({ errorMsg: error.message }))
          )
        );
      })
    ),
  { functional: true }
);

export const bookEffects = { search };

const checkStorageSupport = createEffect(
  (storageService = inject(BookStorageService)) =>
    defer(() => storageService.supported()),
  { functional: true, dispatch: false }
);

const loadCollection = createEffect(
  (actions$ = inject(Actions), storageService = inject(BookStorageService)) =>
    actions$.pipe(
      ofType(CollectionPageEvents.enter),
      switchMap(() =>
        storageService.getCollection().pipe(
          map((books) => CollectionApiEvents.loadBooksSuccess({ books })),
          catchError((error) =>
            of(CollectionApiEvents.loadBooksFailure({ error }))
          )
        )
      )
    ),
  { functional: true }
);

const addBookToCollection = createEffect(
  (actions$ = inject(Actions), storageService = inject(BookStorageService)) =>
    actions$.pipe(
      ofType(SelectedBookPageEvents.addBook),
      mergeMap(({ book }) =>
        storageService.addToCollection([book]).pipe(
          map(() => CollectionApiEvents.addBookSuccess({ book })),
          catchError(() => of(CollectionApiEvents.addBookFailure({ book })))
        )
      )
    ),
  { functional: true }
);

const removeBookFromCollection = createEffect(
  (actions$ = inject(Actions), storageService = inject(BookStorageService)) =>
    actions$.pipe(
      ofType(SelectedBookPageEvents.removeBook),
      mergeMap(({ book }) =>
        storageService.removeFromCollection([book.id]).pipe(
          map(() => CollectionApiEvents.removeBookSuccess({ book })),
          catchError(() => of(CollectionApiEvents.removeBookFailure({ book })))
        )
      )
    ),
  { functional: true }
);

export const collectionEffects = {
  checkStorageSupport,
  loadCollection,
  addBookToCollection,
  removeBookFromCollection,
};
