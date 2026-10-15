import { randomUUID } from 'node:crypto';
import { HubError } from '../../../shared/protocol';

export function uniqueMatch<T>(items: T[], predicate: (item: T) => boolean): T | null {
    const found = items.filter(predicate);
    if (found.length > 1) throw new HubError('AMBIGUOUS_TARGET', 'More than one target matches; use its stable ID.');
    return found[0] ?? null;
}
export type Shell = 'sh' | 'fish' | 'powershell' | 'cmd';
export function shellFromHints(hints: string): Shell {
    if (/\b(pwsh|powershell)(\.exe)?\b/i.test(hints)) return 'powershell';
    if (/\bcmd(\.exe)?\b/i.test(hints)) return 'cmd';
    if (/\bfish\b/i.test(hints)) return 'fish';
    if (/\b(sh|bash|zsh|dash|ash)(\.exe)?\b/i.test(hints)) return 'sh';
    throw new HubError('UNSUPPORTED_SHELL', 'Monitored execution requires a known shell; use send_input for a REPL.');
}
export function commandWrapper(command: string, shell: Shell, nonce = randomUUID().replaceAll('-', '')) {
    const head = `__TABBY_${nonce}_`;
    const start = `${head}START__`, end = `${head}END__`;
    let text: string;
    if (shell === 'fish') {
        const escaped = command.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
        text = `printf '\\n%s%s\\n' '${head}' 'START__'; eval '${escaped}'; set -l habby_${nonce} $status; printf '\\n%s%s:%s\\n' '${head}' 'END__' $habby_${nonce}`;
    } else if (shell === 'powershell') {
        const status = `habby_${nonce}`;
        const script = `${command}\n$global:${status}_ok=$?; $global:${status}_exit=$LASTEXITCODE`;
        // One physical input line: interactive PSReadLine otherwise submits embedded newlines separately.
        const encoded = Buffer.from(script, 'utf8').toString('base64');
        // PSReadLine prediction cells can survive short output in narrow panes.
        // Clear the marker's trailing cells only on a real console, leaving pipes unchanged.
        const line = (value: string) => `[Console]::Write(${value}); if(-not [Console]::IsOutputRedirected){[Console]::Write([char]27+'[K')}; [Console]::WriteLine()`;
        // Out-Default flushes PowerShell's delayed object formatting before the completion marker.
        text = `${line(`('${head}'+'START__')`)}; $global:LASTEXITCODE=0; $global:${status}_ok=$null; $global:${status}_exit='OUTCOME_UNKNOWN'; try { . ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))) | Out-Default } catch { $global:${status}_ok=$false; $global:${status}_exit=1; $_ | Out-Default }; if (-not $global:${status}_ok -and $global:${status}_exit -eq 0) { $global:${status}_exit=1 }; [Console]::WriteLine(); ${line(`('${head}'+'END__:'+ $global:${status}_exit)`)}; Remove-Variable -Scope Global -Name '${status}_ok','${status}_exit' -ErrorAction SilentlyContinue`;
    } else if (shell === 'cmd') {
        // A child batch parser cannot consume the outer prompt's completion markers.
        // Base64 staging keeps quotes/metacharacters out of that parser and bounds each
        // input line below CMD's 8191-character limit, including for remote Windows panes.
        const payload = `habby-${nonce}.b64`, batch = `habby-${nonce}.cmd`, completion = `habby-${nonce}.done`;
        const encoded = Buffer.from(command.replace(/\r\n|\r|\n/g, '\r\n'), 'utf8').toString('base64');
        const chunks = encoded.match(/.{1,4096}/g) ?? [''];
        const staging = chunks.map((chunk, index) => `${index ? '>>' : '>'} "%TEMP%\\${payload}" echo(${chunk}`).join('\r\n');
        // Use .NET APIs only: Windows PowerShell 5.1 is present on supported Windows.
        // Batch bytes follow the pane's console code page, without an encoding preamble.
        const script = `$ErrorActionPreference='Stop'; $code=1; $created=$false; $completed=$false;
$p=[IO.Path]::Combine($env:TEMP,'${payload}'); $b=[IO.Path]::Combine($env:TEMP,'${batch}'); $done=[IO.Path]::Combine($env:TEMP,'${completion}');
try {
    $command=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([IO.File]::ReadAllText($p)));
    $bytes=[Console]::InputEncoding.GetBytes('@echo off'+[Environment]::NewLine+$command+[Environment]::NewLine+'@> "%TEMP%\\${completion}" echo ${nonce}:%errorlevel%'+[Environment]::NewLine);
    $file=[IO.File]::Open($b,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None); $created=$true;
    try { $file.Write($bytes,0,$bytes.Length) } finally { $file.Dispose() }
    $info=[Diagnostics.ProcessStartInfo]::new(); $info.FileName=$env:ComSpec;
    $info.Arguments='/d /q /s /c ""'+$b+'""'; $info.UseShellExecute=$false;
    $process=[Diagnostics.Process]::Start($info);
    try { $process.WaitForExit(); $code=$process.ExitCode } finally { $process.Dispose() }
    $proof=if ([IO.File]::Exists($done)) { [IO.File]::ReadAllText($done).Trim() } else { '' };
    if ($proof -match '^${nonce}:(-?\\d+)$') { $completed=$true; $code=[int]$Matches[1] }
} catch { [Console]::Error.WriteLine($_); $code=1 }
finally { if ($created) { [IO.File]::Delete($b) }; [IO.File]::Delete($p); [IO.File]::Delete($done) }
$status=if ($code -eq 0 -and -not $completed) { 'OUTCOME_UNKNOWN' } else { $code };
[Console]::WriteLine(); [Console]::WriteLine('${end}:'+$status);
exit $code`;
        const launcher = Buffer.from(script, 'utf16le').toString('base64');
        // CMD cwd/env changes stay in the child; send_input retains interactive state.
        // The launcher emits the completion marker only after the child has stopped and
        // its exact nonce probe has been checked. CMD can exit zero on unfinished input.
        text = `echo ${start}\r\n${staging}\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -EncodedCommand ${launcher}\r\necho.\r\necho ${end}:%errorlevel%\r\ndel /q "%TEMP%\\${payload}" >nul 2>&1`;
    } else {
        const escaped = command.replaceAll("'", "'\\''");
        text = `printf '\\n%s%s\\n' '${head}' 'START__'; eval '${escaped}'; habby_${nonce}=$?; printf '\\n%s%s:%s\\n' '${head}' 'END__' "$habby_${nonce}"`;
    }
    return { text, start, end };
}
export class CommandCapture {
    private pending = ''; private started = false; private output = ''; private truncated = false;
    constructor(private start: string, private end: string, private maxBytes = 1024 * 1024) {}
    feed(chunk: string): { output: string; exitCode?: number; truncated: boolean; error?: 'OUTCOME_UNKNOWN'; outcomeUnknown?: true } | undefined {
        this.pending += chunk;
        if (!this.started) {
            const match = new RegExp(`(?:^|\\r?\\n)${this.start}\\r?\\n`).exec(this.pending);
            if (!match) { this.pending = this.pending.slice(-this.start.length - 4); return; }
            this.pending = this.pending.slice(match.index + match[0].length); this.started = true;
        }
        const finish = new RegExp(`(?:^|\\r?\\n)${this.end}:(-?\\d+|OUTCOME_UNKNOWN)\\r?\\n`).exec(this.pending);
        if (finish) {
            this.append(this.pending.slice(0, finish.index));
            return finish[1] === 'OUTCOME_UNKNOWN'
                ? { output: this.output, truncated: this.truncated, error: 'OUTCOME_UNKNOWN', outcomeUnknown: true }
                : { output: this.output, exitCode: Number(finish[1]), truncated: this.truncated };
        }
        const keep = this.end.length + 32;
        if (this.pending.length > keep) { this.append(this.pending.slice(0, -keep)); this.pending = this.pending.slice(-keep); }
    }
    private append(data: string) {
        const value = Buffer.from(this.output + data);
        if (value.length > this.maxBytes) { this.output = value.subarray(-this.maxBytes).toString(); this.truncated = true; }
        else this.output += data;
    }
    partial() { return this.output + this.pending; }
}
export class OutputRings {
    private rings = new Map<string, { epoch: string; data: Buffer; length: number; offset: number; touched: number }>();
    private waiters = new Map<() => void, string>();
    constructor(private sessionLimit = 1024 * 1024, private totalLimit = 32 * 1024 * 1024) {}
    append(id: string, data: string | Buffer) {
        let ring = this.rings.get(id);
        if (!ring) { ring = { epoch: randomUUID(), data: Buffer.alloc(0), length: 0, offset: 0, touched: Date.now() }; this.rings.set(id, ring); }
        const incoming = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (incoming.length) {
            if (!ring.data.length) ring.data = Buffer.alloc(this.sessionLimit);
            const end = ring.offset + ring.length + incoming.length;
            const tail = incoming.subarray(-this.sessionLimit);
            const start = (end - tail.length) % this.sessionLimit;
            const first = Math.min(tail.length, this.sessionLimit - start);
            tail.copy(ring.data, start, 0, first); tail.copy(ring.data, 0, first);
            ring.length = Math.min(this.sessionLimit, ring.length + incoming.length);
            ring.offset = end - ring.length;
        }
        ring.touched = Date.now();
        while ([...this.rings.values()].reduce((n, r) => n + r.data.length, 0) > this.totalLimit) {
            const oldest = [...this.rings.entries()].filter(([, r]) => r.data.length).sort((a,b) => a[1].touched - b[1].touched || Number(a[0] === id) - Number(b[0] === id))[0];
            Object.assign(oldest[1], { epoch: randomUUID(), data: Buffer.alloc(0), length: 0, offset: 0 });
            for (const [wake, target] of [...this.waiters]) if (target === oldest[0]) wake();
        }
        for (const [wake, target] of [...this.waiters]) if (target === id) wake();
    }
    async read(id: string, cursor?: string, maxBytes = 65536, waitMs = 0, signal?: AbortSignal) {
        if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536 || waitMs < 0 || waitMs > 25000) throw new HubError('INVALID_PARAMS', 'Invalid output limits.');
        if (!this.rings.has(id)) this.append(id, '');
        const read = () => {
            const ring = this.rings.get(id)!;
            let offset = ring.offset, gap = false;
            if (cursor) {
                const [epoch, position] = cursor.split(':');
                const requested = Number(position);
                if (!Number.isSafeInteger(requested) || requested < 0 || !epoch || cursor.split(':').length !== 2) throw new HubError('INVALID_CURSOR', 'Malformed cursor.');
                if (epoch !== ring.epoch || requested < ring.offset) gap = true;
                else if (requested > ring.offset + ring.length) throw new HubError('INVALID_CURSOR', 'Cursor is ahead of output.');
                else offset = requested;
            }
            const bytes = Buffer.alloc(Math.min(maxBytes, ring.offset + ring.length - offset));
            const start = offset % this.sessionLimit;
            const first = Math.min(bytes.length, this.sessionLimit - start);
            ring.data.copy(bytes, 0, start, start + first); ring.data.copy(bytes, first, 0, bytes.length - first);
            return { data: bytes.toString('base64'), encoding: 'base64', cursor: `${ring.epoch}:${offset + bytes.length}`, gap, bytes: bytes.length };
        };
        let result = read();
        if (!result.bytes && !result.gap && waitMs && !signal?.aborted) {
            await new Promise<void>((resolve) => {
                const wake = () => { clearTimeout(timer); this.waiters.delete(wake); signal?.removeEventListener('abort', wake); resolve(); };
                const timer = setTimeout(wake, waitMs); this.waiters.set(wake, id); signal?.addEventListener('abort', wake, { once: true });
            });
            if (!this.rings.has(id)) throw new HubError('SESSION_CLOSED', 'Terminal session closed.');
            result = read();
        }
        if (signal?.aborted) throw new HubError('CANCELLED', 'Output read cancelled.');
        return result;
    }
    close(id: string) { this.rings.delete(id); for (const [wake, target] of [...this.waiters]) if (target === id) wake(); }
    dispose() { this.rings.clear(); for (const wake of [...this.waiters.keys()]) wake(); }
}
