import assert from '../stub/assert';
import {
  createArrayFromList,
  IsNonNegativeNumber,
  MakeSizeAlgorithmFromSizeFunction,
  promiseRejectedWith,
  promiseResolvedWith,
  setPromiseIsHandledToTrue,
  transformPromiseWith,
  typeIsObject,
  ValidateAndNormalizeHighWaterMark
} from './helpers';
import { QueuingStrategy, QueuingStrategySizeCallback } from './queuing-strategy';
import { AcquireReadableStreamAsyncIterator, ReadableStreamAsyncIterator } from './readable-stream/async-iterator';
import {
  defaultReaderClosedPromiseReject,
  defaultReaderClosedPromiseResolve,
  ReadableStreamCreateReadResult,
  ReadResult
} from './readable-stream/generic-reader';
import {
  AcquireReadableStreamDefaultReader,
  IsReadableStreamDefaultReader,
  ReadableStreamDefaultReader,
  ReadableStreamDefaultReaderType
} from './readable-stream/default-reader';
import { ReadableStreamPipeTo } from './readable-stream/pipe';
import { ReadableStreamTee } from './readable-stream/tee';
import { IsWritableStream, IsWritableStreamLocked, WritableStream } from './writable-stream';
import NumberIsInteger from '../stub/number-isinteger';
import { SimpleQueue } from './simple-queue';
import {
  AcquireReadableStreamBYOBReader,
  IsReadableStreamBYOBReader,
  ReadableStreamBYOBReader,
  ReadableStreamBYOBReaderType
} from './readable-stream/byob-reader';
import {
  ReadableByteStreamController,
  ReadableByteStreamControllerType,
  ReadableStreamBYOBRequestType,
  SetUpReadableByteStreamController,
  SetUpReadableByteStreamControllerFromUnderlyingSource
} from './readable-stream/byte-stream-controller';
import { CancelSteps } from './readable-stream/symbols';
import {
  ReadableStreamDefaultController,
  ReadableStreamDefaultControllerType,
  SetUpReadableStreamDefaultController,
  SetUpReadableStreamDefaultControllerFromUnderlyingSource
} from './readable-stream/default-controller';
import {
  ReadableByteStreamControllerCallback,
  ReadableStreamDefaultControllerCallback,
  ReadableStreamErrorCallback,
  UnderlyingByteSource,
  UnderlyingSource
} from './readable-stream/underlying-source';
import { noop } from '../utils';
import { AbortSignal, isAbortSignal } from './abort-signal';

export type ReadableByteStream = ReadableStream<Uint8Array>;

/**
 * Options for {@link ReadableStream.pipeTo | piping} a stream.
 *
 * @public
 */
export interface PipeOptions {
  /**
   * If set to true, {@link ReadableStream.pipeTo} will not abort the writable stream if the readable stream errors.
   */
  preventAbort?: boolean;
  /**
   * If set to true, {@link ReadableStream.pipeTo} will not cancel the readable stream if the writable stream closes
   * or errors.
   */
  preventCancel?: boolean;
  /**
   * If set to true, {@link ReadableStream.pipeTo} will not close the writable stream if the readable stream closes.
   */
  preventClose?: boolean;
  /**
   * Can be set to an {@link AbortSignal} to allow aborting an ongoing pipe operation via the corresponding
   * `AbortController`. In this case, the source readable stream will be canceled, and the destination writable stream
   * aborted, unless the respective options `preventCancel` or `preventAbort` are set.
   */
  signal?: AbortSignal;
}

type ReadableStreamState = 'readable' | 'closed' | 'errored';

/**
 * A readable stream represents a source of data, from which you can read.
 *
 * @public
 */
export class ReadableStream<R = any> {
  /** @internal */
  _state!: ReadableStreamState;
  /** @internal */
  _reader: ReadableStreamReader<R> | undefined;
  /** @internal */
  _storedError: any;
  /** @internal */
  _disturbed!: boolean;
  /** @internal */
  _readableStreamController!: ReadableStreamDefaultController<R> | ReadableByteStreamController;

