import assert from '../stub/assert';
import {
  CreateAlgorithmFromUnderlyingMethod,
  InvokeOrNoop,
  IsNonNegativeNumber,
  MakeSizeAlgorithmFromSizeFunction,
  newPromise,
  promiseRejectedWith,
  promiseResolvedWith,
  setPromiseIsHandledToTrue,
  typeIsObject,
  uponPromise,
  ValidateAndNormalizeHighWaterMark
} from './helpers';
import { DequeueValue, EnqueueValueWithSize, PeekQueueValue, QueuePair, ResetQueue } from './queue-with-sizes';
import { QueuingStrategy, QueuingStrategySizeCallback } from './queuing-strategy';
import { SimpleQueue } from './simple-queue';

const AbortSteps = Symbol('[[AbortSteps]]');
const ErrorSteps = Symbol('[[ErrorSteps]]');

type WritableStreamDefaultControllerStartCallback
  = (controller: WritableStreamDefaultControllerType) => void | PromiseLike<void>;
type WritableStreamDefaultControllerWriteCallback<W>
  = (chunk: W, controller: WritableStreamDefaultControllerType) => void | PromiseLike<void>;
type WritableStreamDefaultControllerCloseCallback = () => void | PromiseLike<void>;
type WritableStreamErrorCallback = (reason: any) => void | PromiseLike<void>;

/** @public */
export interface UnderlyingSink<W = any> {
  /**
   * A function that is called immediately during creation of the {@link WritableStream}.
   */
  start?: WritableStreamDefaultControllerStartCallback;
  /**
   * A function that is called when a new chunk of data is ready to be written to the underlying sink.
   */
  write?: WritableStreamDefaultControllerWriteCallback<W>;
  /**
   * A function that is called after the producer signals, via `writer.close()`,
   * that they are done writing chunks to the stream, and subsequently all queued-up writes have successfully completed.
   */
  close?: WritableStreamDefaultControllerCloseCallback;
  /**
   * A function that is called after the producer signals, via {@link WritableStream.abort | stream.abort()} or
   * `writer.abort()`, that they wish to abort the stream.
   * It takes as its argument the same value as was passed to those methods by the producer.
   */
  abort?: WritableStreamErrorCallback;
  type?: undefined;
}

type WritableStreamState = 'writable' | 'closed' | 'erroring' | 'errored';

interface WriteOrCloseRequest {
  _resolve: (value?: undefined) => void;
  _reject: (reason: any) => void;
}

type WriteRequest = WriteOrCloseRequest;
type CloseRequest = WriteOrCloseRequest;

interface PendingAbortRequest {
  _promise: Promise<void>;
  _resolve: () => void;
  _reject: (reason: any) => void;
  _reason: any;
  _wasAlreadyErroring: boolean;
}

/**
 * A writable stream represents a destination for data, into which you can write.
 *
 * @public
 */
class WritableStream<W = any> {
  /** @internal */
  _state!: WritableStreamState;
  /** @internal */
  _storedError: any;
  /** @internal */
  _writer: WritableStreamDefaultWriter<W> | undefined;
  /** @internal */
  _writableStreamController!: WritableStreamDefaultController<W>;
  /** @internal */
  _writeRequests!: SimpleQueue<WriteRequest>;
  /** @internal */
  _inFlightWriteRequest: WriteRequest | undefined;
  /** @internal */
  _closeRequest: CloseRequest | undefined;
  /** @internal */
  _inFlightCloseRequest: CloseRequest | undefined;
  /** @internal */
  _pendingAbortRequest: PendingAbortRequest | undefined;
  /** @internal */
  _backpressure!: boolean;

  constructor(underlyingSink: UnderlyingSink<W> = {}, strategy: QueuingStrategy<W> = {}) {
    InitializeWritableStream(this);

    const size = strategy.size;
    let highWaterMark = strategy.highWaterMark;

    const type = underlyingSink.type;

    if (type !== undefined) {
      throw new RangeError('Invalid type is specified');
    }

    const sizeAlgorithm = MakeSizeAlgorithmFromSizeFunction(size);
    if (highWaterMark === undefined) {
      highWaterMark = 1;
    }
    highWaterMark = ValidateAndNormalizeHighWaterMark(highWaterMark);

    SetUpWritableStreamDefaultControllerFromUnderlyingSink(this, underlyingSink, highWaterMark, sizeAlgorithm);
  }

  /**
   * Whether or not the writable stream is locked to a {@link WritableStreamDefaultWriter | writer}.
   */
  get locked(): boolean {
    if (IsWritableStream(this) === false) {
      throw streamBrandCheckException('locked');
    }

    return IsWritableStreamLocked(this);
  }

  /**
   * Aborts the stream, signaling that the producer can no longer successfully write to the stream
   * and it is to be immediately moved to an errored state, with any queued-up writes discarded.
   *
   * This will also execute any {@link UnderlyingSink.abort | abort} mechanism of the underlying sink.
   */
  abort(reason: any): Promise<void> {
    if (IsWritableStream(this) === false) {
      return promiseRejectedWith(streamBrandCheckException('abort'));
    }

    if (IsWritableStreamLocked(this) === true) {
      return promiseRejectedWith(new TypeError('Cannot abort a stream that already has a writer'));
    }

    return WritableStreamAbort(this, reason);
  }

  /**
   * Closes the stream. The underlying sink will finish processing any previously-written chunks,
   * before invoking its close behavior. During this time any further attempts to write will fail
   * (without erroring the stream).
   *
   * The method returns a promise that is fulfilled with `undefined` if all remaining chunks are successfully written
   * and the stream successfully closes, or rejects if an error is encountered during this process.
   */
  close() {
    if (IsWritableStream(this) === false) {
      return promiseRejectedWith(streamBrandCheckException('close'));
    }

    if (IsWritableStreamLocked(this) === true) {
      return promiseRejectedWith(new TypeError('Cannot close a stream that already has a writer'));
    }

    if (WritableStreamCloseQueuedOrInFlight(this) === true) {
      return promiseRejectedWith(new TypeError('Cannot close an already-closing stream'));
    }

    return WritableStreamClose(this);
  }

