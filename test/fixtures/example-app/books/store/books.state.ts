import { createEntityAdapter, EntityState } from '@ngrx/entity';
import {
  Action,
  combineReducers,
  createFeatureSelector,
  createReducer,
  createSelector,
  on,
} from '@ngrx/store';

import type { State as AppState } from '../../core/store/core.state';
import type { Book } from '../models/book';
import {
  BookEvents,
  BooksApiEvents,
  CollectionApiEvents,
  CollectionPageEvents,
  FindBookPageEvents,
  SelectedBookPageEvents,
  ViewBookPageEvents,
} from './books.events';

export interface EntityBooksState extends EntityState<Book> {
  selectedBookId: string | null;
}

interface SearchState {
  ids: string[];
  loading: boolean;
  error: string;
  query: string;
}

interface CollectionState {
  loaded: boolean;
  loading: boolean;
  ids: string[];
}

export interface BooksState {
  search: SearchState;
  books: EntityBooksState;
  collection: CollectionState;
}

export interface State extends AppState {
  books: BooksState;
}

const booksFeatureKey = 'books';

export const bookAdapter = createEntityAdapter<Book>();
export const initialBooksState = bookAdapter.getInitialState<EntityBooksState>({
  selectedBookId: null,
});

const booksReducer = createReducer(
  initialBooksState,
  on(
    BooksApiEvents.searchSuccess,
    CollectionApiEvents.loadBooksSuccess,
    (state, { books }) => bookAdapter.addMany(books, state)
  ),
  on(BookEvents.loadBook, (state, { book }) => bookAdapter.addOne(book, state)),
  on(ViewBookPageEvents.selectBook, (state, { id }) => ({
    ...state,
    selectedBookId: id,
  }))
);

const searchReducer = createReducer(
  { ids: [], loading: false, error: '', query: '' } as SearchState,
  on(FindBookPageEvents.searchBooks, (state, { query }) =>
    query === ''
      ? { ids: [], loading: false, error: '', query }
      : { ...state, loading: true, error: '', query }
  ),
  on(BooksApiEvents.searchSuccess, (state, { books }) => ({
    ids: books.map((book) => book.id),
    loading: false,
    error: '',
    query: state.query,
  })),
  on(BooksApiEvents.searchFailure, (state, { errorMsg }) => ({
    ...state,
    loading: false,
    error: errorMsg,
  }))
);

const collectionReducer = createReducer(
  { loaded: false, loading: false, ids: [] } as CollectionState,
  on(CollectionPageEvents.enter, (state) => ({ ...state, loading: true })),
  on(CollectionApiEvents.loadBooksSuccess, (_state, { books }) => ({
    loaded: true,
    loading: false,
    ids: books.map((book) => book.id),
  })),
  on(
    SelectedBookPageEvents.addBook,
    CollectionApiEvents.removeBookFailure,
    (state, { book }) =>
      state.ids.includes(book.id)
        ? state
        : { ...state, ids: [...state.ids, book.id] }
  ),
  on(
    SelectedBookPageEvents.removeBook,
    CollectionApiEvents.addBookFailure,
    (state, { book }) => ({
      ...state,
      ids: state.ids.filter((id) => id !== book.id),
    })
  )
);

function reducer(state: BooksState | undefined, action: Action) {
  return combineReducers({
    search: searchReducer,
    books: booksReducer,
    collection: collectionReducer,
  })(state, action);
}

export const featureSlice = {
  name: booksFeatureKey,
  reducer: reducer,
};

const selectBooksState = createFeatureSelector<BooksState>(booksFeatureKey);
const selectBookEntitiesState = createSelector(
  selectBooksState,
  (state) => state.books
);
const selectSearchState = createSelector(
  selectBooksState,
  (state) => state.search
);
const selectCollectionState = createSelector(
  selectBooksState,
  (state) => state.collection
);

export const selectSelectedBookId = createSelector(
  selectBookEntitiesState,
  (state) => state.selectedBookId
);

export const selectBookEntities = bookAdapter.getSelectors(
  selectBookEntitiesState
).selectEntities;

export const selectSelectedBook = createSelector(
  selectBookEntities,
  selectSelectedBookId,
  (entities, id) => id && entities[id]
);
export const selectSearchQuery = createSelector(
  selectSearchState,
  (state) => state.query
);
export const selectSearchLoading = createSelector(
  selectSearchState,
  (state) => state.loading
);
export const selectSearchError = createSelector(
  selectSearchState,
  (state) => state.error
);
export const selectSearchResults = createSelector(
  selectBookEntities,
  selectSearchState,
  (entities, search) =>
    search.ids
      .map((id) => entities[id])
      .filter((book): book is Book => book !== undefined)
);
export const selectCollectionLoaded = createSelector(
  selectCollectionState,
  (state) => state.loaded
);
export const selectCollectionBookIds = createSelector(
  selectCollectionState,
  (state) => state.ids
);
export const selectBookCollection = createSelector(
  selectBookEntities,
  selectCollectionBookIds,
  (entities, ids) =>
    ids
      .map((id) => entities[id])
      .filter((book): book is Book => book !== undefined)
);
export const isSelectedBookInCollection = createSelector(
  selectCollectionBookIds,
  selectSelectedBookId,
  (ids, selected) => !!selected && ids.includes(selected)
);
