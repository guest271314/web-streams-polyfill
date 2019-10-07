import { newPromise, promiseRejectedWith, promiseResolvedWith, typeIsObject } from '../helpers';
import assert from '../../stub/assert';
import { SimpleQueue } from '../simple-queue';
import {
  ReadableStreamCreateReadResult,
  ReadableStreamReaderGenericCancel,
  ReadableStreamReaderGenericInitialize,
  ReadableStreamReaderGenericRelease,
  readerLockException,
  ReadResult
} from './generic-reader';
import { IsReadableStream, IsReadableStreamLocked, ReadableStream } from '../readable-stream';
import { PullSteps } from './symbols';

// Abstract operations for the ReadableStream.

export function AcquireReadableStreamDefaultReader<R>(stream: ReadableStream,
                                                      forAuthorCode = false): ReadableStreamDefaultReader<R> {
  const reader = new ReadableStreamDefaultReader(stream);
  reader._forAuthorCode = forAuthorCode;
  return reader;
}

// ReadableStream API exposed for controllers.

export function ReadableStreamAddReadRequest<R>(stream: ReadableStream<R>): Promise<ReadResult<R>> {
  assert(IsReadableStreamDefaultReader(stream._reader) === true);
  assert(stream._state === 'readable');

  const promise = newPromise<ReadResult<R>>((resolve, reject) => {
    const readRequest: ReadRequest<R> = {
      _resolve: resolve,
      _reject: reject
    };

    (stream._reader! as ReadableStreamDefaultReader<R>)._readRequests.push(readRequest);
  });

  return promise;
}

export function ReadableStreamFulfillReadRequest<R>(stream: ReadableStream<R>, chunk: R | undefined, done: boolean) {
  const reader = stream._reader as ReadableStreamDefaultReader<R>;

  assert(reader._readRequests.length > 0);

  const readRequest = reader._readRequests.shift()!;
  readRequest._resolve(ReadableStreamCreateReadResult(chunk, done, reader._forAuthorCode));
}

export function ReadableStreamGetNumReadRequests<R>(stream: ReadableStream<R>): number {
  return (stream._reader as ReadableStreamDefaultReader<R>)._readRequests.length;
}

export function ReadableStreamHasDefaultReader(stream: ReadableStream): boolean {
  const reader = stream._reader;

  if (reader === undefined) {
    return false;
  }

  if (!IsReadableStreamDefaultReader(reader)) {
    return false;
  }

  return true;
}

// Readers

export interface ReadRequest<R> {
  _resolve: (value: ReadResult<R>) => void;
  _reject: (reason: any) => void;
}

/**
 * @public
 */
export type ReadableStreamDefaultReaderType<R> = ReadableStreamDefaultReader<R>;

/**
 * @public
 */
export class ReadableStreamDefaultReader<R> {
  /** @internal */
  _forAuthorCode!: boolean;
  /** @internal */
  _ownerReadableStream!: ReadableStream<R>;
  /** @internal */
  _closedPromise!: Promise<void>;
  /** @internal */
  _closedPromise_resolve?: (value?: undefined) => void;
  /** @internal */
  _closedPromise_reject?: (reason: any) => void;
  /** @internal */
  _readRequests: SimpleQueue<ReadRequest<R>>;

  constructor(stream: ReadableStream<R>) {
    if (IsReadableStream(stream) === false) {
      throw new TypeError('ReadableStreamDefaultReader can only be constructed with a ReadableStream instance');
    }
    if (IsReadableStreamLocked(stream) === true) {
      throw new TypeError('This stream has already been locked for exclusive reading by another reader');
    }

    ReadableStreamReaderGenericInitialize(this, stream);

    this._readRequests = new SimpleQueue();
  }

  /**
   * Returns a promise that will be fulfilled when the stream becomes closed,
   * or rejected if the stream ever errors or the reader's lock is released before the stream finishes closing.
   */
  get closed(): Promise<void> {
    if (!IsReadableStreamDefaultReader(this)) {
      return promiseRejectedWith(defaultReaderBrandCheckException('closed'));
    }

    return this._closedPromise;
  }

  /**
   * If the reader is active, this behaves the same as the {@link ReadableStream.cancel | cancel} method
   * for the associated stream.
   */
  cancel(reason: any): Promise<void> {
    if (!IsReadableStreamDefaultReader(this)) {
      return promiseRejectedWith(defaultReaderBrandCheckException('cancel'));
    }

    if (this._ownerReadableStream === undefined) {
      return promiseRejectedWith(readerLockException('cancel'));
    }

    return ReadableStreamReaderGenericCancel(this, reason);
  }

  /**
   * Returns a promise that allows access to the next chunk from the stream's internal queue, if available.
   */
  read(): Promise<ReadResult<R>> {
    if (!IsReadableStreamDefaultReader(this)) {
      return promiseRejectedWith(defaultReaderBrandCheckException('read'));
    }

    if (this._ownerReadableStream === undefined) {
      return promiseRejectedWith(readerLockException('read from'));
    }

    return ReadableStreamDefaultReaderRead<R>(this);
  }

  /**
   * Releases the reader's lock on the corresponding stream. After the lock is released, the reader is no longer active.
   * If the associated stream is errored when the lock is released, the reader will appear errored in the same way
   * from now on; otherwise, the reader will appear closed.
   *
   * A reader's lock cannot be released while it still has a pending read request, i.e., if a promise returned by
   * the reader's {@link ReadableStreamDefaultReader.read | read()} method has not yet been settled. Attempting to
   * do so will throw a `TypeError` and leave the reader locked to the stream.
   */
  releaseLock(): void {
    if (!IsReadableStreamDefaultReader(this)) {
      throw defaultReaderBrandCheckException('releaseLock');
    }

    if (this._ownerReadableStream === undefined) {
      return;
    }

    if (this._readRequests.length > 0) {
      throw new TypeError('Tried to release a reader lock when that reader has pending read() calls un-settled');
    }

    ReadableStreamReaderGenericRelease(this);
  }
}

// Abstract operations for the readers.

export function IsReadableStreamDefaultReader<R>(x: any): x is ReadableStreamDefaultReader<R> {
  if (!typeIsObject(x)) {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(x, '_readRequests')) {
    return false;
  }

  return true;
}

export function ReadableStreamDefaultReaderRead<R>(reader: ReadableStreamDefaultReader<R>): Promise<ReadResult<R>> {
  const stream = reader._ownerReadableStream;

  assert(stream !== undefined);

  stream._disturbed = true;

  if (stream._state === 'closed') {
    return promiseResolvedWith(ReadableStreamCreateReadResult<R>(undefined, true, reader._forAuthorCode));
  }

  if (stream._state === 'errored') {
    return promiseRejectedWith(stream._storedError);
  }

  assert(stream._state === 'readable');

  return stream._readableStreamController[PullSteps]() as unknown as Promise<ReadResult<R>>;
}

// Helper functions for the ReadableStreamDefaultReader.

function defaultReaderBrandCheckException(name: string): TypeError {
  return new TypeError(
    `ReadableStreamDefaultReader.prototype.${name} can only be used on a ReadableStreamDefaultReader`);
}
