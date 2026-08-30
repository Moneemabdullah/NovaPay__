import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  requestId: string;
  userId?: string;
  transactionId?: string;
};

export const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

export const getContext = () => asyncLocalStorage.getStore();

export const withContext = <T>(ctx: RequestContext, fn: () => T): T =>
  asyncLocalStorage.run(ctx, fn);

export const setContext = (partial: Partial<RequestContext>) => {
  const store = asyncLocalStorage.getStore();
  if (store) Object.assign(store, partial);
};