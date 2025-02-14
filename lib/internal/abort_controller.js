'use strict';

// Modeled very closely on the AbortController implementation
// in https://github.com/mysticatea/abort-controller (MIT license)

const {
  ObjectAssign,
  ObjectDefineProperties,
  ObjectSetPrototypeOf,
  ObjectDefineProperty,
  PromiseResolve,
  SafeFinalizationRegistry,
  SafeSet,
  Symbol,
  SymbolToStringTag,
  WeakRef,
} = primordials;

const {
  defineEventHandler,
  EventTarget,
  Event,
  kTrustEvent,
  kNewListener,
  kRemoveListener,
  kWeakHandler,
} = require('internal/event_target');
const {
  createDeferredPromise,
  customInspectSymbol,
  kEmptyObject,
  kEnumerableProperty,
} = require('internal/util');
const { inspect } = require('internal/util/inspect');
const {
  codes: {
    ERR_ILLEGAL_CONSTRUCTOR,
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_THIS,
  }
} = require('internal/errors');

const {
  validateAbortSignal,
  validateObject,
  validateUint32,
} = require('internal/validators');

const {
  DOMException,
} = internalBinding('messaging');

const {
  clearTimeout,
  setTimeout,
} = require('timers');

const {
  messaging_deserialize_symbol: kDeserialize,
  messaging_transfer_symbol: kTransfer,
  messaging_transfer_list_symbol: kTransferList
} = internalBinding('symbols');

let _MessageChannel;
let makeTransferable;

// Loading the MessageChannel and makeTransferable have to be done lazily
// because otherwise we'll end up with a require cycle that ends up with
// an incomplete initialization of abort_controller.

function lazyMessageChannel() {
  _MessageChannel ??= require('internal/worker/io').MessageChannel;
  return new _MessageChannel();
}

function lazyMakeTransferable(obj) {
  makeTransferable ??=
    require('internal/worker/js_transferable').makeTransferable;
  return makeTransferable(obj);
}

const clearTimeoutRegistry = new SafeFinalizationRegistry(clearTimeout);
const timeOutSignals = new SafeSet();

const kAborted = Symbol('kAborted');
const kReason = Symbol('kReason');
const kCloneData = Symbol('kCloneData');
const kTimeout = Symbol('kTimeout');
const kMakeTransferable = Symbol('kMakeTransferable');

function customInspect(self, obj, depth, options) {
  if (depth < 0)
    return self;

  const opts = ObjectAssign({}, options, {
    depth: options.depth === null ? null : options.depth - 1
  });

  return `${self.constructor.name} ${inspect(obj, opts)}`;
}

function validateThisAbortSignal(obj) {
  if (obj?.[kAborted] === undefined)
    throw new ERR_INVALID_THIS('AbortSignal');
}

// Because the AbortSignal timeout cannot be canceled, we don't want the
// presence of the timer alone to keep the AbortSignal from being garbage
// collected if it otherwise no longer accessible. We also don't want the
// timer to keep the Node.js process open on it's own. Therefore, we wrap
// the AbortSignal in a WeakRef and have the setTimeout callback close
// over the WeakRef rather than directly over the AbortSignal, and we unref
// the created timer object. Separately, we add the signal to a
// FinalizerRegistry that will clear the timeout when the signal is gc'd.
function setWeakAbortSignalTimeout(weakRef, delay) {
  const timeout = setTimeout(() => {
    const signal = weakRef.deref();
    if (signal !== undefined) {
      timeOutSignals.delete(signal);
      abortSignal(
        signal,
        new DOMException(
          'The operation was aborted due to timeout',
          'TimeoutError'));
    }
  }, delay);
  timeout.unref();
  return timeout;
}

class AbortSignal extends EventTarget {
  constructor() {
    throw new ERR_ILLEGAL_CONSTRUCTOR();
  }

  /**
   * @type {boolean}
   */
  get aborted() {
    validateThisAbortSignal(this);
    return !!this[kAborted];
  }

  /**
   * @type {any}
   */
  get reason() {
    validateThisAbortSignal(this);
    return this[kReason];
  }

  throwIfAborted() {
    if (this.aborted) {
      throw this.reason;
    }
  }

  [customInspectSymbol](depth, options) {
    return customInspect(this, {
      aborted: this.aborted
    }, depth, options);
  }

  /**
   * @param {any} reason
   * @returns {AbortSignal}
   */
  static abort(
    reason = new DOMException('This operation was aborted', 'AbortError')) {
    return createAbortSignal({ aborted: true, reason });
  }

  /**
   * @param {number} delay
   * @returns {AbortSignal}
   */
  static timeout(delay) {
    validateUint32(delay, 'delay', false);
    const signal = createAbortSignal();
    signal[kTimeout] = true;
    clearTimeoutRegistry.register(
      signal,
      setWeakAbortSignalTimeout(new WeakRef(signal), delay));
    return signal;
  }

  [kNewListener](size, type, listener, once, capture, passive, weak) {
    super[kNewListener](size, type, listener, once, capture, passive, weak);
    if (this[kTimeout] &&
        type === 'abort' &&
        !this.aborted &&
        !weak &&
        size === 1) {
      // If this is a timeout signal, and we're adding a non-weak abort
      // listener, then we don't want it to be gc'd while the listener
      // is attached and the timer still hasn't fired. So, we retain a
      // strong ref that is held for as long as the listener is registered.
      timeOutSignals.add(this);
    }
  }

