/**
 * Filesystem seam: reads plus the official write-intent dance.
 *
 * DSH providers NEVER dispatch `fs/*` events — the tool layer is the only
 * initiator — so a bare `ctx.fs.writeText` would silently bypass the
 * read-before-write gate. Every write here therefore replicates the official
 * `write` tool verbatim:
 * 1. `ctx.waterfall('fs/write-intent', target, exec, () => undefined)`
 * 2. `ctx.fs.writeText(target, content, intent, exec.signal, sandboxPolicy)`
 * 3. `ctx.emit('fs/observed', target, { kind: 'present', version }, exec)`
 * With no policy plugin mounted the waterfall returns `undefined`, which is
 * itself the correct "unconditional write" probe.
 * @module dsh-patch-edit-plus/fsops
 */
import { ioError } from './errors.js';
/**
 * Write one file through the full intent dance. Must stay byte-for-byte the
 * official sequence — the verification script asserts it.
 * Old lines (0.1.0/0.1.1) may lack the write-intent events or the 5-param
 * writeText; degrade to a plain 2-param write with a one-time warning — the
 * read-before-write gate is a hardening, not a hard dependency.
 * @throws {@link PatchError} code `IO` when the backend rejects the write.
 */
let fsShapeWarned = false;
function warnFsShapeOnce(detail) {
    if (fsShapeWarned)
        return;
    fsShapeWarned = true;
    console.warn(`[dsh-patch-edit-plus] falling back to plain fs writes on this host line (${detail}); the read-before-write intent gate is unavailable.`);
}
/**
 * Fetch one write intent WITHOUT writing. Exposed so the apply phase can settle
 * every gate (the observation policy's read-before-write check fires here)
 * before the first byte of a multi-file patch is written.
 * @throws {@link PatchError} code `IO` when the gate rejects the target.
 */
export async function resolveWriteIntent(ctx, exec, target) {
    try {
        const writeText = ctx.fs.writeText.bind(ctx.fs);
        if (writeText.length !== 2 && typeof ctx.waterfall === 'function') {
            return { dance: true, intent: await ctx.waterfall('fs/write-intent', target, exec, () => undefined) };
        }
        return { dance: false, intent: undefined };
    }
    catch (error) {
        if (error instanceof Error && error.name === 'PatchError')
            throw error;
        throw ioError(`failed to write "${target.displayPath}"`, error);
    }
}
export async function writeFile(ctx, exec, target, content, sandboxPolicy, prefetched) {
    try {
        const writeText = ctx.fs.writeText.bind(ctx.fs);
        const gate = prefetched ?? await resolveWriteIntent(ctx, exec, target);
        // 5 参意图舞（write-intent + observed 事件）只在实现了它的代上走；判定取等：仅当形参恰为 2（老线签名）才降级直写——stub/新线的
        // mock length 常为 0，取等避免误伤意图舞。
        if (gate.dance) {
            const outcome = await writeText(target, content, gate.intent, exec.signal, sandboxPolicy);
            if (typeof ctx.emit === 'function') {
                ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec);
            }
            return outcome;
        }
        warnFsShapeOnce('no write-intent arity / no waterfall');
        return await writeText(target, content);
    }
    catch (error) {
        if (error instanceof Error && error.name === 'PatchError')
            throw error;
        throw ioError(`failed to write "${target.displayPath}"`, error);
    }
}
/** Read one file's text (whole file). */
export async function readFile(ctx, exec, target) {
    try {
        return await ctx.fs.readText(target, exec.signal);
    }
    catch (error) {
        throw ioError(`failed to read "${target.displayPath}"`, error);
    }
}
/** Stat one resolved target; `undefined` when absent. */
export async function statFile(ctx, exec, target) {
    try {
        return await ctx.fs.stat(target, exec.signal);
    }
    catch (error) {
        throw ioError(`failed to stat "${target.displayPath}"`, error);
    }
}
