import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local';

/**
 * DSH Desktop 2.0.3 loads node-pty from an already-unpacked Electron path.
 * node-pty then rewrites `app.asar` a second time and looks for its native
 * spawn helper below a nonexistent `app.asar.unpacked.unpacked` directory.
 *
 * Keeping this subclass in the plugin makes the identical upstream runtime
 * resolve node-pty from the plugin dependency tree, where the helper path is
 * a normal filesystem path. Process and sandbox semantics stay upstream.
 */
declare class MacOsDesktopSubprocessRuntime extends LocalSubprocessRuntime {
}

export { MacOsDesktopSubprocessRuntime as default };
