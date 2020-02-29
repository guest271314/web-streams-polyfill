import assert from '../stub/assert';
import {
  CreateAlgorithmFromUnderlyingMethod,
  InvokeOrNoop,
  IsNonNegativeNumber,
  MakeSizeAlgorithmFromSizeFunction,
  newPromise,
  PromiseCall,
  promiseRejectedWith,
  promiseResolvedWith,
  transformPromiseWith,
  typeIsObject,
  ValidateAndNormalizeHighWaterMark
} from './helpers';
import {
  CreateReadableStream,
  ReadableStream,
  ReadableStreamDefaultControllerType as ReadableStreamDefaultController
} from './readable-stream';
import {
  ReadableStreamDefaultControllerCanCloseOrEnqueue,
  ReadableStreamDefaultControllerClose,
  ReadableStreamDefaultControllerEnqueue,
  ReadableStreamDefaultControllerError,
  ReadableStreamDefaultControllerGetDesiredSize,
  ReadableStreamDefaultControllerHasBackpressure
} from './readable-stream/default-controller';
import { QueuingStrategy, QueuingStrategySizeCallback } from './queuing-strategy';
import { CreateWritableStream, WritableStream, WritableStreamDefaultControllerErrorIfNeeded } from './writable-stream';

/** @public */
export type TransformStreamDefaultControllerCallback<O>
  = (controller: TransformStreamDefaultControllerType<O>) => void | PromiseLike<void>;
/** @public */
export type TransformStreamDefaultControllerTransformCallback<I, O>
  = (chunk: I, controller: TransformStreamDefaultControllerType<O>) => void | PromiseLike<void>;

/** @public */
export interface Transformer<I = any, O = any> {
  /**
   * A function that is called immediately during creation of the TransformStream.
   */
  start?: TransformStreamDefaultControllerCallback<O>;
  /**
   * A function called when a new chunk originally written to the writable side is ready to be transformed.
   */
  transform?: TransformStreamDefaultControllerTransformCallback<I, O>;
  /**
   * A function called after all chunks written to the writable side have been transformed by successfully passing
   * through {@link Transformer.transform | transform()}, and the writable side is about to be closed.
   */
  flush?: TransformStreamDefaultControllerCallback<O>;
  readableType?: undefined;
  writableType?: undefined;
}

// Class TransformStream

/**
 * A transform stream consists of a pair of streams: a {@link WritableStream | writable stream},
 * known as its writable side, and a {@link ReadableStream | readable stream}, known as its readable side.
 * In a manner specific to the transform stream in question, writes to the writable side result in new data being
 * made available for reading from the readable side.
 *
 * @public
 */
export class TransformStream<I = any, O = any> {
  /** @internal */
  _writable!: WritableStream<I>;
  /** @internal */
  _readable!: ReadableStream<O>;
  /** @internal */
  _backpressure!: boolean;
  /** @internal */
  _backpressureChangePromise!: Promise<void>;
  /** @internal */
  _backpressureChangePromise_resolve!: () => void;
  /** @internal */
  _transformStreamController!: TransformStreamDefaultController<O>;