  /**
   * Creates a {@link WritableStreamDefaultWriter | writer} and locks the stream to the new writer.
   * While the stream is locked, no other writer can be acquired until this one is released.
   *
   * This functionality is especially useful for creating abstractions that desire the ability to write to a stream
   * without interruption or interleaving. By getting a writer for the stream, you can ensure nobody else can write
   * at the same time, which would cause the resulting written data to be unpredictable and probably useless.
   */
  getWriter(): WritableStreamDefaultWriter<W> {
    if (IsWritableStream(this) === false) {
      throw streamBrandCheckException('getWriter');
    }

    return AcquireWritableStreamDefaultWriter(this);
  }
}

export {
  AcquireWritableStreamDefaultWriter,
  CreateWritableStream,
  IsWritableStream,
  IsWritableStreamLocked,
  WritableStream,
  WritableStreamAbort,
  WritableStreamDefaultControllerErrorIfNeeded,
  WritableStreamDefaultWriterCloseWithErrorPropagation,
  WritableStreamDefaultWriterRelease,
  WritableStreamDefaultWriterWrite,
  WritableStreamCloseQueuedOrInFlight
};

// Abstract operations for the WritableStream.

function AcquireWritableStreamDefaultWriter<W>(stream: WritableStream<W>): WritableStreamDefaultWriter<W> {
  return new WritableStreamDefaultWriter(stream);
}

// Throws if and only if startAlgorithm throws.
function CreateWritableStream<W>(startAlgorithm: () => void | PromiseLike<void>,
                                 writeAlgorithm: (chunk: W) => Promise<void>,
                                 closeAlgorithm: () => Promise<void>,
                                 abortAlgorithm: (reason: any) => Promise<void>,
                                 highWaterMark = 1,
                                 sizeAlgorithm: QueuingStrategySizeCallback<W> = () => 1) {
  assert(IsNonNegativeNumber(highWaterMark) === true);

  const stream: WritableStream<W> = Object.create(WritableStream.prototype);
  InitializeWritableStream(stream);

  const controller: WritableStreamDefaultController<W> = Object.create(WritableStreamDefaultController.prototype);

  SetUpWritableStreamDefaultController(stream, controller, startAlgorithm, writeAlgorithm, closeAlgorithm,
                                       abortAlgorithm, highWaterMark, sizeAlgorithm);
  return stream;
}

function InitializeWritableStream<W>(stream: WritableStream<W>) {
  stream._state = 'writable';

  // The error that will be reported by new method calls once the state becomes errored. Only set when [[state]] is
  // 'erroring' or 'errored'. May be set to an undefined value.
  stream._storedError = undefined;

  stream._writer = undefined;

  // Initialize to undefined first because the constructor of the controller checks this
  // variable to validate the caller.
  stream._writableStreamController = undefined!;

  // This queue is placed here instead of the writer class in order to allow for passing a writer to the next data
  // producer without waiting for the queued writes to finish.
  stream._writeRequests = new SimpleQueue();

  // Write requests are removed from _writeRequests when write() is called on the underlying sink. This prevents
  // them from being erroneously rejected on error. If a write() call is in-flight, the request is stored here.
  stream._inFlightWriteRequest = undefined;

  // The promise that was returned from writer.close(). Stored here because it may be fulfilled after the writer
  // has been detached.
  stream._closeRequest = undefined;

  // Close request is removed from _closeRequest when close() is called on the underlying sink. This prevents it
  // from being erroneously rejected on error. If a close() call is in-flight, the request is stored here.
  stream._inFlightCloseRequest = undefined;

  // The promise that was returned from writer.abort(). This may also be fulfilled after the writer has detached.
  stream._pendingAbortRequest = undefined;

  // The backpressure signal set by the controller.
  stream._backpressure = false;
}

function IsWritableStream<W>(x: any): x is WritableStream<W> {
  if (!typeIsObject(x)) {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(x, '_writableStreamController')) {
    return false;
  }

  return true;
}

function IsWritableStreamLocked(stream: WritableStream): boolean {
  assert(IsWritableStream(stream) === true);

  if (stream._writer === undefined) {
    return false;
  }

  return true;
}

function WritableStreamAbort(stream: WritableStream, reason: any): Promise<void> {
  const state = stream._state;
  if (state === 'closed' || state === 'errored') {
    return promiseResolvedWith(undefined);
  }
  if (stream._pendingAbortRequest !== undefined) {
    return stream._pendingAbortRequest._promise;
  }

  assert(state === 'writable' || state === 'erroring');

  let wasAlreadyErroring = false;
  if (state === 'erroring') {
    wasAlreadyErroring = true;
    // reason will not be used, so don't keep a reference to it.
    reason = undefined;
  }

  const promise = newPromise<void>((resolve, reject) => {
    stream._pendingAbortRequest = {
      _promise: undefined!,
      _resolve: resolve,
      _reject: reject,
      _reason: reason,
      _wasAlreadyErroring: wasAlreadyErroring
    };
  });
  stream._pendingAbortRequest!._promise = promise;

  if (wasAlreadyErroring === false) {
    WritableStreamStartErroring(stream, reason);
  }

  return promise;
}

