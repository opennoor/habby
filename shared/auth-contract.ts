import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HubConfig, Principal } from './protocol.js';

/** The public listener delegates OAuth and owner UI routes to this boundary. */
export interface PublicAuth {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  authenticate(req: IncomingMessage): Promise<Principal>;
  isAuthorized(principal: Principal): Promise<boolean>;
  enrollmentLink(): Promise<string>;
  close(): Promise<void>;
}
export type PublicAuthFactory = (config: HubConfig) => Promise<PublicAuth>;