  constructor(transformer: Transformer<I, O> = {},
              writableStrategy: QueuingStrategy<I> = {},
              readableStrategy: QueuingStrategy<O> = {}) {
    const writableSizeFunction = writableStrategy.size;
    let writableHighWaterMark = writableStrategy.highWaterMark;
    const readableSizeFunction = readableStrategy.size;
    let readableHighWaterMark = readableStrategy.highWaterMark;

    const writableType = transformer.writableType;

    if (writableType !== undefined) {
      throw new RangeError('Invalid writable type specified');
    }

    const writableSizeAlgorithm = MakeSizeAlgorithmFromSizeFunction(writableSizeFunction);
    if (writableHighWaterMark === undefined) {
      writableHighWaterMark = 1;
    }
    writableHighWaterMark = ValidateAndNormalizeHighWaterMark(writableHighWaterMark);

    const readableType = transformer.readableType;

    if (readableType !== undefined) {
      throw new RangeError('Invalid readable type specified');
    }

    const readableSizeAlgorithm = MakeSizeAlgorithmFromSizeFunction(readableSizeFunction);
    if (readableHighWaterMark === undefined) {
      readableHighWaterMark = 0;
    }
    readableHighWaterMark = ValidateAndNormalizeHighWaterMark(readableHighWaterMark);

    let startPromise_resolve!: (value: void | PromiseLike<void>) => void;
    const startPromise = newPromise<void>(resolve => {
      startPromise_resolve = resolve;
    });

    InitializeTransformStream(this, startPromise, writableHighWaterMark, writableSizeAlgorithm, readableHighWaterMark,
                              readableSizeAlgorithm);
    SetUpTransformStreamDefaultControllerFromTransformer(this, transformer);

    const startResult = InvokeOrNoop<typeof transformer, 'start'>(
      transformer, 'start', [this._transformStreamController]
    );
    startPromise_resolve(startResult);
  }

  /**
   * The readable side of the transform stream.
   */
  get readable(): ReadableStream<O> {
    if (IsTransformStream(this) === false) {
      throw streamBrandCheckException('readable');
    }

    return this._readable;
  }

  /**
   * The writable side of the transform stream.
   */
  get writable(): WritableStream<I> {
    if (IsTransformStream(this) === false) {
      throw streamBrandCheckException('writable');
    }

    return this._writable;
  }
}

// Transform Stream Abstract Operations

export function CreateTransformStream<I, O>(startAlgorithm: () => void | PromiseLike<void>,
                                            transformAlgorithm: (chunk: I) => Promise<void>,
                                            flushAlgorithm: () => Promise<void>,
                                            writableHighWaterMark = 1,
                                            writableSizeAlgorithm: QueuingStrategySizeCallback<I> = () => 1,
                                            readableHighWaterMark = 0,
                                            readableSizeAlgorithm: QueuingStrategySizeCallback<O> = () => 1) {
  assert(IsNonNegativeNumber(writableHighWaterMark));
  assert(IsNonNegativeNumber(readableHighWaterMark));

  const stream: TransformStream<I, O> = Object.create(TransformStream.prototype);

  let startPromise_resolve!: (value: void | PromiseLike<void>) => void;
  const startPromise = newPromise<void>(resolve => {
    startPromise_resolve = resolve;
  });

  InitializeTransformStream(stream, startPromise, writableHighWaterMark, writableSizeAlgorithm, readableHighWaterMark,
                            readableSizeAlgorithm);

  const controller: TransformStreamDefaultController<O> = Object.create(TransformStreamDefaultController.prototype);

  SetUpTransformStreamDefaultController(stream, controller, transformAlgorithm, flushAlgorithm);

  const startResult = startAlgorithm();
  startPromise_resolve(startResult);
  return stream;
}