function WritableStreamClose(stream: WritableStream<any>): Promise<void> {
  const state = stream._state;
  if (state === 'closed' || state === 'errored') {
    return promiseRejectedWith(new TypeError(
      `The stream (in ${state} state) is not in the writable state and cannot be closed`));
  }

  assert(state === 'writable' || state === 'erroring');
  assert(WritableStreamCloseQueuedOrInFlight(stream) === false);

  const promise = newPromise<void>((resolve, reject) => {
    const closeRequest: CloseRequest = {
      _resolve: resolve,
      _reject: reject
    };

    stream._closeRequest = closeRequest;
  });

  const writer = stream._writer;
  if (writer !== undefined && stream._backpressure === true && state === 'writable') {
    defaultWriterReadyPromiseResolve(writer);
  }

  WritableStreamDefaultControllerClose(stream._writableStreamController);

  return promise;
}

// WritableStream API exposed for controllers.

function WritableStreamAddWriteRequest(stream: WritableStream): Promise<void> {
  assert(IsWritableStreamLocked(stream) === true);
  assert(stream._state === 'writable');

  const promise = newPromise<void>((resolve, reject) => {
    const writeRequest: WriteRequest = {
      _resolve: resolve,
      _reject: reject
    };

    stream._writeRequests.push(writeRequest);
  });

  return promise;
}

function WritableStreamDealWithRejection(stream: WritableStream, error: any) {
  const state = stream._state;

  if (state === 'writable') {
    WritableStreamStartErroring(stream, error);
    return;
  }

  assert(state === 'erroring');
  WritableStreamFinishErroring(stream);
}

function WritableStreamStartErroring(stream: WritableStream, reason: any) {
  assert(stream._storedError === undefined);
  assert(stream._state === 'writable');

  const controller = stream._writableStreamController;
  assert(controller !== undefined);

  stream._state = 'erroring';
  stream._storedError = reason;
  const writer = stream._writer;
  if (writer !== undefined) {
    WritableStreamDefaultWriterEnsureReadyPromiseRejected(writer, reason);
  }

  if (WritableStreamHasOperationMarkedInFlight(stream) === false && controller._started === true) {
    WritableStreamFinishErroring(stream);
  }
}

function WritableStreamFinishErroring(stream: WritableStream) {
  assert(stream._state === 'erroring');
  assert(WritableStreamHasOperationMarkedInFlight(stream) === false);
  stream._state = 'errored';
  stream._writableStreamController[ErrorSteps]();

  const storedError = stream._storedError;
  stream._writeRequests.forEach(writeRequest => {
    writeRequest._reject(storedError);
  });
  stream._writeRequests = new SimpleQueue();

  if (stream._pendingAbortRequest === undefined) {
    WritableStreamRejectCloseAndClosedPromiseIfNeeded(stream);
    return;
  }

  const abortRequest = stream._pendingAbortRequest;
  stream._pendingAbortRequest = undefined;

  if (abortRequest._wasAlreadyErroring === true) {
    abortRequest._reject(storedError);
    WritableStreamRejectCloseAndClosedPromiseIfNeeded(stream);
    return;
  }

  const promise = stream._writableStreamController[AbortSteps](abortRequest._reason);
  uponPromise(
    promise,
    () => {
      abortRequest._resolve();
      WritableStreamRejectCloseAndClosedPromiseIfNeeded(stream);
    },
    (reason: any) => {
      abortRequest._reject(reason);
      WritableStreamRejectCloseAndClosedPromiseIfNeeded(stream);
    });
}

function WritableStreamFinishInFlightWrite(stream: WritableStream) {
  assert(stream._inFlightWriteRequest !== undefined);
  stream._inFlightWriteRequest!._resolve(undefined);
  stream._inFlightWriteRequest = undefined;
}

function WritableStreamFinishInFlightWriteWithError(stream: WritableStream, error: any) {
  assert(stream._inFlightWriteRequest !== undefined);
  stream._inFlightWriteRequest!._reject(error);
  stream._inFlightWriteRequest = undefined;

  assert(stream._state === 'writable' || stream._state === 'erroring');

  WritableStreamDealWithRejection(stream, error);
}

function WritableStreamFinishInFlightClose(stream: WritableStream) {
  assert(stream._inFlightCloseRequest !== undefined);
  stream._inFlightCloseRequest!._resolve(undefined);
  stream._inFlightCloseRequest = undefined;

  const state = stream._state;

  assert(state === 'writable' || state === 'erroring');

  if (state === 'erroring') {
    // The error was too late to do anything, so it is ignored.
    stream._storedError = undefined;
    if (stream._pendingAbortRequest !== undefined) {
      stream._pendingAbortRequest._resolve();
      stream._pendingAbortRequest = undefined;
    }
  }

  stream._state = 'closed';

  const writer = stream._writer;
  if (writer !== undefined) {
    defaultWriterClosedPromiseResolve(writer);
  }

  assert(stream._pendingAbortRequest === undefined);
  assert(stream._storedError === undefined);
}

function WritableStreamFinishInFlightCloseWithError(stream: WritableStream, error: any) {
  assert(stream._inFlightCloseRequest !== undefined);
  stream._inFlightCloseRequest!._reject(error);
  stream._inFlightCloseRequest = undefined;

  assert(stream._state === 'writable' || stream._state === 'erroring');

  // Never execute sink abort() after sink close().
  if (stream._pendingAbortRequest !== undefined) {
    stream._pendingAbortRequest._reject(error);
    stream._pendingAbortRequest = undefined;
  }
  WritableStreamDealWithRejection(stream, error);
}

// TODO(ricea): Fix alphabetical order.
function WritableStreamCloseQueuedOrInFlight(stream: WritableStream): boolean {
  if (stream._closeRequest === undefined && stream._inFlightCloseRequest === undefined) {
    return false;
  }

  return true;
}

function WritableStreamHasOperationMarkedInFlight(stream: WritableStream): boolean {
  if (stream._inFlightWriteRequest === undefined && stream._inFlightCloseRequest === undefined) {
    return false;
  }

  return true;
}