  constructor(underlyingSource: UnderlyingByteSource, strategy?: { highWaterMark?: number; size?: undefined });
  constructor(underlyingSource?: UnderlyingSource<R>, strategy?: QueuingStrategy<R>);
  constructor(underlyingSource: UnderlyingSource<R> | UnderlyingByteSource = {}, strategy: QueuingStrategy<R> = {}) {
    InitializeReadableStream(this);

    const size = strategy.size;
    let highWaterMark = strategy.highWaterMark;

    const type = underlyingSource.type;
    const typeString = String(type);
    if (typeString === 'bytes') {
      if (size !== undefined) {
        throw new RangeError('The strategy for a byte stream cannot have a size function');
      }

      if (highWaterMark === undefined) {
        highWaterMark = 0;
      }
      highWaterMark = ValidateAndNormalizeHighWaterMark(highWaterMark);

      SetUpReadableByteStreamControllerFromUnderlyingSource(this as unknown as ReadableByteStream,
                                                            underlyingSource as UnderlyingByteSource,
                                                            highWaterMark);
    } else if (type === undefined) {
      const sizeAlgorithm = MakeSizeAlgorithmFromSizeFunction(size);

      if (highWaterMark === undefined) {
        highWaterMark = 1;
      }
      highWaterMark = ValidateAndNormalizeHighWaterMark(highWaterMark);

      SetUpReadableStreamDefaultControllerFromUnderlyingSource(this,
                                                               underlyingSource as UnderlyingSource<R>,
                                                               highWaterMark,
                                                               sizeAlgorithm);
    } else {
      throw new RangeError('Invalid type is specified');
    }
  }

  /**
   * Whether or not the readable stream is locked to a {@link ReadableStreamDefaultReader | reader}.
   */
  get locked(): boolean {
    if (IsReadableStream(this) === false) {
      throw streamBrandCheckException('locked');
    }

    return IsReadableStreamLocked(this);
  }

  /**
   * Cancels the stream, signaling a loss of interest in the stream by a consumer.
   *
   * The supplied `reason` argument will be given to the underlying source's {@link UnderlyingSource.cancel | cancel()}
   * method, which might or might not use it.
   */
  cancel(reason: any): Promise<void> {
    if (IsReadableStream(this) === false) {
      return promiseRejectedWith(streamBrandCheckException('cancel'));
    }

    if (IsReadableStreamLocked(this) === true) {
      return promiseRejectedWith(new TypeError('Cannot cancel a stream that already has a reader'));
    }

    return ReadableStreamCancel(this, reason);
  }

  /**
   * Creates a reader of the type specified by the `mode` option and locks the stream to the new reader.
   * While the stream is locked, no other reader can be acquired until this one is released.
   *
   * This functionality is especially useful for creating abstractions that desire the ability to consume a stream
   * in its entirety. By getting a reader for the stream, you can ensure nobody else can interleave reads with yours
   * or cancel the stream, which would interfere with your abstraction.
   *
   * When `mode` is `undefined`, the method creates a {@link ReadableStreamDefaultReader | default reader}.
   * The reader provides the ability to directly read individual chunks from the stream via the reader's
   * {@link ReadableStreamDefaultReader.read | read()} method.
   *
   * When `mode` is `"byob"`, the method creates a {@link ReadableStreamBYOBReader | BYOB reader}.
   * This feature only works on readable byte streams, i.e. streams which were constructed specifically with
   * the ability to handle "bring your own buffer" reading. The reader provides the ability to directly read
   * individual chunks from the stream via the reader's {@link ReadableStreamBYOBReader.read | read()} method,
   * into developer-supplied buffers, allowing more precise control over allocation.
   */
  getReader({ mode }: { mode: 'byob' }): ReadableStreamBYOBReader;
  getReader(): ReadableStreamDefaultReader<R>;
  getReader({ mode }: { mode?: 'byob' } = {}): ReadableStreamDefaultReader<R> | ReadableStreamBYOBReader {
    if (IsReadableStream(this) === false) {
      throw streamBrandCheckException('getReader');
    }

    if (mode === undefined) {
      return AcquireReadableStreamDefaultReader(this, true);
    }

    mode = String(mode) as 'byob';

    if (mode === 'byob') {
      return AcquireReadableStreamBYOBReader(this as unknown as ReadableByteStream, true);
    }

    throw new RangeError('Invalid mode is specified');
  }

  /**
   * Provides a convenient, chainable way of piping this readable stream through a transform stream
   * (or any other `{ writable, readable }` pair). It simply {@link ReadableStream.pipeTo | pipes} the stream
   * into the writable side of the supplied pair, and returns the readable side for further use.
   *
   * Piping a stream will lock it for the duration of the pipe, preventing any other consumer from acquiring a reader.
   */
  pipeThrough<T>({ writable, readable }: { writable: WritableStream<R>; readable: ReadableStream<T> },
                 { preventClose, preventAbort, preventCancel, signal }: PipeOptions = {}): ReadableStream<T> {
    if (IsReadableStream(this) === false) {
      throw streamBrandCheckException('pipeThrough');
    }

    if (IsWritableStream(writable) === false) {
      throw new TypeError('writable argument to pipeThrough must be a WritableStream');
    }

    if (IsReadableStream(readable) === false) {
      throw new TypeError('readable argument to pipeThrough must be a ReadableStream');
    }

    preventClose = Boolean(preventClose);
    preventAbort = Boolean(preventAbort);
    preventCancel = Boolean(preventCancel);

    if (signal !== undefined && !isAbortSignal(signal)) {
      throw new TypeError('ReadableStream.prototype.pipeThrough\'s signal option must be an AbortSignal');
    }

    if (IsReadableStreamLocked(this) === true) {
      throw new TypeError('ReadableStream.prototype.pipeThrough cannot be used on a locked ReadableStream');
    }
    if (IsWritableStreamLocked(writable) === true) {
      throw new TypeError('ReadableStream.prototype.pipeThrough cannot be used on a locked WritableStream');
    }

    const promise = ReadableStreamPipeTo(this, writable, preventClose, preventAbort, preventCancel, signal);

    setPromiseIsHandledToTrue(promise);

    return readable;
  }

