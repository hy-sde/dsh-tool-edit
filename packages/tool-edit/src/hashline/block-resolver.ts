/**
 * Tree-sitter-backed {@link BlockResolver} for the hashline `N*` locator.
 *
 * The original used `blockRangeAt` from `@oh-my-pi/pi-natives` (a bundled
 * tree-sitter primitive). The harness has no such native, so this port keeps
 * the interface and returns `null` (no resolution). The parser degrades to
 * its plain range interpretation; block extensions authored by the model still
 * apply through the un-resolved path when possible, and silently-unresolvable
 * block scopes surface as ordinary mismatch/range errors.
 *
 * TODO(tree-sitter): resolve syntactic blocks once a language parser is
 * available through the harness. Keep the memoized-resolver shape from the
 * original so a native resolver can drop in here without touching the patcher.
 * Ported from @oh-my-pi/pi-coding-agent (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */
import type { BlockResolver } from '@hy-sde/dsh-hashline'

/** The exported block resolver stub used by the hashline executor. */
export const nativeBlockResolver: BlockResolver = () => null