function InitializeTransformStream<I, O>(stream: TransformStream<I, O>,
                                         startPromise: Promise<void>,
                                         writableHighWaterMark: number,
                                         writableSizeAlgorithm: QueuingStrategySizeCallback<I>,
                                         readableHighWaterMark: number,
                                         readableSizeAlgorithm: QueuingStrategySizeCallback<O>) {
  function startAlgorithm(): Promise<void> {
    return startPromise;
  }

  function writeAlgorithm(chunk: I): Promise<void> {
    return TransformStreamDefaultSinkWriteAlgorithm(stream, chunk);
  }

  function abortAlgorithm(reason: any): Promise<void> {
    return TransformStreamDefaultSinkAbortAlgorithm(stream, reason);
  }

  function closeAlgorithm(): Promise<void> {
    return TransformStreamDefaultSinkCloseAlgorithm(stream);
  }

  stream._writable = CreateWritableStream(startAlgorithm, writeAlgorithm, closeAlgorithm, abortAlgorithm,
                                          writableHighWaterMark, writableSizeAlgorithm);

  function pullAlgorithm(): Promise<void> {
    return TransformStreamDefaultSourcePullAlgorithm(stream);
  }

  function cancelAlgorithm(reason: any): Promise<void> {
    TransformStreamErrorWritableAndUnblockWrite(stream, reason);
    return promiseResolvedWith(undefined);
  }

  stream._readable = CreateReadableStream(startAlgorithm, pullAlgorithm, cancelAlgorithm, readableHighWaterMark,
                                          readableSizeAlgorithm);

  // The [[backpressure]] slot is set to undefined so that it can be initialised by TransformStreamSetBackpressure.
  stream._backpressure = undefined!;
  stream._backpressureChangePromise = undefined!;
  stream._backpressureChangePromise_resolve = undefined!;
  TransformStreamSetBackpressure(stream, true);

  // Used by IsWritableStream() which is called by SetUpTransformStreamDefaultController().
  stream._transformStreamController = undefined!;
}

function IsTransformStream<I, O>(x: any): x is TransformStream<I, O> {
  if (!typeIsObject(x)) {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(x, '_transformStreamController')) {
    return false;
  }

  return true;
}

// This is a no-op if both sides are already errored.
function TransformStreamError(stream: TransformStream, e: any) {
  ReadableStreamDefaultControllerError(stream._readable._readableStreamController as ReadableStreamDefaultController<any>,
                                       e);
  TransformStreamErrorWritableAndUnblockWrite(stream, e);
}

function TransformStreamErrorWritableAndUnblockWrite(stream: TransformStream, e: any) {
  TransformStreamDefaultControllerClearAlgorithms(stream._transformStreamController);
  WritableStreamDefaultControllerErrorIfNeeded(stream._writable._writableStreamController, e);
  if (stream._backpressure === true) {
    // Pretend that pull() was called to permit any pending write() calls to complete. TransformStreamSetBackpressure()
    // cannot be called from enqueue() or pull() once the ReadableStream is errored, so this will will be the final time
    // _backpressure is set.
    TransformStreamSetBackpressure(stream, false);
  }
}

function TransformStreamSetBackpressure(stream: TransformStream, backpressure: boolean) {
  // Passes also when called during construction.
  assert(stream._backpressure !== backpressure);

  if (stream._backpressureChangePromise !== undefined) {
    stream._backpressureChangePromise_resolve();
  }

  stream._backpressureChangePromise = newPromise(resolve => {
    stream._backpressureChangePromise_resolve = resolve;
  });

  stream._backpressure = backpressure;
}

// Class TransformStreamDefaultController

/** @public */
export type TransformStreamDefaultControllerType<O> = TransformStreamDefaultController<O>;

/** @public */
class TransformStreamDefaultController<O> {
  /** @internal */
  _controlledTransformStream: TransformStream<any, O>;
  /** @internal */
  _transformAlgorithm: (chunk: any) => Promise<void>;
  /** @internal */
  _flushAlgorithm: () => Promise<void>;

  /** @internal */
  constructor() {
    throw new TypeError('TransformStreamDefaultController instances cannot be created directly');
  }

  get desiredSize(): number | null {
    if (IsTransformStreamDefaultController(this) === false) {
      throw defaultControllerBrandCheckException('desiredSize');
    }

    const readableController = this._controlledTransformStream._readable._readableStreamController;
    return ReadableStreamDefaultControllerGetDesiredSize(readableController as ReadableStreamDefaultController<O>);
  }

  enqueue(chunk: O): void {
    if (IsTransformStreamDefaultController(this) === false) {
      throw defaultControllerBrandCheckException('enqueue');
    }

    TransformStreamDefaultControllerEnqueue(this, chunk);
  }

