/**
 * Operation planning: path resolution, workspace containment, symlink policy
 * and duplicate detection. Pure resolution work — no file content is read
 * here (the engine's verify stage does that).
 * @module dsh-patch-edit-plus/apply/plan
 */
import { tmpdir } from 'node:os';
import { duplicatePathError, limitError, missingParentError, pathEscapeError, symlinkRejectedError, } from '../errors.js';
/**
 * Plan a parsed patch against the filesystem backend.
 * @param sandboxPolicy - the per-call policy the mutations will carry; its
 *   workspace root, when set, is the resolution cwd AND the containment root, so
 *   the path the engine writes is exactly the path the fence will measure.
 * @throws {@link PatchError} on limits, path escapes, symlinks, missing parents or duplicate targets.
 */
export async function buildPlan(ctx, exec, parsed, cfg, sandboxPolicy) {
    if (parsed.ops.length > cfg.maxFiles)
        throw limitError('file section count', parsed.ops.length, cfg.maxFiles);
    const fs = ctx.fs;
    const cwd = sandboxPolicy?.workspaceRoot ?? exec.agent?.session.header.cwd;
    const resolveOpts = { cwd, signal: exec.signal };
    // Containment roots: the roots the call's own sandbox policy may write under,
    // or the session workspace when no policy service is mounted. Resolving them
    // through `ctx.fs` canonicalizes exactly the way the enforcing backend does
    // (`/tmp` is `/private/tmp` on darwin), so this fence and the provider agree.
    const rootPaths = writableRootCandidates(sandboxPolicy, cwd);
    const rootTargets = [];
    for (const rootPath of rootPaths) {
        const resolved = await fs.resolve(rootPath, resolveOpts);
        if (!rootTargets.some(root => root.targetKey === resolved.targetKey))
            rootTargets.push(resolved);
    }
    const seen = new Map();
    const entries = [];
    for (const op of parsed.ops) {
        const target = await resolveChecked(fs, op.path, resolveOpts, rootTargets, cfg, seen);
        let moveToTarget;
        const moveTo = op.kind === 'update' ? op.moveTo : undefined;
        if (moveTo !== undefined)
            moveToTarget = await resolveChecked(fs, moveTo, resolveOpts, rootTargets, cfg, seen);
        if (op.kind === 'add')
            await checkParent(fs, op.path, resolveOpts);
        entries.push({ op, target, moveToTarget });
    }
    return { format: parsed.format, entries };
}
/**
 * The paths one call may write under — the same meaning the sandbox's own fence
 * derives: `workspace-write` is "the workspace root plus the platform temp
 * areas", `danger-full-access` fences nothing, and `read-only` grants nothing
 * beyond the workspace (the provider then denies the write itself).
 *
 * @deepseek-ai/dsh-sandbox exports this derivation as `writableRoots()` for
 * every enforcement dialect precisely so that "the write tool cannot write /tmp
 * but bash can" asymmetries cannot arise. This plugin is loaded as a peer of
 * many host generations (some predate that export), so the three-root meaning is
 * restated here rather than imported at runtime; it is a stable definition, and
 * the containment comparison stays authoritative in the provider.
 */
function writableRootCandidates(policy, fallbackRoot) {
    if (policy === undefined)
        return fallbackRoot === undefined ? [] : [fallbackRoot];
    if (policy.mode === 'danger-full-access')
        return [];
    if (policy.mode === 'read-only')
        return [policy.workspaceRoot];
    return [policy.workspaceRoot, '/tmp', tmpdir()];
}
/** Resolve one path with containment + symlink policy and duplicate tracking. */
async function resolveChecked(fs, path, resolveOpts, rootTargets, cfg, seen) {
    const target = await fs.resolve(path, resolveOpts);
    if (rootTargets.length > 0 && !rootTargets.some(root => fs.contains(root, target)))
        throw pathEscapeError(path);
    if (!cfg.followSymlinks)
        await rejectSymlinks(fs, path, resolveOpts);
    const previous = seen.get(target.targetKey);
    if (previous !== undefined)
        throw duplicatePathError(path);
    seen.set(target.targetKey, path);
    return target;
}
/** Reject when any path component (or the leaf) is a symbolic link. */
async function rejectSymlinks(fs, path, resolveOpts) {
    const segments = splitPath(path);
    let prefix = '';
    for (const segment of segments) {
        prefix = prefix === '' ? segment : `${prefix}/${segment}`;
        const info = await fs.lstat(prefix, { cwd: resolveOpts.cwd }, resolveOpts.signal);
        if (info !== undefined && info.type === 'symlink')
            throw symlinkRejectedError(path, prefix);
    }
}
function splitPath(path) {
    const normalized = path.replaceAll('\\', '/');
    const segments = normalized.split('/').filter(segment => segment !== '' && segment !== '.');
    // Trailing slash or root-relative paths have no meaningful segment chain.
    return segments.length === 0 ? [] : segments;
}
/** The Add parent directory must exist (the native write tool does not mkdir either). */
async function checkParent(fs, path, resolveOpts) {
    const segments = splitPath(path);
    if (segments.length <= 1)
        return; // parent is the workspace root itself
    const parent = segments.slice(0, -1).join('/');
    const info = await fs.lstat(parent, { cwd: resolveOpts.cwd }, resolveOpts.signal);
    if (info === undefined)
        throw missingParentError(path, parent);
    if (info.type !== 'directory')
        throw missingParentError(path, parent);
}
/** True when the operation needs the shell backend (delete or move). */
export function needsShell(op) {
    return op.kind === 'delete' || (op.kind === 'update' && op.moveTo !== undefined);
}