function WritableStreamMarkCloseRequestInFlight(stream: WritableStream) {
  assert(stream._inFlightCloseRequest === undefined);
  assert(stream._closeRequest !== undefined);
  stream._inFlightCloseRequest = stream._closeRequest;
  stream._closeRequest = undefined;
}

function WritableStreamMarkFirstWriteRequestInFlight(stream: WritableStream) {
  assert(stream._inFlightWriteRequest === undefined);
  assert(stream._writeRequests.length !== 0);
  stream._inFlightWriteRequest = stream._writeRequests.shift();
}

function WritableStreamRejectCloseAndClosedPromiseIfNeeded(stream: WritableStream) {
  assert(stream._state === 'errored');
  if (stream._closeRequest !== undefined) {
    assert(stream._inFlightCloseRequest === undefined);

    stream._closeRequest._reject(stream._storedError);
    stream._closeRequest = undefined;
  }
  const writer = stream._writer;
  if (writer !== undefined) {
    defaultWriterClosedPromiseReject(writer, stream._storedError);
  }
}

function WritableStreamUpdateBackpressure(stream: WritableStream, backpressure: boolean) {
  assert(stream._state === 'writable');
  assert(WritableStreamCloseQueuedOrInFlight(stream) === false);

  const writer = stream._writer;
  if (writer !== undefined && backpressure !== stream._backpressure) {
    if (backpressure === true) {
      defaultWriterReadyPromiseReset(writer);
    } else {
      assert(backpressure === false);

      defaultWriterReadyPromiseResolve(writer);
    }
  }

  stream._backpressure = backpressure;
}

/** @public */
export type WritableStreamDefaultWriterType<W> = WritableStreamDefaultWriter<W>;

/** @public */
class WritableStreamDefaultWriter<W> {
  /** @internal */
  _ownerWritableStream: WritableStream<W>;
  /** @internal */
  _closedPromise!: Promise<void>;
  /** @internal */
  _closedPromise_resolve?: (value?: undefined) => void;
  /** @internal */
  _closedPromise_reject?: (reason: any) => void;
  /** @internal */
  _closedPromiseState!: 'pending' | 'resolved' | 'rejected';
  /** @internal */
  _readyPromise!: Promise<void>;
  /** @internal */
  _readyPromise_resolve?: (value?: undefined) => void;
  /** @internal */
  _readyPromise_reject?: (reason: any) => void;
  /** @internal */
  _readyPromiseState!: 'pending' | 'fulfilled' | 'rejected';

  constructor(stream: WritableStream<W>) {
    if (IsWritableStream(stream) === false) {
      throw new TypeError('WritableStreamDefaultWriter can only be constructed with a WritableStream instance');
    }
    if (IsWritableStreamLocked(stream) === true) {
      throw new TypeError('This stream has already been locked for exclusive writing by another writer');
    }

    this._ownerWritableStream = stream;
    stream._writer = this;

    const state = stream._state;

    if (state === 'writable') {
      if (WritableStreamCloseQueuedOrInFlight(stream) === false && stream._backpressure === true) {
        defaultWriterReadyPromiseInitialize(this);
      } else {
        defaultWriterReadyPromiseInitializeAsResolved(this);
      }

      defaultWriterClosedPromiseInitialize(this);
    } else if (state === 'erroring') {
      defaultWriterReadyPromiseInitializeAsRejected(this, stream._storedError);
      defaultWriterClosedPromiseInitialize(this);
    } else if (state === 'closed') {
      defaultWriterReadyPromiseInitializeAsResolved(this);
      defaultWriterClosedPromiseInitializeAsResolved(this);
    } else {
      assert(state === 'errored');

      const storedError = stream._storedError;
      defaultWriterReadyPromiseInitializeAsRejected(this, storedError);
      defaultWriterClosedPromiseInitializeAsRejected(this, storedError);
    }
  }

  /**
   * Returns a promise that will be fulfilled when the stream becomes closed,
   * or rejected if the stream ever errors or the writer’s lock is released before the stream finishes closing.
   */
  get closed(): Promise<void> {
    if (IsWritableStreamDefaultWriter(this) === false) {
      return promiseRejectedWith(defaultWriterBrandCheckException('closed'));
    }

    return this._closedPromise;
  }

  /**
   * Returns the desired size to fill the stream’s internal queue. It can be negative, if the queue is over-full.
   * A producer can use this information to determine the right amount of data to write.
   *
   * It will be null if the stream cannot be successfully written to (due to either being errored, or having
   * an abort queued up). It will return zero if the stream is closed.
   * The getter will throw an exception if invoked when the writer’s lock is {@link releaseLock | released}.
   */
  get desiredSize(): number | null {
    if (IsWritableStreamDefaultWriter(this) === false) {
      throw defaultWriterBrandCheckException('desiredSize');
    }

    if (this._ownerWritableStream === undefined) {
      throw defaultWriterLockException('desiredSize');
    }

    return WritableStreamDefaultWriterGetDesiredSize(this);
  }

  /**
   * Returns a promise that will be fulfilled when the desired size to fill the stream’s internal queue transitions
   * from non-positive to positive, signaling that it is no longer applying backpressure.
   * Once the desired size to fill the stream’s internal queue dips back to zero or below,
   * the getter will return a new promise that stays pending until the next transition.
   *
   * If the stream becomes errored or aborted, or the writer’s lock is {@link releaseLock | released},
   * the returned promise will become rejected.
   */
  get ready(): Promise<void> {
    if (IsWritableStreamDefaultWriter(this) === false) {
      return promiseRejectedWith(defaultWriterBrandCheckException('ready'));
    }

    return this._readyPromise;
  }