  error(reason: any): void {
    if (IsTransformStreamDefaultController(this) === false) {
      throw defaultControllerBrandCheckException('error');
    }

    TransformStreamDefaultControllerError(this, reason);
  }

  terminate(): void {
    if (IsTransformStreamDefaultController(this) === false) {
      throw defaultControllerBrandCheckException('terminate');
    }

    TransformStreamDefaultControllerTerminate(this);
  }
}

// Transform Stream Default Controller Abstract Operations

function IsTransformStreamDefaultController<O>(x: any): x is TransformStreamDefaultController<O> {
  if (!typeIsObject(x)) {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(x, '_controlledTransformStream')) {
    return false;
  }

  return true;
}

function SetUpTransformStreamDefaultController<I, O>(stream: TransformStream<I, O>,
                                                     controller: TransformStreamDefaultController<O>,
                                                     transformAlgorithm: (chunk: I) => Promise<void>,
                                                     flushAlgorithm: () => Promise<void>) {
  assert(IsTransformStream(stream) === true);
  assert(stream._transformStreamController === undefined);

  controller._controlledTransformStream = stream;
  stream._transformStreamController = controller;

  controller._transformAlgorithm = transformAlgorithm;
  controller._flushAlgorithm = flushAlgorithm;
}

function SetUpTransformStreamDefaultControllerFromTransformer<I, O>(stream: TransformStream<I, O>,
                                                                    transformer: Transformer<I, O>) {
  assert(transformer !== undefined);

  const controller: TransformStreamDefaultController<O> = Object.create(TransformStreamDefaultController.prototype);

  let transformAlgorithm = (chunk: I) => {
    try {
      TransformStreamDefaultControllerEnqueue(controller, chunk as unknown as O);
      return promiseResolvedWith<void>(undefined);
    } catch (transformResultE) {
      return promiseRejectedWith(transformResultE);
    }
  };
  const transformMethod = transformer.transform;
  if (transformMethod !== undefined) {
    if (typeof transformMethod !== 'function') {
      throw new TypeError('transform is not a method');
    }
    transformAlgorithm = chunk => PromiseCall(transformMethod, transformer, [chunk, controller]);
  }

  const flushAlgorithm = CreateAlgorithmFromUnderlyingMethod<typeof transformer, 'flush'>(
    transformer, 'flush', 0, [controller]
  );

  SetUpTransformStreamDefaultController(stream, controller, transformAlgorithm, flushAlgorithm);
}

function TransformStreamDefaultControllerClearAlgorithms(controller: TransformStreamDefaultController<any>) {
  controller._transformAlgorithm = undefined!;
  controller._flushAlgorithm = undefined!;
}

function TransformStreamDefaultControllerEnqueue<O>(controller: TransformStreamDefaultController<O>, chunk: O) {
  const stream = controller._controlledTransformStream;
  const readableController = stream._readable._readableStreamController as ReadableStreamDefaultController<O>;
  if (ReadableStreamDefaultControllerCanCloseOrEnqueue(readableController) === false) {
    throw new TypeError('Readable side is not in a state that permits enqueue');
  }

  // We throttle transform invocations based on the backpressure of the ReadableStream, but we still
  // accept TransformStreamDefaultControllerEnqueue() calls.

  try {
    ReadableStreamDefaultControllerEnqueue(readableController, chunk);
  } catch (e) {
    // This happens when readableStrategy.size() throws.
    TransformStreamErrorWritableAndUnblockWrite(stream, e);

    throw stream._readable._storedError;
  }

  const backpressure = ReadableStreamDefaultControllerHasBackpressure(readableController);
  if (backpressure !== stream._backpressure) {
    assert(backpressure === true);
    TransformStreamSetBackpressure(stream, true);
  }
}

function TransformStreamDefaultControllerError(controller: TransformStreamDefaultController<any>, e: any) {
  TransformStreamError(controller._controlledTransformStream, e);
}

