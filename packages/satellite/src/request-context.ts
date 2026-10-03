import { AsyncLocalStorage } from 'node:async_hooks';
import { HubError } from '../../../shared/protocol';
export const requestContext = new AsyncLocalStorage<AbortSignal>();
export function checkRequest() {
    if (requestContext.getStore()?.aborted) throw new HubError('CANCELLED', 'Request cancelled.');
}
