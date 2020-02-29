import { QueuingStrategySizeCallback } from '../queuing-strategy';
import assert from '../../stub/assert';
import { DequeueValue, EnqueueValueWithSize, QueuePair, ResetQueue } from '../queue-with-sizes';
import {
  ReadableStreamAddReadRequest,
  ReadableStreamFulfillReadRequest,
  ReadableStreamGetNumReadRequests
} from './default-reader';
import { SimpleQueue } from '../simple-queue';
import { CancelSteps, PullSteps } from './symbols';
import { ReadableStreamCreateReadResult, ReadResult } from './generic-reader';
import {
  CreateAlgorithmFromUnderlyingMethod,
  InvokeOrNoop,
  promiseResolvedWith,
  typeIsObject,
  uponPromise
} from '../helpers';
import { IsReadableStreamLocked, ReadableStream, ReadableStreamClose, ReadableStreamError } from '../readable-stream';
import { UnderlyingSource } from './underlying-source';

/** @public */
export type ReadableStreamDefaultControllerType<R> = ReadableStreamDefaultController<R>;

/**
 * The ReadableStreamDefaultController class has methods that allow control of a {@link ReadableStream}'s state
 * and internal queue. When constructing a {@link ReadableStream} that is not a readable byte stream,
 * the underlying source is given a corresponding ReadableStreamDefaultController instance to manipulate.
 *
 * @public
 */
export class ReadableStreamDefaultController<R> {
  /** @internal */
  _controlledReadableStream!: ReadableStream<R>;
  /** @internal */
  _queue!: SimpleQueue<QueuePair<R>>;
  /** @internal */
  _queueTotalSize!: number;
  /** @internal */
  _started!: boolean;
  /** @internal */
  _closeRequested!: boolean;
  /** @internal */
  _pullAgain!: boolean;
  /** @internal */
  _pulling !: boolean;
  /** @internal */
  _strategySizeAlgorithm!: QueuingStrategySizeCallback<R>;
  /** @internal */
  _strategyHWM!: number;
  /** @internal */
  _pullAlgorithm!: () => Promise<void>;
  /** @internal */
  _cancelAlgorithm!: (reason: any) => Promise<void>;

  /** @internal */
  constructor() {
    throw new TypeError();
  }

  get desiredSize(): number | null {
    if (IsReadableStreamDefaultController(this) === false) {
      throw defaultControllerBrandCheckException('desiredSize');
    }

    return ReadableStreamDefaultControllerGetDesiredSize(this);
  }

  close(): void {
    if (IsReadableStreamDefaultController(this) === false) {
      throw defaultControllerBrandCheckException('close');
    }

    if (ReadableStreamDefaultControllerCanCloseOrEnqueue(this) === false) {
      throw new TypeError('The stream is not in a state that permits close');
    }

    ReadableStreamDefaultControllerClose(this);
  }

  enqueue(chunk: R): void {
    if (IsReadableStreamDefaultController(this) === false) {
      throw defaultControllerBrandCheckException('enqueue');
    }

    if (ReadableStreamDefaultControllerCanCloseOrEnqueue(this) === false) {
      throw new TypeError('The stream is not in a state that permits enqueue');
    }

    return ReadableStreamDefaultControllerEnqueue(this, chunk);
  }

  error(e: any): void {
    if (IsReadableStreamDefaultController(this) === false) {
      throw defaultControllerBrandCheckException('error');
    }

    ReadableStreamDefaultControllerError(this, e);
  }

  /** @internal */
  [CancelSteps](reason: any): Promise<void> {
    ResetQueue(this);
    const result = this._cancelAlgorithm(reason);
    ReadableStreamDefaultControllerClearAlgorithms(this);
    return result;
  }

