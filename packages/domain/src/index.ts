/**
 * @truevine/domain — pure business domain model.
 *
 * This package holds rules and value objects only. It performs no I/O, imports
 * no provider SDK, and never imports from `apps/*` (AGENTS.md 2).
 */

export {
  UGX,
  MoneyError,
  money,
  moneyFromDecimalString,
  minorUnitScale,
  add,
  subtract,
  multiply,
  isZero,
  isCredit,
  isDebit,
  compare,
  equals,
  type Money,
  type CurrencyCode,
  type MinorUnits,
} from './money.js';

export {
  E164_MAX_DIGITS,
  PhoneNumberError,
  parsePhoneNumber,
  isPhoneNumber,
  countryCallingCode,
  type PhoneNumber,
} from './phone-number.js';

export {
  CALL_TRANSITIONS,
  TERMINAL_STATES,
  CallStateError,
  isTerminal,
  transition,
  canTransition,
  type CallState,
  type TransitionResult,
} from './call-state.js';

export {
  CallError,
  parseIdempotencyKey,
  newCall,
  applyState,
  recordProviderUsage,
  computeBillableUsage,
  withBillableUsage,
  zeroChargeLike,
  unusedAuthorization,
  type Call,
  type ProviderUsage,
  type BillableUsage,
  type IdempotencyKey,
  type NewCallInput,
} from './call.js';
