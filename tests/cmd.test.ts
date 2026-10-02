import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandCapture, commandWrapper } from '../packages/satellite/src/runtime.ts';

// The ordinary Windows CI test glob runs these against actual cmd.exe and PS5.1.
// Other hosts skip; a string-shape assertion is not evidence of native CMD parsing.
function runCommands(t: any, commands: string[], setup = '') {
    const directory = mkdtempSync(join(tmpdir(), 'tabby-cmd-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const payloadDir = join(directory, 'payload space & (parentheses) café');
    mkdirSync(payloadDir);
    const nested = join(directory, 'child directory'); mkdirSync(nested);
    const wrappers = commands.map(command => commandWrapper(command.replaceAll('__CHILD_DIRECTORY__', nested), 'cmd'));
    const outer = join(directory, 'outer.cmd');
    writeFileSync(outer, `@echo off\r\nchcp 65001 >nul\r\n${setup}\r\n${wrappers.map(wrapper => wrapper.text).join('\r\n')}\r\nexit /b 0\r\n`);
    const native = spawnSync(process.env.ComSpec ?? join(process.env.SystemRoot!, 'System32', 'cmd.exe'),
        ['/d', '/q', '/v:off', '/s', '/c', `""${outer}""`], {
            cwd: directory, env: { ...process.env, TEMP: payloadDir, TMP: payloadDir },
            windowsVerbatimArguments: true, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
        });
    assert.ifError(native.error);
    assert.equal(native.status, 0, `Outer CMD must survive all child commands.\n${native.stdout}\n${native.stderr}`);
    assert.deepEqual(readdirSync(payloadDir), [], 'Every temporary CMD/payload file must be cleaned up.');
    return wrappers.map(wrapper => {
        const capture = new CommandCapture(wrapper.start, wrapper.end);
        // The production parser must recognize markers even across arbitrary chunks.
        let result: ReturnType<CommandCapture['feed']>;
        for (let offset = 0; offset < native.stdout.length && !result; offset += 7) result = capture.feed(native.stdout.slice(offset, offset + 7));
        assert.ok(result, `Native CMD did not complete this command.\n${native.stdout}\n${native.stderr}`);
        return result;
    });
}

test('native CMD preserves multiline quotes, metacharacters, percent expansion and UTF-8 output', { skip: process.platform !== 'win32' }, t => {
    const [result] = runCommands(t, [
        'echo "quoted & (parentheses)"\necho caret^&pipe^|angle^<^>\necho literal %% percent\necho café\necho %tabby_cmd_inherited%\nexit /b 0',
    ], 'set "tabby_cmd_inherited=from-parent"');
    assert.equal(result.exitCode, 0);
    assert.equal(result.output.replaceAll('\r\n', '\n'), '"quoted & (parentheses)"\ncaret&pipe|angle<>\nliteral % percent\ncafé\nfrom-parent\n');
});

test('native CMD completion survives nonzero exits and incomplete IF before another outer command', { skip: process.platform !== 'win32' }, t => {
    // Temporary native-only diagnosis: compare /c argument parsing with batch EOF.
    // Keep the production assertion below intact until a real parser boundary is proven.
    const cases = [
        ['multiline', 'echo raw-first\r\necho raw-second'],
        ['balanced-group', 'if 1==1 (\r\necho grouped-first\r\necho grouped-second\r\n)'],
        ['incomplete-group', 'if 1==1 ('],
        ['multiline-incomplete', 'echo before-incomplete\r\nif 1==1 ('],
        ['exit-zero', 'exit /b 0'], ['exit-seven', 'exit /b 7'],
        ['literal-percent', 'echo literal %% percent'],
        ['quoted-metacharacters', 'echo "quoted & (parentheses)" & echo caret^&pipe^|angle^<^>'],
    ];
    for (const [name, command] of cases) {
        const native = spawnSync(process.env.ComSpec!, ['/d', '/q', '/s', '/c', `"${command}"`], {
            windowsVerbatimArguments: true, encoding: 'utf8', timeout: 10000,
        });
        t.diagnostic(JSON.stringify({ rawCmdCase: name, status: native.status, error: native.error?.message,
            stdout: native.stdout, stderr: native.stderr }));
    }
    const results = runCommands(t, ['echo before-failure\nexit /b 7', 'if 1==1 (', 'echo outer-still-usable\nexit /b 0']);
    assert.equal(results[0].exitCode, 7); assert.match(results[0].output, /before-failure/);
    assert.notEqual(results[1].exitCode, 0, 'Incomplete syntax must fail, not consume the outer completion marker.');
    assert.equal(results[2].exitCode, 0); assert.match(results[2].output, /outer-still-usable/);
});

test('native CMD child inherits cwd/environment but changes do not persist; large payloads are staged', { skip: process.platform !== 'win32' }, t => {
    const commands = [
        'echo %tabby_cmd_state%\ncd\nset "tabby_cmd_state=child"\ncd "__CHILD_DIRECTORY__"\necho %tabby_cmd_state%\ncd\nexit /b 4',
        'echo %tabby_cmd_state%\ncd\nexit /b 0',
        Array.from({ length: 200 }, (_, index) => `rem ${index} ${'x'.repeat(90)}`).join('\n') + '\necho staged-large-command\nexit /b 0',
    ];
    assert.ok(commands[2].length > 8191);
    const [child, followup, large] = runCommands(t, commands, 'set "tabby_cmd_state=parent"');
    assert.equal(child.exitCode, 4); assert.match(child.output, /^parent\r?\n/); assert.match(child.output, /child directory/);
    assert.equal(followup.exitCode, 0); assert.match(followup.output, /^parent\r?\n/); assert.doesNotMatch(followup.output, /child directory/);
    assert.equal(large.exitCode, 0); assert.match(large.output, /staged-large-command/);
});