  /** @internal */
  [PullSteps](): Promise<ReadResult<R>> {
    const stream = this._controlledReadableStream;

    if (this._queue.length > 0) {
      const chunk = DequeueValue(this);

      if (this._closeRequested === true && this._queue.length === 0) {
        ReadableStreamDefaultControllerClearAlgorithms(this);
        ReadableStreamClose(stream);
      } else {
        ReadableStreamDefaultControllerCallPullIfNeeded(this);
      }

      return promiseResolvedWith(ReadableStreamCreateReadResult(chunk, false, stream._reader!._forAuthorCode));
    }

    const pendingPromise = ReadableStreamAddReadRequest(stream);
    ReadableStreamDefaultControllerCallPullIfNeeded(this);
    return pendingPromise;
  }
}

// Abstract operations for the ReadableStreamDefaultController.

function IsReadableStreamDefaultController<R>(x: any): x is ReadableStreamDefaultController<R> {
  if (!typeIsObject(x)) {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(x, '_controlledReadableStream')) {
    return false;
  }

  return true;
}

function ReadableStreamDefaultControllerCallPullIfNeeded(controller: ReadableStreamDefaultController<any>): void {
  const shouldPull = ReadableStreamDefaultControllerShouldCallPull(controller);
  if (shouldPull === false) {
    return;
  }

  if (controller._pulling === true) {
    controller._pullAgain = true;
    return;
  }

  assert(controller._pullAgain === false);

  controller._pulling = true;

  const pullPromise = controller._pullAlgorithm();
  uponPromise(
    pullPromise,
    () => {
      controller._pulling = false;

      if (controller._pullAgain === true) {
        controller._pullAgain = false;
        ReadableStreamDefaultControllerCallPullIfNeeded(controller);
      }
    },
    e => {
      ReadableStreamDefaultControllerError(controller, e);
    }
  );
}

function ReadableStreamDefaultControllerShouldCallPull(controller: ReadableStreamDefaultController<any>): boolean {
  const stream = controller._controlledReadableStream;

  if (ReadableStreamDefaultControllerCanCloseOrEnqueue(controller) === false) {
    return false;
  }

  if (controller._started === false) {
    return false;
  }

  if (IsReadableStreamLocked(stream) === true && ReadableStreamGetNumReadRequests(stream) > 0) {
    return true;
  }

  const desiredSize = ReadableStreamDefaultControllerGetDesiredSize(controller);
  assert(desiredSize !== null);
  if (desiredSize! > 0) {
    return true;
  }

  return false;
}

function ReadableStreamDefaultControllerClearAlgorithms(controller: ReadableStreamDefaultController<any>) {
  controller._pullAlgorithm = undefined!;
  controller._cancelAlgorithm = undefined!;
  controller._strategySizeAlgorithm = undefined!;
}

// A client of ReadableStreamDefaultController may use these functions directly to bypass state check.

export function ReadableStreamDefaultControllerClose(controller: ReadableStreamDefaultController<any>) {
  const stream = controller._controlledReadableStream;

  assert(ReadableStreamDefaultControllerCanCloseOrEnqueue(controller) === true);

  controller._closeRequested = true;

  if (controller._queue.length === 0) {
    ReadableStreamDefaultControllerClearAlgorithms(controller);
    ReadableStreamClose(stream);
  }
}

export function ReadableStreamDefaultControllerEnqueue<R>(controller: ReadableStreamDefaultController<R>, chunk: R): void {
  const stream = controller._controlledReadableStream;

  assert(ReadableStreamDefaultControllerCanCloseOrEnqueue(controller) === true);

  if (IsReadableStreamLocked(stream) === true && ReadableStreamGetNumReadRequests(stream) > 0) {
    ReadableStreamFulfillReadRequest(stream, chunk, false);
  } else {
    let chunkSize;
    try {
      chunkSize = controller._strategySizeAlgorithm(chunk);
    } catch (chunkSizeE) {
      ReadableStreamDefaultControllerError(controller, chunkSizeE);
      throw chunkSizeE;
    }

    try {
      EnqueueValueWithSize(controller, chunk, chunkSize);
    } catch (enqueueE) {
      ReadableStreamDefaultControllerError(controller, enqueueE);
      throw enqueueE;
    }
  }

  ReadableStreamDefaultControllerCallPullIfNeeded(controller);
}

