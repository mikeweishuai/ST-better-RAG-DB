/**
 * Worker 的 Promise 化封装。单例、惰性创建,按请求 id 配对回包。
 */

import type {
  PostingsResult,
  QuantizeResult,
  WorkerRequest,
  WorkerResponse,
} from './worker.ts';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const res = ev.data;
    const slot = pending.get(res.id);
    if (!slot) return;
    pending.delete(res.id);
    if (res.ok) slot.resolve(res.result as never);
    else slot.reject(new Error(res.error));
  };

  // Worker 整体崩掉时,所有在途请求一起失败,否则调用方会永远挂着
  worker.onerror = e => {
    const err = new Error(`索引 Worker 异常:${e.message}`);
    for (const [, slot] of pending) slot.reject(err);
    pending.clear();
    worker?.terminate();
    worker = null;
  };

  return worker;
}

/** 联合类型上的 Omit 不会逐成员分发,得显式分发,否则各分支的独有字段会被抹掉。 */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

function send<R>(req: WithoutId<WorkerRequest>, transfer: Transferable[] = []): Promise<R> {
  const w = ensureWorker();
  const id = ++seq;
  return new Promise<R>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: never) => void, reject });
    w.postMessage({ ...req, id } as WorkerRequest, transfer);
  });
}

export function buildPostingsInWorker(documents: string[]): Promise<PostingsResult> {
  return send<PostingsResult>({ type: 'postings', documents });
}

/** 传入已 L2 归一化的向量;buffer 所有权转移给 Worker,调用方不得再用 flat。 */
export function quantizeInWorker(flat: Float32Array, dim: number): Promise<QuantizeResult> {
  return send<QuantizeResult>({ type: 'quantize', flat, dim }, [flat.buffer]);
}

/** 供设置页「重置」之类的场景强制回收。 */
export function terminateWorker(): void {
  worker?.terminate();
  worker = null;
  pending.clear();
}