  /**
   * If the writer is active, this behaves the same as the {@link WritableStream.abort | abort} method
   * for the associated stream.
   */
  abort(reason: any): Promise<void> {
    if (IsWritableStreamDefaultWriter(this) === false) {
      return promiseRejectedWith(defaultWriterBrandCheckException('abort'));
    }

    if (this._ownerWritableStream === undefined) {
      return promiseRejectedWith(defaultWriterLockException('abort'));
    }

    return WritableStreamDefaultWriterAbort(this, reason);
  }

  /**
   * If the writer is active, this behaves the same as the {@link WritableStream.close | close} method
   * for the associated stream.
   */
  close(): Promise<void> {
    if (IsWritableStreamDefaultWriter(this) === false) {
      return promiseRejectedWith(defaultWriterBrandCheckException('close'));
    }

    const stream = this._ownerWritableStream;

    if (stream === undefined) {
      return promiseRejectedWith(defaultWriterLockException('close'));
    }

    if (WritableStreamCloseQueuedOrInFlight(stream) === true) {
      return promiseRejectedWith(new TypeError('Cannot close an already-closing stream'));
    }

    return WritableStreamDefaultWriterClose(this);
  }

  /**
   * Releases the writer’s lock on the corresponding stream. After the lock is released, the writer is no longer active.
   * If the associated stream is errored when the lock is released, the writer will appear errored in the same way
   * from now on; otherwise, the writer will appear closed.
   *
   * Note that the lock can still be released even if some ongoing writes have not yet finished (i.e. even if the
   * promises returned from previous calls to {@link WritableStreamDefaultWriter.write | write()} have not yet settled).
   * It’s not necessary to hold the lock on the writer for the duration of the write; the lock instead simply prevents
   * other producers from writing in an interleaved manner.
   */
  releaseLock(): void {
    if (IsWritableStreamDefaultWriter(this) === false) {
      throw defaultWriterBrandCheckException('releaseLock');
    }

    const stream = this._ownerWritableStream;

    if (stream === undefined) {
      return;
    }

    assert(stream._writer !== undefined);

    WritableStreamDefaultWriterRelease(this);
  }

  /**
   * Writes the given chunk to the writable stream, by waiting until any previous writes have finished successfully,
   * and then sending the chunk to the {@link UnderlyingSink.write | underlying sink’s write() method}.
   * It will return a promise that fulfills with `undefined` upon a successful write, or rejects if the write fails
   * or stream becomes errored before the writing process is initiated.
   *
   * Note that what "success" means is up to the underlying sink; it might indicate simply that the chunk has been
   * accepted, and not necessarily that it is safely saved to its ultimate destination.
   */
  write(chunk: W): Promise<void> {
    if (IsWritableStreamDefaultWriter(this) === false) {
      return promiseRejectedWith(defaultWriterBrandCheckException('write'));
    }

    if (this._ownerWritableStream === undefined) {
      return promiseRejectedWith(defaultWriterLockException('write to'));
    }

    return WritableStreamDefaultWriterWrite(this, chunk);
  }
}

// Abstract operations for the WritableStreamDefaultWriter.

function IsWritableStreamDefaultWriter<W>(x: any): x is WritableStreamDefaultWriter<W> {
  if (!typeIsObject(x)) {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(x, '_ownerWritableStream')) {
    return false;
  }

  return true;
}

// A client of WritableStreamDefaultWriter may use these functions directly to bypass state check.

function WritableStreamDefaultWriterAbort(writer: WritableStreamDefaultWriter<any>, reason: any) {
  const stream = writer._ownerWritableStream;

  assert(stream !== undefined);

  return WritableStreamAbort(stream, reason);
}

function WritableStreamDefaultWriterClose(writer: WritableStreamDefaultWriter<any>): Promise<void> {
  const stream = writer._ownerWritableStream;

  assert(stream !== undefined);

  return WritableStreamClose(stream);
}

function WritableStreamDefaultWriterCloseWithErrorPropagation(writer: WritableStreamDefaultWriter<any>): Promise<void> {
  const stream = writer._ownerWritableStream;

  assert(stream !== undefined);

  const state = stream._state;
  if (WritableStreamCloseQueuedOrInFlight(stream) === true || state === 'closed') {
    return promiseResolvedWith(undefined);
  }

  if (state === 'errored') {
    return promiseRejectedWith(stream._storedError);
  }

  assert(state === 'writable' || state === 'erroring');

  return WritableStreamDefaultWriterClose(writer);
}

function WritableStreamDefaultWriterEnsureClosedPromiseRejected(writer: WritableStreamDefaultWriter<any>, error: any) {
  if (writer._closedPromiseState === 'pending') {
    defaultWriterClosedPromiseReject(writer, error);
  } else {
    defaultWriterClosedPromiseResetToRejected(writer, error);
  }
}

function WritableStreamDefaultWriterEnsureReadyPromiseRejected(writer: WritableStreamDefaultWriter<any>, error: any) {
  if (writer._readyPromiseState === 'pending') {
    defaultWriterReadyPromiseReject(writer, error);
  } else {
    defaultWriterReadyPromiseResetToRejected(writer, error);
  }
}

function WritableStreamDefaultWriterGetDesiredSize(writer: WritableStreamDefaultWriter<any>): number | null {
  const stream = writer._ownerWritableStream;
  const state = stream._state;

  if (state === 'errored' || state === 'erroring') {
    return null;
  }

  if (state === 'closed') {
    return 0;
  }

  return WritableStreamDefaultControllerGetDesiredSize(stream._writableStreamController);
}