export function ReadableStreamDefaultControllerError(controller: ReadableStreamDefaultController<any>, e: any) {
  const stream = controller._controlledReadableStream;

  if (stream._state !== 'readable') {
    return;
  }

  ResetQueue(controller);

  ReadableStreamDefaultControllerClearAlgorithms(controller);
  ReadableStreamError(stream, e);
}

export function ReadableStreamDefaultControllerGetDesiredSize(controller: ReadableStreamDefaultController<any>): number | null {
  const stream = controller._controlledReadableStream;
  const state = stream._state;

  if (state === 'errored') {
    return null;
  }
  if (state === 'closed') {
    return 0;
  }

  return controller._strategyHWM - controller._queueTotalSize;
}

// This is used in the implementation of TransformStream.
export function ReadableStreamDefaultControllerHasBackpressure(controller: ReadableStreamDefaultController<any>): boolean {
  if (ReadableStreamDefaultControllerShouldCallPull(controller) === true) {
    return false;
  }

  return true;
}

export function ReadableStreamDefaultControllerCanCloseOrEnqueue(controller: ReadableStreamDefaultController<any>): boolean {
  const state = controller._controlledReadableStream._state;

  if (controller._closeRequested === false && state === 'readable') {
    return true;
  }

  return false;
}

export function SetUpReadableStreamDefaultController<R>(stream: ReadableStream<R>,
                                                        controller: ReadableStreamDefaultController<R>,
                                                        startAlgorithm: () => void | PromiseLike<void>,
                                                        pullAlgorithm: () => Promise<void>,
                                                        cancelAlgorithm: (reason: any) => Promise<void>,
                                                        highWaterMark: number,
                                                        sizeAlgorithm: QueuingStrategySizeCallback<R>) {
  assert(stream._readableStreamController === undefined);

  controller._controlledReadableStream = stream;

  controller._queue = undefined!;
  controller._queueTotalSize = undefined!;
  ResetQueue(controller);

  controller._started = false;
  controller._closeRequested = false;
  controller._pullAgain = false;
  controller._pulling = false;

  controller._strategySizeAlgorithm = sizeAlgorithm;
  controller._strategyHWM = highWaterMark;

  controller._pullAlgorithm = pullAlgorithm;
  controller._cancelAlgorithm = cancelAlgorithm;

  stream._readableStreamController = controller;

  const startResult = startAlgorithm();
  uponPromise(
    promiseResolvedWith(startResult),
    () => {
      controller._started = true;

      assert(controller._pulling === false);
      assert(controller._pullAgain === false);

      ReadableStreamDefaultControllerCallPullIfNeeded(controller);
    },
    r => {
      ReadableStreamDefaultControllerError(controller, r);
    }
  );
}

export function SetUpReadableStreamDefaultControllerFromUnderlyingSource<R>(stream: ReadableStream<R>,
                                                                            underlyingSource: UnderlyingSource<R>,
                                                                            highWaterMark: number,
                                                                            sizeAlgorithm: QueuingStrategySizeCallback<R>) {
  assert(underlyingSource !== undefined);

  const controller: ReadableStreamDefaultController<R> = Object.create(ReadableStreamDefaultController.prototype);

  function startAlgorithm() {
    return InvokeOrNoop<typeof underlyingSource, 'start'>(underlyingSource, 'start', [controller]);
  }

  const pullAlgorithm = CreateAlgorithmFromUnderlyingMethod<typeof underlyingSource, 'pull'>(
    underlyingSource, 'pull', 0, [controller]
  );
  const cancelAlgorithm = CreateAlgorithmFromUnderlyingMethod<typeof underlyingSource, 'cancel'>(
    underlyingSource, 'cancel', 1, []
  );

  SetUpReadableStreamDefaultController(stream, controller, startAlgorithm, pullAlgorithm, cancelAlgorithm,
                                       highWaterMark, sizeAlgorithm);
}

// Helper functions for the ReadableStreamDefaultController.

function defaultControllerBrandCheckException(name: string): TypeError {
  return new TypeError(
    `ReadableStreamDefaultController.prototype.${name} can only be used on a ReadableStreamDefaultController`);
}
