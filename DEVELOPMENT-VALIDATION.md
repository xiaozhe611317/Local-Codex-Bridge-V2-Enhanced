# Isolated development validation

The package version remains 2.1.3. This checkout is a development candidate, not an official release.

Validated on Windows with Node.js v24.17.0 using the already installed local dependency copy, without downloads or new npm dependencies.

| Command | Observed result |
| --- | --- |
| npm run typecheck | Exit 0 |
| npm run build | Exit 0 |
| npm test | Exit 0; 164 tests, 163 passed, 1 macOS-only test skipped |
| npm run test:tray | Exit 0; TRAY_CORE_TESTS_OK |
| npm run test:platform | Exit 0; TRAY_CORE_TESTS_OK |

The regular suite includes independent MCP stdio parsing/initialization, exactly ten tools, original eight-tool schema/annotation regression, automatic cursor isolation and delivery rollback, no repeated consumed events, manual cursor independence, supervision/raw mode switching, bounded diagnostic expansion/recovery, real fake-child handshake/restart/UNKNOWN handling, context evidence validation, and Windows targeting/junction checks.

Native protocol behavior uses the repository's fake Codex processes. No real Codex thread, installed Bridge, Tunnel, authentication, or system permission was changed for testing. These results do not establish real macOS integration or new native context readback support. Accepted-turn effective settings remain explicitly unverified where the supported native response provides no evidence.

Latest command outputs are preserved locally under ignored `_codex_tmp/final-*.log`; prior validation results and failures are also retained in that directory. The final bounded source/dependency hash and path-only secret-pattern audit is `_codex_tmp/hash-and-secret-verification-final.json`. No dependency tree, local settings, or validation logs are included in the commit.

Final audit observed 654 matching dependency files between the read-only stable source and dev. The 15 audited stable source/document/package files match the original development HEAD and the earlier audit (normalized line endings). This is a bounded comparison, not a claim about unexamined stable files.

The secret-pattern scan covers 64 nonignored repository text files and reports paths only. No added/modified file matched. Unchanged fixture hit paths: `test/late-response-codex.mjs`, `test/runtime.test.ts`.