function WritableStreamDefaultWriterRelease(writer: WritableStreamDefaultWriter<any>) {
  const stream = writer._ownerWritableStream;
  assert(stream !== undefined);
  assert(stream._writer === writer);

  const releasedError = new TypeError(
    'Writer was released and can no longer be used to monitor the stream\'s closedness');

  WritableStreamDefaultWriterEnsureReadyPromiseRejected(writer, releasedError);

  // The state transitions to "errored" before the sink abort() method runs, but the writer.closed promise is not
  // rejected until afterwards. This means that simply testing state will not work.
  WritableStreamDefaultWriterEnsureClosedPromiseRejected(writer, releasedError);

  stream._writer = undefined;
  writer._ownerWritableStream = undefined!;
}

function WritableStreamDefaultWriterWrite<W>(writer: WritableStreamDefaultWriter<W>, chunk: W): Promise<void> {
  const stream = writer._ownerWritableStream;

  assert(stream !== undefined);

  const controller = stream._writableStreamController;

  const chunkSize = WritableStreamDefaultControllerGetChunkSize(controller, chunk);

  if (stream !== writer._ownerWritableStream) {
    return promiseRejectedWith(defaultWriterLockException('write to'));
  }

  const state = stream._state;
  if (state === 'errored') {
    return promiseRejectedWith(stream._storedError);
  }
  if (WritableStreamCloseQueuedOrInFlight(stream) === true || state === 'closed') {
    return promiseRejectedWith(new TypeError('The stream is closing or closed and cannot be written to'));
  }
  if (state === 'erroring') {
    return promiseRejectedWith(stream._storedError);
  }

  assert(state === 'writable');

  const promise = WritableStreamAddWriteRequest(stream);

  WritableStreamDefaultControllerWrite(controller, chunk, chunkSize);

  return promise;
}

interface WriteRecord<W> {
  chunk: W;
}

type QueueRecord<W> = WriteRecord<W> | 'close';

/** @public */
export type WritableStreamDefaultControllerType = WritableStreamDefaultController<any>;

/** @public */
class WritableStreamDefaultController<W = any> {
  /** @internal */
  _controlledWritableStream!: WritableStream<W>;
  /** @internal */
  _queue!: SimpleQueue<QueuePair<QueueRecord<W>>>;
  /** @internal */
  _queueTotalSize!: number;
  /** @internal */
  _started!: boolean;
  /** @internal */
  _strategySizeAlgorithm!: QueuingStrategySizeCallback<W>;
  /** @internal */
  _strategyHWM!: number;
  /** @internal */
  _writeAlgorithm!: (chunk: W) => Promise<void>;
  /** @internal */
  _closeAlgorithm!: () => Promise<void>;
  /** @internal */
  _abortAlgorithm!: (reason: any) => Promise<void>;

  /** @internal */
  constructor() {
    throw new TypeError('WritableStreamDefaultController cannot be constructed explicitly');
  }

  error(e: any) {
    if (IsWritableStreamDefaultController(this) === false) {
      throw new TypeError(
        'WritableStreamDefaultController.prototype.error can only be used on a WritableStreamDefaultController');
    }
    const state = this._controlledWritableStream._state;
    if (state !== 'writable') {
      // The stream is closed, errored or will be soon. The sink can't do anything useful if it gets an error here, so
      // just treat it as a no-op.
      return;
    }

    WritableStreamDefaultControllerError(this, e);
  }

  /** @internal */
  [AbortSteps](reason: any) {
    const result = this._abortAlgorithm(reason);
    WritableStreamDefaultControllerClearAlgorithms(this);
    return result;
  }

  /** @internal */
  [ErrorSteps]() {
    ResetQueue(this);
  }
}

// Abstract operations implementing interface required by the WritableStream.

function IsWritableStreamDefaultController<W>(x: any): x is WritableStreamDefaultController<W> {
  if (!typeIsObject(x)) {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(x, '_controlledWritableStream')) {
    return false;
  }

  return true;
}

function SetUpWritableStreamDefaultController<W>(stream: WritableStream<W>,
                                                 controller: WritableStreamDefaultController<W>,
                                                 startAlgorithm: () => void | PromiseLike<void>,
                                                 writeAlgorithm: (chunk: W) => Promise<void>,
                                                 closeAlgorithm: () => Promise<void>,
                                                 abortAlgorithm: (reason: any) => Promise<void>,
                                                 highWaterMark: number,
                                                 sizeAlgorithm: QueuingStrategySizeCallback<W>) {
  assert(IsWritableStream(stream) === true);
  assert(stream._writableStreamController === undefined);

  controller._controlledWritableStream = stream;
  stream._writableStreamController = controller;

  // Need to set the slots so that the assert doesn't fire. In the spec the slots already exist implicitly.
  controller._queue = undefined!;
  controller._queueTotalSize = undefined!;
  ResetQueue(controller);

  controller._started = false;

  controller._strategySizeAlgorithm = sizeAlgorithm;
  controller._strategyHWM = highWaterMark;

  controller._writeAlgorithm = writeAlgorithm;
  controller._closeAlgorithm = closeAlgorithm;
  controller._abortAlgorithm = abortAlgorithm;

  const backpressure = WritableStreamDefaultControllerGetBackpressure(controller);
  WritableStreamUpdateBackpressure(stream, backpressure);

  const startResult = startAlgorithm();
  const startPromise = promiseResolvedWith(startResult);
  uponPromise(
    startPromise,
    () => {
      assert(stream._state === 'writable' || stream._state === 'erroring');
      controller._started = true;
      WritableStreamDefaultControllerAdvanceQueueIfNeeded(controller);
    },
    r => {
      assert(stream._state === 'writable' || stream._state === 'erroring');
      controller._started = true;
      WritableStreamDealWithRejection(stream, r);
    }
  );
}

