import { Injectable } from '@angular/core';
@Injectable({ providedIn: 'root' })
export class McpLoggerService {
    // Keep terminal payloads, authentication responses and command text out of logs.
    debug(..._args: unknown[]) {}
    info(..._args: unknown[]) {}
    warn(message: string, ..._args: unknown[]) { console.warn('[Habby]', message.split(':')[0]); }
    error(message: string, ..._args: unknown[]) { console.error('[Habby]', message.split(':')[0]); }
}
