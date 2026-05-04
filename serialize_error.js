/**
 * Turn any thrown value into a JSON-safe object for logs and /health responses.
 * No passwords or cookie values — pass only Error objects, not full requests.
 */
function serializeError(err, options = {}) {
    const maxStack = options.maxStackChars ?? 12000;
    const maxCauseDepth = options.maxCauseDepth ?? 10;

    if (err == null) {
        return { kind: 'empty', message: String(err) };
    }
    if (typeof err === 'string') {
        return { kind: 'string', message: err };
    }
    if (typeof err !== 'object') {
        return { kind: typeof err, message: String(err) };
    }

    const out = {
        kind: 'Error',
        name: err.name || 'Error',
        message: err.message || String(err),
    };
    if (err.code != null) out.code = err.code;
    if (err.errno != null) out.errno = err.errno;
    if (err.syscall != null) out.syscall = err.syscall;
    if (err.address != null) out.address = err.address;
    if (err.port != null) out.port = err.port;
    if (err.step != null) out.step = err.step;
    if (err.pageUrl != null) out.pageUrl = err.pageUrl;
    if (err.cookieCount != null) out.cookieCount = err.cookieCount;
    if (err.localStorageKeys != null) out.localStorageKeys = err.localStorageKeys;
    if (typeof err.stack === 'string') {
        out.stack = err.stack.length > maxStack ? err.stack.slice(0, maxStack) + '\n…(truncated)' : err.stack;
    }

    const causes = [];
    let c = err.cause;
    let depth = 0;
    while (c != null && depth < maxCauseDepth) {
        if (typeof c === 'string') {
            causes.push({ kind: 'string', message: c });
        } else if (c && typeof c === 'object') {
            causes.push({
                kind: 'Error',
                name: c.name,
                message: c.message || String(c),
                code: c.code,
                errno: c.errno,
                syscall: c.syscall,
                stack: typeof c.stack === 'string' ? c.stack.slice(0, 4000) : undefined,
            });
        } else {
            causes.push({ kind: typeof c, message: String(c) });
        }
        c = c && typeof c === 'object' && 'cause' in c ? c.cause : null;
        depth++;
    }
    if (causes.length) out.causeChain = causes;

    if (Array.isArray(err.errors)) {
        out.aggregateErrors = err.errors.map((e) => serializeError(e, { maxStackChars: 4000, maxCauseDepth: 3 }));
    }

    return out;
}

function formatErrorLogLine(prefix, err) {
    const s = serializeError(err);
    return `${prefix}${s.name}: ${s.message}${s.code != null ? ` [code=${s.code}]` : ''}${s.errno != null ? ` [errno=${s.errno}]` : ''}`;
}

module.exports = { serializeError, formatErrorLogLine };