  /**
   * Pipes this readable stream to a given writable stream. The way in which the piping process behaves under
   * various error conditions can be customized with a number of passed options. It returns a promise that fulfills
   * when the piping process completes successfully, or rejects if any errors were encountered.
   *
   * Piping a stream will lock it for the duration of the pipe, preventing any other consumer from acquiring a reader.
   */
  pipeTo(dest: WritableStream<R>,
         { preventClose, preventAbort, preventCancel, signal }: PipeOptions = {}): Promise<void> {
    if (IsReadableStream(this) === false) {
      return promiseRejectedWith(streamBrandCheckException('pipeTo'));
    }
    if (IsWritableStream(dest) === false) {
      return promiseRejectedWith(
        new TypeError('ReadableStream.prototype.pipeTo\'s first argument must be a WritableStream'));
    }

    preventClose = Boolean(preventClose);
    preventAbort = Boolean(preventAbort);
    preventCancel = Boolean(preventCancel);

    if (signal !== undefined && !isAbortSignal(signal)) {
      return promiseRejectedWith(
        new TypeError('ReadableStream.prototype.pipeTo\'s signal option must be an AbortSignal'));
    }

    if (IsReadableStreamLocked(this) === true) {
      return promiseRejectedWith(
        new TypeError('ReadableStream.prototype.pipeTo cannot be used on a locked ReadableStream'));
    }
    if (IsWritableStreamLocked(dest) === true) {
      return promiseRejectedWith(
        new TypeError('ReadableStream.prototype.pipeTo cannot be used on a locked WritableStream'));
    }

    return ReadableStreamPipeTo(this, dest, preventClose, preventAbort, preventCancel, signal);
  }

  /**
   * Tees this readable stream, returning a two-element array containing the two resulting branches as
   * new {@link ReadableStream} instances.
   *
   * Teeing a stream will lock it, preventing any other consumer from acquiring a reader.
   * To cancel the stream, cancel both of the resulting branches; a composite cancellation reason will then be
   * propagated to the stream's underlying source.
   *
   * Note that the chunks seen in each branch will be the same object. If the chunks are not immutable,
   * this could allow interference between the two branches.
   */
  tee(): [ReadableStream<R>, ReadableStream<R>] {
    if (IsReadableStream(this) === false) {
      throw streamBrandCheckException('tee');
    }

    const branches = ReadableStreamTee(this, false);
    return createArrayFromList(branches);
  }

  /**
   * Returns an async iterator which can be used to consume the stream.
   *
   * The return() method of this iterator object will, by default, cancel the stream; it will also release the reader.
   */
  getIterator({ preventCancel = false }: { preventCancel?: boolean } = {}): ReadableStreamAsyncIterator<R> {
    if (IsReadableStream(this) === false) {
      throw streamBrandCheckException('getIterator');
    }
    return AcquireReadableStreamAsyncIterator<R>(this, preventCancel);
  }

  /**
   * Alias of {@link ReadableStream.getIterator}.
   */
  [Symbol.asyncIterator]: (options?: { preventCancel?: boolean }) => ReadableStreamAsyncIterator<R>;
}

if (typeof Symbol.asyncIterator === 'symbol') {
  Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, {
    value: ReadableStream.prototype.getIterator,
    enumerable: false,
    writable: true,
    configurable: true
  });
}

export {
  ReadableByteStreamControllerCallback,
  ReadableStreamAsyncIterator,
  ReadableStreamDefaultControllerCallback,
  ReadableStreamDefaultReader,
  ReadableStreamErrorCallback,
  ReadResult,
  UnderlyingByteSource,
  UnderlyingSource
};

// Abstract operations for the ReadableStream.

