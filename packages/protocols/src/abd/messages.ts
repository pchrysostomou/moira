import type { Message } from 'moirae-core';
import type { RegisterValue } from './state';

export interface ReadPhase1Query extends Message {
  readonly type: 'ReadPhase1Query';
  readonly operationId: string;
}

export interface ReadPhase1Response extends Message {
  readonly type: 'ReadPhase1Response';
  readonly operationId: string;
  readonly value: RegisterValue;
}

export interface ReadPhase2WriteBack extends Message {
  readonly type: 'ReadPhase2WriteBack';
  readonly operationId: string;
  readonly value: RegisterValue;
}

export interface ReadPhase2Ack extends Message {
  readonly type: 'ReadPhase2Ack';
  readonly operationId: string;
}

export interface WriteRequest extends Message {
  readonly type: 'WriteRequest';
  readonly operationId: string;
  readonly value: RegisterValue;
}

export interface WriteAck extends Message {
  readonly type: 'WriteAck';
  readonly operationId: string;
}

export type ABDMessage =
  | ReadPhase1Query
  | ReadPhase1Response
  | ReadPhase2WriteBack
  | ReadPhase2Ack
  | WriteRequest
  | WriteAck;