function SetUpWritableStreamDefaultControllerFromUnderlyingSink<W>(stream: WritableStream<W>,
                                                                   underlyingSink: UnderlyingSink<W>,
                                                                   highWaterMark: number,
                                                                   sizeAlgorithm: QueuingStrategySizeCallback<W>) {
  assert(underlyingSink !== undefined);

  const controller = Object.create(WritableStreamDefaultController.prototype);

  function startAlgorithm() {
    return InvokeOrNoop<typeof underlyingSink, 'start'>(underlyingSink, 'start', [controller]);
  }

  const writeAlgorithm = CreateAlgorithmFromUnderlyingMethod<typeof underlyingSink, 'write'>(
    underlyingSink, 'write', 1, [controller]
  );
  const closeAlgorithm = CreateAlgorithmFromUnderlyingMethod<typeof underlyingSink, 'close'>(
    underlyingSink, 'close', 0, []
  );
  const abortAlgorithm = CreateAlgorithmFromUnderlyingMethod<typeof underlyingSink, 'abort'>(
    underlyingSink, 'abort', 1, []
  );

  SetUpWritableStreamDefaultController(stream, controller, startAlgorithm, writeAlgorithm, closeAlgorithm,
                                       abortAlgorithm, highWaterMark, sizeAlgorithm);
}

// ClearAlgorithms may be called twice. Erroring the same stream in multiple ways will often result in redundant calls.
function WritableStreamDefaultControllerClearAlgorithms(controller: WritableStreamDefaultController<any>) {
  controller._writeAlgorithm = undefined!;
  controller._closeAlgorithm = undefined!;
  controller._abortAlgorithm = undefined!;
  controller._strategySizeAlgorithm = undefined!;
}

function WritableStreamDefaultControllerClose(controller: WritableStreamDefaultController<any>) {
  EnqueueValueWithSize(controller, 'close', 0);
  WritableStreamDefaultControllerAdvanceQueueIfNeeded(controller);
}

function WritableStreamDefaultControllerGetChunkSize<W>(controller: WritableStreamDefaultController<W>,
                                                        chunk: W): number {
  try {
    return controller._strategySizeAlgorithm(chunk);
  } catch (chunkSizeE) {
    WritableStreamDefaultControllerErrorIfNeeded(controller, chunkSizeE);
    return 1;
  }
}

function WritableStreamDefaultControllerGetDesiredSize(controller: WritableStreamDefaultController<any>): number {
  return controller._strategyHWM - controller._queueTotalSize;
}

function WritableStreamDefaultControllerWrite<W>(controller: WritableStreamDefaultController<W>,
                                                 chunk: W,
                                                 chunkSize: number) {
  const writeRecord = { chunk };

  try {
    EnqueueValueWithSize(controller, writeRecord, chunkSize);
  } catch (enqueueE) {
    WritableStreamDefaultControllerErrorIfNeeded(controller, enqueueE);
    return;
  }

  const stream = controller._controlledWritableStream;
  if (WritableStreamCloseQueuedOrInFlight(stream) === false && stream._state === 'writable') {
    const backpressure = WritableStreamDefaultControllerGetBackpressure(controller);
    WritableStreamUpdateBackpressure(stream, backpressure);
  }

  WritableStreamDefaultControllerAdvanceQueueIfNeeded(controller);
}

// Abstract operations for the WritableStreamDefaultController.

function WritableStreamDefaultControllerAdvanceQueueIfNeeded<W>(controller: WritableStreamDefaultController<W>) {
  const stream = controller._controlledWritableStream;

  if (controller._started === false) {
    return;
  }

  if (stream._inFlightWriteRequest !== undefined) {
    return;
  }

  const state = stream._state;
  assert(state !== 'closed' && state !== 'errored');
  if (state === 'erroring') {
    WritableStreamFinishErroring(stream);
    return;
  }

  if (controller._queue.length === 0) {
    return;
  }

  const writeRecord = PeekQueueValue(controller);
  if (writeRecord === 'close') {
    WritableStreamDefaultControllerProcessClose(controller);
  } else {
    WritableStreamDefaultControllerProcessWrite(controller, writeRecord.chunk);
  }
}

function WritableStreamDefaultControllerErrorIfNeeded(controller: WritableStreamDefaultController<any>, error: any) {
  if (controller._controlledWritableStream._state === 'writable') {
    WritableStreamDefaultControllerError(controller, error);
  }
}

function WritableStreamDefaultControllerProcessClose(controller: WritableStreamDefaultController<any>) {
  const stream = controller._controlledWritableStream;

  WritableStreamMarkCloseRequestInFlight(stream);

  DequeueValue(controller);
  assert(controller._queue.length === 0);

  const sinkClosePromise = controller._closeAlgorithm();
  WritableStreamDefaultControllerClearAlgorithms(controller);
  uponPromise(
    sinkClosePromise,
    () => {
      WritableStreamFinishInFlightClose(stream);
    },
    reason => {
      WritableStreamFinishInFlightCloseWithError(stream, reason);
    }
  );
}

function WritableStreamDefaultControllerProcessWrite<W>(controller: WritableStreamDefaultController<W>, chunk: W) {
  const stream = controller._controlledWritableStream;

  WritableStreamMarkFirstWriteRequestInFlight(stream);

  const sinkWritePromise = controller._writeAlgorithm(chunk);
  uponPromise(
    sinkWritePromise,
    () => {
      WritableStreamFinishInFlightWrite(stream);

      const state = stream._state;
      assert(state === 'writable' || state === 'erroring');

      DequeueValue(controller);

      if (WritableStreamCloseQueuedOrInFlight(stream) === false && state === 'writable') {
        const backpressure = WritableStreamDefaultControllerGetBackpressure(controller);
        WritableStreamUpdateBackpressure(stream, backpressure);
      }

      WritableStreamDefaultControllerAdvanceQueueIfNeeded(controller);
    },
    reason => {
      if (stream._state === 'writable') {
        WritableStreamDefaultControllerClearAlgorithms(controller);
      }
      WritableStreamFinishInFlightWriteWithError(stream, reason);
    }
  );
}