// Throws if and only if startAlgorithm throws.
export function CreateReadableStream<R>(startAlgorithm: () => void | PromiseLike<void>,
                                        pullAlgorithm: () => Promise<void>,
                                        cancelAlgorithm: (reason: any) => Promise<void>,
                                        highWaterMark = 1,
                                        sizeAlgorithm: QueuingStrategySizeCallback<R> = () => 1): ReadableStream<R> {
  assert(IsNonNegativeNumber(highWaterMark) === true);

  const stream: ReadableStream<R> = Object.create(ReadableStream.prototype);
  InitializeReadableStream(stream);

  const controller: ReadableStreamDefaultController<R> = Object.create(ReadableStreamDefaultController.prototype);

  SetUpReadableStreamDefaultController(
    stream, controller, startAlgorithm, pullAlgorithm, cancelAlgorithm, highWaterMark, sizeAlgorithm
  );

  return stream;
}

// Throws if and only if startAlgorithm throws.
export function CreateReadableByteStream(startAlgorithm: () => void | PromiseLike<void>,
                                         pullAlgorithm: () => Promise<void>,
                                         cancelAlgorithm: (reason: any) => Promise<void>,
                                         highWaterMark = 0,
                                         autoAllocateChunkSize: number | undefined = undefined): ReadableStream<Uint8Array> {
  assert(IsNonNegativeNumber(highWaterMark) === true);
  if (autoAllocateChunkSize !== undefined) {
    assert(NumberIsInteger(autoAllocateChunkSize) === true);
    assert(autoAllocateChunkSize > 0);
  }

  const stream: ReadableStream<Uint8Array> = Object.create(ReadableStream.prototype);
  InitializeReadableStream(stream);

  const controller: ReadableByteStreamController = Object.create(ReadableByteStreamController.prototype);

  SetUpReadableByteStreamController(stream, controller, startAlgorithm, pullAlgorithm, cancelAlgorithm, highWaterMark,
                                    autoAllocateChunkSize);

  return stream;
}

function InitializeReadableStream(stream: ReadableStream) {
  stream._state = 'readable';
  stream._reader = undefined;
  stream._storedError = undefined;
  stream._disturbed = false;
}

export function IsReadableStream(x: any): x is ReadableStream {
  if (!typeIsObject(x)) {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(x, '_readableStreamController')) {
    return false;
  }

  return true;
}

export function IsReadableStreamDisturbed(stream: ReadableStream): boolean {
  assert(IsReadableStream(stream) === true);

  return stream._disturbed;
}

export function IsReadableStreamLocked(stream: ReadableStream): boolean {
  assert(IsReadableStream(stream) === true);

  if (stream._reader === undefined) {
    return false;
  }

  return true;
}

// ReadableStream API exposed for controllers.

export function ReadableStreamCancel<R>(stream: ReadableStream<R>, reason: any): Promise<void> {
  stream._disturbed = true;

  if (stream._state === 'closed') {
    return promiseResolvedWith(undefined);
  }
  if (stream._state === 'errored') {
    return promiseRejectedWith(stream._storedError);
  }

  ReadableStreamClose(stream);

  const sourceCancelPromise = stream._readableStreamController[CancelSteps](reason);
  return transformPromiseWith(sourceCancelPromise, noop);
}

export function ReadableStreamClose<R>(stream: ReadableStream<R>): void {
  assert(stream._state === 'readable');

  stream._state = 'closed';

  const reader = stream._reader;

  if (reader === undefined) {
    return;
  }

  if (IsReadableStreamDefaultReader<R>(reader)) {
    reader._readRequests.forEach(readRequest => {
      readRequest._resolve(ReadableStreamCreateReadResult<R>(undefined, true, reader._forAuthorCode));
    });
    reader._readRequests = new SimpleQueue();
  }

  defaultReaderClosedPromiseResolve(reader);
}

export function ReadableStreamError<R>(stream: ReadableStream<R>, e: any): void {
  assert(IsReadableStream(stream) === true);
  assert(stream._state === 'readable');

  stream._state = 'errored';
  stream._storedError = e;

  const reader = stream._reader;

  if (reader === undefined) {
    return;
  }

  if (IsReadableStreamDefaultReader<R>(reader)) {
    reader._readRequests.forEach(readRequest => {
      readRequest._reject(e);
    });

    reader._readRequests = new SimpleQueue();
  } else {
    assert(IsReadableStreamBYOBReader(reader));

    reader._readIntoRequests.forEach(readIntoRequest => {
      readIntoRequest._reject(e);
    });

    reader._readIntoRequests = new SimpleQueue();
  }

  defaultReaderClosedPromiseReject(reader, e);
}

// Readers

export type ReadableStreamReader<R> = ReadableStreamDefaultReader<R> | ReadableStreamBYOBReader;

export {
  ReadableStreamDefaultReaderType,
  ReadableStreamBYOBReaderType
};

// Controllers

export {
  ReadableStreamDefaultControllerType,
  ReadableStreamBYOBRequestType,
  ReadableByteStreamControllerType
};

// Helper functions for the ReadableStream.

function streamBrandCheckException(name: string): TypeError {
  return new TypeError(`ReadableStream.prototype.${name} can only be used on a ReadableStream`);
}
