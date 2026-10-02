import { X509Certificate, createHash, randomUUID } from 'node:crypto';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import type { ClientRequestArgs } from 'node:http';
import { WebSocket } from 'ws';
import { authorize } from '../../../shared/catalog';
import { HubError, MAX_FRAME_BYTES, PROTOCOL_VERSION, wireMessageSchema, type Snapshot, type SatelliteTrust, type Principal } from '../../../shared/protocol';

export interface SatelliteAdapter {
    snapshot(): Promise<Snapshot>;
    capabilities(): string[];
    run(operation: string, params: Record<string, unknown>, principal: Principal, signal: AbortSignal): Promise<unknown>;
    disconnect?(): void;
}
export function validateTrust(trust: SatelliteTrust): URL {
    const url = new URL(trust.url);
    if (url.protocol !== 'wss:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/satellite') throw new HubError('INVALID_HUB', 'Satellite requires a loopback WSS /satellite endpoint.');
    if (!trust.certificate.includes('BEGIN CERTIFICATE') || trust.credential.length < 32 || !trust.spkiPin) throw new HubError('INVALID_TRUST', 'Invalid satellite trust file.');
    return url;
}
export function verifyPin(raw: Buffer, pin: string) {
    const cert = new X509Certificate(raw);
    const spki = cert.publicKey.export({ format: 'der', type: 'spki' });
    const digest = createHash('sha256').update(spki).digest('base64');
    if (pin.replace(/^sha256\//, '') !== digest) throw new HubError('TLS_PIN_MISMATCH', 'Hub TLS identity changed. Rerun local setup.');
}
export class SatelliteClient {
    readonly windowId = randomUUID();
    status = 'disconnected';
    private socket?: WebSocket;
    private epoch?: string;
    private resumeToken?: string;
    private sequence = 0;
    private stopped = false;
    private attempts = 0;
    private retry?: ReturnType<typeof setTimeout>;
    private pulse?: ReturnType<typeof setInterval>;
    private refresh?: ReturnType<typeof setInterval>;
    private requests = new Map<string, { controller: AbortController; fingerprint: string; promise: Promise<unknown> }>();
    private results = new Map<string, { fingerprint: string; result?: unknown; error?: { code: string; message: string }; time: number; bytes: number }>();
    constructor(private loadTrust: () => SatelliteTrust, private adapter: SatelliteAdapter, private metadata: Record<string, unknown> = {}) {}
    start() { this.stopped = false; void this.connect(); }
    stop() {
        this.stopped = true; clearTimeout(this.retry); this.cleanup(); this.socket?.close();
        this.adapter.disconnect?.(); this.status = 'stopped';
    }
    private cleanup() {
        this.epoch = undefined; clearInterval(this.pulse); clearInterval(this.refresh);
        for (const item of this.requests.values()) item.controller.abort();
    }
    private send(message: unknown) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
    private async connect() {
        if (this.stopped) return;
        this.status = 'connecting';
        try {
            const trust = this.loadTrust(); const url = validateTrust(trust);
            const socket = this.socket = new WebSocket(url, {
                agent: false, maxPayload: MAX_FRAME_BYTES,
                ca: trust.certificate, rejectUnauthorized: true,
                // HTTP headers (including credential) are sent only after TLS certificate verification.
                checkServerIdentity: (host: string, cert: PeerCertificate) => {
                    const invalid = checkServerIdentity(host, cert); if (invalid) return invalid;
                    try { verifyPin(cert.raw, trust.spkiPin); } catch (error) { return error as Error; }
                },
                headers: { Authorization: `Bearer ${trust.credential}` },
                handshakeTimeout: 10000,
                lookup: url.hostname === 'localhost' ? ((_host: string, options: any, callback: any) => options?.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4)) as any : undefined,
            } as ClientRequestArgs);
            let lastPong = Date.now();
            let registrationTimer: ReturnType<typeof setTimeout> | undefined;
            socket.on('pong', () => { lastPong = Date.now(); });
            socket.on('open', async () => {
                if (this.stopped || socket !== this.socket) { socket.close(); return; }
                try {
                    registrationTimer = setTimeout(() => { if (!this.epoch) socket.close(1008, 'Registration timed out'); }, 10000);
                    this.send({ type: 'register', protocol: PROTOCOL_VERSION, windowId: this.windowId, resumeToken: this.resumeToken, metadata: this.metadata, capabilities: this.adapter.capabilities(), snapshot: await this.adapter.snapshot() });
                    this.pulse = setInterval(() => {
                        if (Date.now() - lastPong > 30000) { socket.terminate(); return; }
                        socket.ping();
                        if (this.epoch) this.send({ type: 'heartbeat', windowId: this.windowId, epoch: this.epoch });
                    }, 10000);
                } catch { socket.close(1011, 'Snapshot failed'); }
            });
            socket.on('message', data => {
                if (socket !== this.socket) return;
                try {
                    const message = wireMessageSchema.parse(JSON.parse(data.toString()));
                    if (message.type === 'registered') {
                        if (this.epoch || message.windowId !== this.windowId) throw new Error();
                        clearTimeout(registrationTimer); this.epoch = message.epoch; this.resumeToken = message.resumeToken; this.sequence = 0; this.attempts = 0; this.status = 'connected';
                        this.refresh = setInterval(() => void this.snapshot(), 3000); return;
                    }
                    if (!('windowId' in message) || message.windowId !== this.windowId || !('epoch' in message) || message.epoch !== this.epoch) throw new Error();
                    if (message.type === 'request') void this.request(message);
                    else if (message.type === 'cancel') this.requests.get(message.id)?.controller.abort();
                    else if (message.type === 'resnapshot') void this.snapshot();
                    else if (message.type !== 'heartbeat') throw new Error();
                } catch { socket.close(1008, 'Invalid Hub message'); }
            });
            socket.on('error', () => { if (socket === this.socket) this.status = 'disconnected'; });
            socket.on('close', () => {
                if (socket !== this.socket) return;
                clearTimeout(registrationTimer); this.cleanup(); this.status = 'disconnected'; this.schedule();
            });
        } catch { this.status = 'setup required'; this.schedule(); }
    }
    private schedule() {
        if (this.stopped) return;
        const ceiling = Math.min(30000, 500 * 2 ** Math.min(this.attempts++, 6));
        this.retry = setTimeout(() => void this.connect(), Math.max(100, Math.floor(ceiling * (0.5 + Math.random() * 0.5))));
    }
    private async snapshot() {
        const epoch = this.epoch;
        if (!epoch) return;
        try {
            const data = await this.adapter.snapshot();
            if (epoch === this.epoch) this.send({ type: 'event', windowId: this.windowId, epoch, sequence: ++this.sequence, event: 'snapshot', data });
        } catch { this.socket?.close(1011, 'Snapshot failed'); }
    }
    private async request(message: Extract<ReturnType<typeof wireMessageSchema.parse>, { type: 'request' }>) {
        const { id, epoch, operation, params, principal } = message;
        let result: unknown, error: { code: string; message: string } | undefined;
        const fingerprint = JSON.stringify([operation, params, principal]);
        try {
            authorize(principal, operation, params, this.windowId);
            const cached = this.results.get(id), pending = this.requests.get(id);
            if ((cached && cached.fingerprint !== fingerprint) || (pending && pending.fingerprint !== fingerprint)) throw new HubError('REQUEST_CONFLICT', 'Request ID reused with different parameters.');
            if (cached) { result = cached.result; error = cached.error; }
            else {
                if (pending) result = await pending.promise;
                else {
                    if (this.requests.size >= 128) throw new HubError('SATELLITE_BUSY', 'Too many in-flight requests.');
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), message.timeoutMs);
                    const promise = this.adapter.run(operation, params, principal, controller.signal);
                    this.requests.set(id, { controller, fingerprint, promise });
                    try { result = await promise; }
                    finally { clearTimeout(timer); this.requests.delete(id); }
                }
            }
        } catch (cause) { error = { code: cause instanceof HubError ? cause.code : 'OPERATION_FAILED', message: cause instanceof Error ? cause.message.slice(0, 2048) : 'Operation failed.' }; }
        const bytes = Buffer.byteLength(JSON.stringify({ result, error }));
        if (bytes <= 1024 * 1024 && (!this.results.has(id) || this.results.get(id)!.fingerprint === fingerprint) && (!this.requests.has(id) || this.requests.get(id)!.fingerprint === fingerprint)) this.results.set(id, { fingerprint, result, error, time: Date.now(), bytes });
        let size = [...this.results.values()].reduce((n, x) => n + x.bytes, 0);
        for (const [key, value] of this.results) {
            if (Date.now() - value.time > 300000 || this.results.size > 128 || size > 8 * 1024 * 1024) { this.results.delete(key); size -= value.bytes; }
        }
        if (bytes > MAX_FRAME_BYTES - 1024) { result = undefined; error = { code: 'RESPONSE_TOO_LARGE', message: 'Use bounded buffer ranges or read_terminal_output.' }; }
        await this.snapshot();
        if (epoch === this.epoch) this.send({ type: 'response', id, windowId: this.windowId, epoch, result, error });
    }
}
