# Local development baseline

- Source: D:\CodexBridge\upstream\Local-Codex-Bridge
- Version: 2.1.3. Source has no .git metadata; this is a local snapshot baseline, not an upstream commit/tag.
- Captured at: 2026-09-08T19:48:09.625Z
- Manifest SHA-256: e3c530cb44518ab8992b0dec9f9067440bb9bd027412141d092da0dc3d674bb4
- Manifest: 80 regular files / 843820 bytes, including 20 dist files / 279547 bytes.
- node_modules existed and was omitted from both copies (654 files). Rebuild from the copied package-lock.json using npm ci on Node.js >=24 when separately authorized. No npm ci, downloads, builds or tests were run.
- All other ordinary project/build files were copied, including dotfiles, package metadata/lockfile, source, tests, Windows assets, scripts, documentation and dist. Non-excluded empty directories were preserved.
- No .env or .env.* files were found.
- The tokenFlags* filename matches are in the TypeScript dependency tree and are not confirmed credentials. Their contents were not read; all are covered by the omitted node_modules directory.
- High-confidence secret signature screening of included files found no matches. This bounded screen cannot rule out arbitrary embedded credentials.
- Stable source, Tunnel configuration, Codex login, global Git configuration and system settings were not modified.

- Backup: D:\CodexBridge\backups\stable-v2.1.3-pre-enhancements-20260909
- Branch: feat/supervisor-enhancements.
- Repository-only author: Local Codex Bridge Dev <local@localhost.invalid>.
- Git is initialized only in this dev directory; automatic line-ending conversion is disabled locally to retain bytes.
- The baseline tracks source files allowed by the original .gitignore, this note and explicit sensitive-path additions to .gitignore. dist exists but remains ignored; node_modules is absent.

## Sensitive exclusions

- node_modules/typescript/dist/enums/tokenFlags.d.ts — excluded-sensitive; existence/path only; content not read or copied.
- node_modules/typescript/dist/enums/tokenFlags.d.ts.map — excluded-sensitive; existence/path only; content not read or copied.
- node_modules/typescript/dist/enums/tokenFlags.enum.d.ts — excluded-sensitive; existence/path only; content not read or copied.
- node_modules/typescript/dist/enums/tokenFlags.enum.d.ts.map — excluded-sensitive; existence/path only; content not read or copied.
- node_modules/typescript/dist/enums/tokenFlags.enum.js — excluded-sensitive; existence/path only; content not read or copied.
- node_modules/typescript/dist/enums/tokenFlags.enum.js.map — excluded-sensitive; existence/path only; content not read or copied.
- node_modules/typescript/dist/enums/tokenFlags.js — excluded-sensitive; existence/path only; content not read or copied.
- node_modules/typescript/dist/enums/tokenFlags.js.map — excluded-sensitive; existence/path only; content not read or copied.

## Verification scope

- All 80 copied source files were verified against the saved source manifest before the dev .gitignore amendment.
- Later dev verification permits only that documented .gitignore amendment. The stable source and backup retain the original.
- Source is checked again after Git initialization. INITIALIZATION-REPORT.json in the backup records the final check and commit.
