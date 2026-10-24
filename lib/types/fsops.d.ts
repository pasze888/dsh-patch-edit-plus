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
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { FsInfo, FsTarget, FsWriteOutcome } from '@deepseek-ai/dsh-fs';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
/** A write intent fetched ahead of the write phase, plus how to use it. */
export interface WriteIntent {
    /** true when this host implements the 5-param `writeText` + write-intent waterfall. */
    dance: boolean;
    intent: unknown;
}
/**
 * Fetch one write intent WITHOUT writing. Exposed so the apply phase can settle
 * every gate (the observation policy's read-before-write check fires here)
 * before the first byte of a multi-file patch is written.
 * @throws {@link PatchError} code `IO` when the gate rejects the target.
 */
export declare function resolveWriteIntent(ctx: Context, exec: ToolRunContext, target: FsTarget): Promise<WriteIntent>;
export declare function writeFile(ctx: Context, exec: ToolRunContext, target: FsTarget, content: string, sandboxPolicy: SandboxExecutionPolicy | undefined, prefetched?: WriteIntent): Promise<FsWriteOutcome>;
/** Read one file's text (whole file). */
export declare function readFile(ctx: Context, exec: ToolRunContext, target: FsTarget): Promise<string>;
/** Stat one resolved target; `undefined` when absent. */
export declare function statFile(ctx: Context, exec: ToolRunContext, target: FsTarget): Promise<FsInfo | undefined>;
