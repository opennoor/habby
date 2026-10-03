import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandCapture, commandWrapper } from '../packages/satellite/src/runtime.ts';

// Windows local and version-release test runs use actual cmd.exe and PS5.1.
// Other hosts skip; a string-shape assertion is not evidence of native CMD parsing.
function runCommands(t: any, commands: string[], setup = '') {
    const timeout = Number(process.env.TABBY_HUB_NATIVE_TEST_TIMEOUT_MS ?? 30000);
    assert.ok(Number.isInteger(timeout) && timeout >= 30000 && timeout <= 900000, 'Invalid native test timeout.');
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
            windowsVerbatimArguments: true, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024,
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
        'echo "quoted & (parentheses)"\necho caret^&pipe^|angle^<^>\necho literal %% percent\necho café\necho %tabby_cmd_inherited%',
    ], 'set "tabby_cmd_inherited=from-parent"');
    assert.equal(result.exitCode, 0);
    assert.equal(result.output.replaceAll('\r\n', '\n'), '"quoted & (parentheses)"\ncaret&pipe|angle<>\nliteral % percent\ncafé\nfrom-parent\n');
});

test('native CMD reports unproven zero exits honestly and retains the outer prompt', { skip: process.platform !== 'win32' }, t => {
    const results = runCommands(t, ['echo before-failure\nexit /b 7', 'cmd /d /c exit 7', 'if 1==1 (', 'echo outer-still-usable', 'exit /b 0']);
    t.diagnostic(`Captured native CMD outcomes: ${JSON.stringify(results)}`);
    assert.equal(results[0].exitCode, 7, JSON.stringify(results[0])); assert.match(results[0].output, /before-failure/);
    assert.equal(results[1].exitCode, 7, `Completion probe must preserve native failure: ${JSON.stringify(results[1])}`);
    const incomplete = results[2], details = `Incomplete IF must never report success: ${JSON.stringify(incomplete)}`;
    if (incomplete.exitCode !== undefined) {
        assert.ok(Number.isInteger(incomplete.exitCode), details);
        assert.notEqual(incomplete.exitCode, 0, details);
    } else {
        assert.equal(incomplete.error, 'OUTCOME_UNKNOWN', details);
        assert.equal(incomplete.outcomeUnknown, true, details);
        assert.equal(Object.hasOwn(incomplete, 'exitCode'), false, details);
    }
    const earlyZero = results[4], earlyDetails = `Early zero exit has no completion proof: ${JSON.stringify(earlyZero)}`;
    assert.equal(earlyZero.error, 'OUTCOME_UNKNOWN', earlyDetails);
    assert.equal(earlyZero.outcomeUnknown, true, earlyDetails);
    assert.equal(Object.hasOwn(earlyZero, 'exitCode'), false, earlyDetails);
    assert.equal(results[3].exitCode, 0, JSON.stringify(results[3])); assert.match(results[3].output, /outer-still-usable/);
});

test('native CMD child inherits cwd/environment but changes do not persist; large payloads are staged', { skip: process.platform !== 'win32' }, t => {
    const commands = [
        'echo %tabby_cmd_state%\ncd\nset "tabby_cmd_state=child"\ncd "__CHILD_DIRECTORY__"\necho %tabby_cmd_state%\ncd\nexit /b 4',
        'echo %tabby_cmd_state%\ncd',
        Array.from({ length: 200 }, (_, index) => `rem ${index} ${'x'.repeat(90)}`).join('\n') + '\necho staged-large-command',
    ];
    assert.ok(commands[2].length > 8191);
    const [child, followup, large] = runCommands(t, commands, 'set "tabby_cmd_state=parent"');
    assert.equal(child.exitCode, 4); assert.match(child.output, /^parent\r?\n/); assert.match(child.output, /child directory/);
    assert.equal(followup.exitCode, 0); assert.match(followup.output, /^parent\r?\n/); assert.doesNotMatch(followup.output, /child directory/);
    assert.equal(large.exitCode, 0); assert.match(large.output, /staged-large-command/);
});

test('command capture recognizes only its exact unknown-outcome completion marker', () => {
    const wrapper = commandWrapper('echo test', 'cmd', 'abc');
    const capture = new CommandCapture(wrapper.start, wrapper.end);
    const text = `${wrapper.start}\r\npartial output\r\n__TABBY_other_END__:OUTCOME_UNKNOWN\r\n${wrapper.end}:OUTCOME_UNKNOWN\r\n${wrapper.end}:0\r\n`;
    let result: ReturnType<CommandCapture['feed']>;
    for (const character of text) { result = capture.feed(character); if (result) break; }
    const expected = { output: 'partial output\r\n__TABBY_other_END__:OUTCOME_UNKNOWN', truncated: false,
        error: 'OUTCOME_UNKNOWN', outcomeUnknown: true };
    assert.deepEqual(result, expected);
    assert.deepEqual(new CommandCapture(wrapper.start, wrapper.end).feed(text), expected,
        'The first unknown marker must win over a later numeric fallback in the same chunk.');
});
