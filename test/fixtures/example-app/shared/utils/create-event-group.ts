import { createAction } from '@ngrx/store';
import type {
  Action,
  ActionCreator,
  ActionCreatorProps,
  Creator,
  NotAllowedCheck,
} from '@ngrx/store';

type LowerLetter =
  | 'a'
  | 'b'
  | 'c'
  | 'd'
  | 'e'
  | 'f'
  | 'g'
  | 'h'
  | 'i'
  | 'j'
  | 'k'
  | 'l'
  | 'm'
  | 'n'
  | 'o'
  | 'p'
  | 'q'
  | 'r'
  | 's'
  | 't'
  | 'u'
  | 'v'
  | 'w'
  | 'x'
  | 'y'
  | 'z';
type UpperLetter = Uppercase<LowerLetter>;
type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

type EventConfig = ActionCreatorProps<unknown> | Creator;

type StringLiteralCheck<
  Text extends string,
  Name extends string,
> = string extends Text ? `${Name} must be a string literal type` : unknown;

type Alphanumeric<Text extends string> =
  Text extends `${LowerLetter | UpperLetter | Digit}${infer Rest}`
    ? Alphanumeric<Rest>
    : Text extends ''
      ? true
      : false;

type EventKeyCheck<Key extends string> = string extends Key
  ? unknown
  : Key extends `${LowerLetter}${infer Rest}`
    ? Alphanumeric<Rest> extends true
      ? unknown
      : 'event key must contain only ASCII letters and digits'
    : 'event key must start with a lowercase ASCII letter';

// Split before capitals after lowercase letters/digits, and before the final
// capital of an acronym when a lowercase word follows: loadHTTPError -> Load HTTP Error.
type Words<
  Text extends string,
  Previous extends string = '',
> = Text extends `${infer First}${infer Rest}`
  ? `${First extends UpperLetter
      ? Previous extends LowerLetter | Digit
        ? ' '
        : Previous extends UpperLetter
          ? Rest extends `${LowerLetter}${string}`
            ? ' '
            : ''
          : ''
      : ''}${First}${Words<Rest, First>}`
  : '';

type EventLabel<Key extends string> = Capitalize<Words<Key>>;

type EventPropsCheck<Config extends EventConfig> =
  Config extends ActionCreatorProps<infer Payload>
    ? Payload extends void
      ? unknown
      : NotAllowedCheck<Payload & object>
    : Config extends Creator<any, infer Result>
      ? NotAllowedCheck<Result>
      : unknown;

type EventCreator<Config extends EventConfig, Type extends string> =
  Config extends ActionCreatorProps<infer Payload>
    ? void extends Payload
      ? ActionCreator<Type, () => Action<Type>>
      : ActionCreator<
          Type,
          (
            props: Payload & NotAllowedCheck<Payload & object>
          ) => Payload & Action<Type>
        >
    : Config extends Creator<infer Args, infer Result>
      ? ActionCreator<
          Type,
          (...args: Args) => Result & NotAllowedCheck<Result> & Action<Type>
        >
      : never;

type EventGroupConfig<Events extends Record<string, EventConfig>> = Events & {
  [Key in keyof Events]: StringLiteralCheck<Key & string, 'event key'> &
    EventKeyCheck<Key & string> &
    EventPropsCheck<Events[Key]>;
};

type EventGroup<
  Source extends string,
  Events extends Record<string, EventConfig>,
> = {
  [Key in keyof Events]: EventCreator<
    Events[Key],
    `[${Source}] ${EventLabel<Key & string>}`
  >;
};

/**
 * Creates an event factory with a shared source, unchanged camelCase keys, and
 * readable action type labels.
 * Keys must start with a lowercase ASCII letter and contain only letters/digits.
 * Acronyms are preserved: loadHTTPError becomes "Load HTTP Error".
 * Supports props(), emptyProps(), and payload creator functions, like NgRx.
 * Explicitly type creator parameters, including parameters with default values.
 */
export function createEventSource<const Source extends string>(
  source: Source & StringLiteralCheck<Source, 'source'>
): EventSource<Source> {
  return {
    createEventGroup: (events: Record<string, EventConfig>) =>
      createEventGroupFromSource(source, events as any),
    createEvent: (eventKey: string, eventConfig?: EventConfig) =>
      eventConfig === undefined
        ? createEvent(source, eventKey)
        : createEvent(source, eventKey, eventConfig),
  } as EventSource<Source>;
}

/** Creates a group of events with a shared source and unchanged camelCase keys. */
export function createEventGroup<
  const Source extends string,
  Events extends Record<string, EventConfig>,
>(
  source: Source & StringLiteralCheck<Source, 'source'>,
  events: EventGroupConfig<Events>
): EventGroup<Source, Events> {
  return createEventGroupFromSource(source, events);
}

interface EventSource<Source extends string> {
  createEventGroup<Events extends Record<string, EventConfig>>(
    events: EventGroupConfig<Events>
  ): EventGroup<Source, Events>;
  createEvent<Key extends string>(
    eventKey: Key & StringLiteralCheck<Key, 'event key'> & EventKeyCheck<Key>
  ): ActionCreator<`[${Source}] ${EventLabel<Key>}`, () => Action>;
  createEvent<Key extends string, Config extends EventConfig>(
    eventKey: Key & StringLiteralCheck<Key, 'event key'> & EventKeyCheck<Key>,
    eventConfig: Config & EventPropsCheck<Config>
  ): EventCreator<Config, `[${Source}] ${EventLabel<Key>}`>;
}

function createEventGroupFromSource<
  const Source extends string,
  Events extends Record<string, EventConfig>,
>(
  source: Source,
  events: EventGroupConfig<Events>
): EventGroup<Source, Events> {
  const entries = Object.entries(events);

  return Object.fromEntries(
    entries.map(([eventKey, eventConfig]) => [
      eventKey,
      createEvent(source, eventKey, eventConfig),
    ])
  ) as EventGroup<Source, Events>;
}

function createEvent<Source extends string, Key extends string>(
  source: Source,
  eventKey: Key
): ActionCreator<`[${Source}] ${EventLabel<Key>}`, () => Action>;
function createEvent<
  Source extends string,
  Key extends string,
  Config extends EventConfig,
>(
  source: Source,
  eventKey: Key,
  eventConfig: Config
): EventCreator<Config, `[${Source}] ${EventLabel<Key>}`>;
function createEvent(
  source: string,
  eventKey: string,
  eventConfig?: EventConfig
) {
  validateEventKey(eventKey);
  const type = `[${source}] ${toEventLabel(eventKey)}`;

  return eventConfig === undefined
    ? createAction(type)
    : createAction(type, eventConfig as any);
}

function validateEventKey(eventKey: string) {
  if (!/^[a-z][a-zA-Z0-9]*$/.test(eventKey)) {
    throw new Error(
      `Invalid event key "${eventKey}": expected camelCase ASCII letters and digits.`
    );
  }
}

function toEventLabel(eventKey: string): string {
  // Keep this conversion in sync with Words: loginSuccess -> Login Success,
  // loadHTTPError -> Load HTTP Error, version2Ready -> Version2 Ready.
  return eventKey
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (letter) => letter.toUpperCase());
}
