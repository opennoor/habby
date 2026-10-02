import { Injectable } from '@angular/core';
@Injectable({ providedIn: 'root' })
export class McpLoggerService {
    // Keep terminal payloads, authentication responses and command text out of logs.
    debug(..._args: unknown[]) {}
    info(..._args: unknown[]) {}
    warn(message: string, ..._args: unknown[]) { console.warn('[Tabby Hub]', message.split(':')[0]); }
    error(message: string, ..._args: unknown[]) { console.error('[Tabby Hub]', message.split(':')[0]); }
}