function WritableStreamDefaultControllerGetBackpressure(controller: WritableStreamDefaultController<any>): boolean {
  const desiredSize = WritableStreamDefaultControllerGetDesiredSize(controller);
  return desiredSize <= 0;
}

// A client of WritableStreamDefaultController may use these functions directly to bypass state check.

function WritableStreamDefaultControllerError(controller: WritableStreamDefaultController<any>, error: any) {
  const stream = controller._controlledWritableStream;

  assert(stream._state === 'writable');

  WritableStreamDefaultControllerClearAlgorithms(controller);
  WritableStreamStartErroring(stream, error);
}

// Helper functions for the WritableStream.

function streamBrandCheckException(name: string): TypeError {
  return new TypeError(`WritableStream.prototype.${name} can only be used on a WritableStream`);
}

// Helper functions for the WritableStreamDefaultWriter.

function defaultWriterBrandCheckException(name: string): TypeError {
  return new TypeError(
    `WritableStreamDefaultWriter.prototype.${name} can only be used on a WritableStreamDefaultWriter`);
}

function defaultWriterLockException(name: string): TypeError {
  return new TypeError('Cannot ' + name + ' a stream using a released writer');
}

function defaultWriterClosedPromiseInitialize(writer: WritableStreamDefaultWriter<any>) {
  writer._closedPromise = newPromise((resolve, reject) => {
    writer._closedPromise_resolve = resolve;
    writer._closedPromise_reject = reject;
    writer._closedPromiseState = 'pending';
  });
}

function defaultWriterClosedPromiseInitializeAsRejected(writer: WritableStreamDefaultWriter<any>, reason: any) {
  defaultWriterClosedPromiseInitialize(writer);
  defaultWriterClosedPromiseReject(writer, reason);
}

function defaultWriterClosedPromiseInitializeAsResolved(writer: WritableStreamDefaultWriter<any>) {
  defaultWriterClosedPromiseInitialize(writer);
  defaultWriterClosedPromiseResolve(writer);
}

function defaultWriterClosedPromiseReject(writer: WritableStreamDefaultWriter<any>, reason: any) {
  assert(writer._closedPromise_resolve !== undefined);
  assert(writer._closedPromise_reject !== undefined);
  assert(writer._closedPromiseState === 'pending');

  setPromiseIsHandledToTrue(writer._closedPromise);
  writer._closedPromise_reject!(reason);
  writer._closedPromise_resolve = undefined;
  writer._closedPromise_reject = undefined;
  writer._closedPromiseState = 'rejected';
}

function defaultWriterClosedPromiseResetToRejected(writer: WritableStreamDefaultWriter<any>, reason: any) {
  assert(writer._closedPromise_resolve === undefined);
  assert(writer._closedPromise_reject === undefined);
  assert(writer._closedPromiseState !== 'pending');

  defaultWriterClosedPromiseInitializeAsRejected(writer, reason);
}

function defaultWriterClosedPromiseResolve(writer: WritableStreamDefaultWriter<any>) {
  assert(writer._closedPromise_resolve !== undefined);
  assert(writer._closedPromise_reject !== undefined);
  assert(writer._closedPromiseState === 'pending');

  writer._closedPromise_resolve!(undefined);
  writer._closedPromise_resolve = undefined;
  writer._closedPromise_reject = undefined;
  writer._closedPromiseState = 'resolved';
}

function defaultWriterReadyPromiseInitialize(writer: WritableStreamDefaultWriter<any>) {
  writer._readyPromise = newPromise((resolve, reject) => {
    writer._readyPromise_resolve = resolve;
    writer._readyPromise_reject = reject;
  });
  writer._readyPromiseState = 'pending';
}

function defaultWriterReadyPromiseInitializeAsRejected(writer: WritableStreamDefaultWriter<any>, reason: any) {
  defaultWriterReadyPromiseInitialize(writer);
  defaultWriterReadyPromiseReject(writer, reason);
}

function defaultWriterReadyPromiseInitializeAsResolved(writer: WritableStreamDefaultWriter<any>) {
  defaultWriterReadyPromiseInitialize(writer);
  defaultWriterReadyPromiseResolve(writer);
}

function defaultWriterReadyPromiseReject(writer: WritableStreamDefaultWriter<any>, reason: any) {
  assert(writer._readyPromise_resolve !== undefined);
  assert(writer._readyPromise_reject !== undefined);

  setPromiseIsHandledToTrue(writer._readyPromise);
  writer._readyPromise_reject!(reason);
  writer._readyPromise_resolve = undefined;
  writer._readyPromise_reject = undefined;
  writer._readyPromiseState = 'rejected';
}

function defaultWriterReadyPromiseReset(writer: WritableStreamDefaultWriter<any>) {
  assert(writer._readyPromise_resolve === undefined);
  assert(writer._readyPromise_reject === undefined);

  defaultWriterReadyPromiseInitialize(writer);
}

function defaultWriterReadyPromiseResetToRejected(writer: WritableStreamDefaultWriter<any>, reason: any) {
  assert(writer._readyPromise_resolve === undefined);
  assert(writer._readyPromise_reject === undefined);

  defaultWriterReadyPromiseInitializeAsRejected(writer, reason);
}

function defaultWriterReadyPromiseResolve(writer: WritableStreamDefaultWriter<any>) {
  assert(writer._readyPromise_resolve !== undefined);
  assert(writer._readyPromise_reject !== undefined);

  writer._readyPromise_resolve!(undefined);
  writer._readyPromise_resolve = undefined;
  writer._readyPromise_reject = undefined;
  writer._readyPromiseState = 'fulfilled';
}