function TransformStreamDefaultControllerPerformTransform<I, O>(controller: TransformStreamDefaultController<O>,
                                                                chunk: I) {
  const transformPromise = controller._transformAlgorithm(chunk);
  return transformPromiseWith(transformPromise, undefined, r => {
    TransformStreamError(controller._controlledTransformStream, r);
    throw r;
  });
}

function TransformStreamDefaultControllerTerminate<O>(controller: TransformStreamDefaultController<O>) {
  const stream = controller._controlledTransformStream;
  const readableController = stream._readable._readableStreamController as ReadableStreamDefaultController<O>;

  if (ReadableStreamDefaultControllerCanCloseOrEnqueue(readableController) === true) {
    ReadableStreamDefaultControllerClose(readableController);
  }

  const error = new TypeError('TransformStream terminated');
  TransformStreamErrorWritableAndUnblockWrite(stream, error);
}

// TransformStreamDefaultSink Algorithms

function TransformStreamDefaultSinkWriteAlgorithm<I, O>(stream: TransformStream<I, O>, chunk: I): Promise<void> {
  assert(stream._writable._state === 'writable');

  const controller = stream._transformStreamController;

  if (stream._backpressure === true) {
    const backpressureChangePromise = stream._backpressureChangePromise;
    assert(backpressureChangePromise !== undefined);
    return transformPromiseWith(backpressureChangePromise, () => {
      const writable = stream._writable;
      const state = writable._state;
      if (state === 'erroring') {
        throw writable._storedError;
      }
      assert(state === 'writable');
      return TransformStreamDefaultControllerPerformTransform<I, O>(controller, chunk);
    });
  }

  return TransformStreamDefaultControllerPerformTransform<I, O>(controller, chunk);
}

function TransformStreamDefaultSinkAbortAlgorithm(stream: TransformStream, reason: any): Promise<void> {
  // abort() is not called synchronously, so it is possible for abort() to be called when the stream is already
  // errored.
  TransformStreamError(stream, reason);
  return promiseResolvedWith(undefined);
}

function TransformStreamDefaultSinkCloseAlgorithm<I, O>(stream: TransformStream<I, O>): Promise<void> {
  // stream._readable cannot change after construction, so caching it across a call to user code is safe.
  const readable = stream._readable;

  const controller = stream._transformStreamController;
  const flushPromise = controller._flushAlgorithm();
  TransformStreamDefaultControllerClearAlgorithms(controller);

  // Return a promise that is fulfilled with undefined on success.
  return transformPromiseWith(flushPromise, () => {
    if (readable._state === 'errored') {
      throw readable._storedError;
    }
    const readableController = readable._readableStreamController as ReadableStreamDefaultController<O>;
    if (ReadableStreamDefaultControllerCanCloseOrEnqueue(readableController) === true) {
      ReadableStreamDefaultControllerClose(readableController);
    }
  }, r => {
    TransformStreamError(stream, r);
    throw readable._storedError;
  });
}

// TransformStreamDefaultSource Algorithms

function TransformStreamDefaultSourcePullAlgorithm(stream: TransformStream): Promise<void> {
  // Invariant. Enforced by the promises returned by start() and pull().
  assert(stream._backpressure === true);

  assert(stream._backpressureChangePromise !== undefined);

  TransformStreamSetBackpressure(stream, false);

  // Prevent the next pull() call until there is backpressure.
  return stream._backpressureChangePromise;
}

// Helper functions for the TransformStreamDefaultController.

function defaultControllerBrandCheckException(name: string): TypeError {
  return new TypeError(
    `TransformStreamDefaultController.prototype.${name} can only be used on a TransformStreamDefaultController`);
}

// Helper functions for the TransformStream.

function streamBrandCheckException(name: string): TypeError {
  return new TypeError(
    `TransformStream.prototype.${name} can only be used on a TransformStream`);
}