  [kRemoveListener](size, type, listener, capture) {
    super[kRemoveListener](size, type, listener, capture);
    if (this[kTimeout] && type === 'abort' && size === 0) {
      timeOutSignals.delete(this);
    }
  }

  [kTransfer]() {
    validateThisAbortSignal(this);
    const aborted = this.aborted;
    if (aborted) {
      const reason = this.reason;
      return {
        data: { aborted, reason },
        deserializeInfo: 'internal/abort_controller:ClonedAbortSignal',
      };
    }

    const { port1, port2 } = this[kCloneData];
    this[kCloneData] = undefined;

    this.addEventListener('abort', () => {
      port1.postMessage(this.reason);
      port1.close();
    }, { once: true });

    return {
      data: { port: port2 },
      deserializeInfo: 'internal/abort_controller:ClonedAbortSignal',
    };
  }

  [kTransferList]() {
    if (!this.aborted) {
      const { port1, port2 } = lazyMessageChannel();
      port1.unref();
      port2.unref();
      this[kCloneData] = {
        port1,
        port2,
      };
      return [port2];
    }
    return [];
  }

  [kDeserialize]({ aborted, reason, port }) {
    if (aborted) {
      this[kAborted] = aborted;
      this[kReason] = reason;
      return;
    }

    port.onmessage = ({ data }) => {
      abortSignal(this, data);
      port.close();
      port.onmessage = undefined;
    };
    // The receiving port, by itself, should never keep the event loop open.
    // The unref() has to be called *after* setting the onmessage handler.
    port.unref();
  }
}

function ClonedAbortSignal() {
  return createAbortSignal({ transferable: true });
}
ClonedAbortSignal.prototype[kDeserialize] = () => {};

ObjectDefineProperties(AbortSignal.prototype, {
  aborted: kEnumerableProperty,
});

ObjectDefineProperty(AbortSignal.prototype, SymbolToStringTag, {
  __proto__: null,
  writable: false,
  enumerable: false,
  configurable: true,
  value: 'AbortSignal',
});

defineEventHandler(AbortSignal.prototype, 'abort');

/**
 * @param {{
 *   aborted? : boolean,
 *   reason? : any,
 *   transferable? : boolean
 * }} [init]
 * @returns {AbortSignal}
 */
function createAbortSignal(init = kEmptyObject) {
  const {
    aborted = false,
    reason = undefined,
    transferable = false,
  } = init;
  const signal = new EventTarget();
  ObjectSetPrototypeOf(signal, AbortSignal.prototype);
  signal[kAborted] = aborted;
  signal[kReason] = reason;
  return transferable ? lazyMakeTransferable(signal) : signal;
}

function abortSignal(signal, reason) {
  if (signal[kAborted]) return;
  signal[kAborted] = true;
  signal[kReason] = reason;
  const event = new Event('abort', {
    [kTrustEvent]: true
  });
  signal.dispatchEvent(event);
}

class AbortController {
  #signal;

  /**
   * @type {AbortSignal}
   */
  get signal() {
    this.#signal ??= createAbortSignal();
    return this.#signal;
  }

  /**
   * @param {any} reason
   */
  abort(reason = new DOMException('This operation was aborted', 'AbortError')) {
    abortSignal(this.#signal ??= createAbortSignal(), reason);
  }

  [customInspectSymbol](depth, options) {
    return customInspect(this, {
      signal: this.signal
    }, depth, options);
  }

  static [kMakeTransferable]() {
    const controller = new AbortController();
    controller.#signal = createAbortSignal({ transferable: true });
    return controller;
  }
}

/**
 * Enables the AbortSignal to be transferable using structuredClone/postMessage.
 * @param {AbortSignal} signal
 * @returns {AbortSignal}
 */
function transferableAbortSignal(signal) {
  if (signal?.[kAborted] === undefined)
    throw new ERR_INVALID_ARG_TYPE('signal', 'AbortSignal', signal);
  return lazyMakeTransferable(signal);
}

/**
 * Creates an AbortController with a transferable AbortSignal
 */
function transferableAbortController() {
  return AbortController[kMakeTransferable]();
}

/**
 * @param {AbortSignal} signal
 * @param {any} resource
 * @returns {Promise<void>}
 */
async function aborted(signal, resource) {
  if (signal === undefined) {
    throw new ERR_INVALID_ARG_TYPE('signal', 'AbortSignal', signal);
  }
  validateAbortSignal(signal, 'signal');
  validateObject(resource, 'resource', { nullable: false, allowFunction: true, allowArray: true });
  if (signal.aborted)
    return PromiseResolve();
  const abortPromise = createDeferredPromise();
  signal.addEventListener('abort', abortPromise.resolve, { [kWeakHandler]: resource, once: true });
  return abortPromise.promise;
}

ObjectDefineProperties(AbortController.prototype, {
  signal: kEnumerableProperty,
  abort: kEnumerableProperty,
});

ObjectDefineProperty(AbortController.prototype, SymbolToStringTag, {
  __proto__: null,
  writable: false,
  enumerable: false,
  configurable: true,
  value: 'AbortController',
});

module.exports = {
  kAborted,
  AbortController,
  AbortSignal,
  ClonedAbortSignal,
  aborted,
  transferableAbortSignal,
  transferableAbortController,
};
