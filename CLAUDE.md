# PDM Canvas

A desktop database-modeling tool that imports, edits, and saves PowerDesigner Physical Data Model (`.pdm`) files, staying interoperable with PowerDesigner: a file created in PowerDesigner, edited in PDM Canvas, must reopen and remain editable in PowerDesigner.

- Repository: `pdm-canvas`; product name in window titles and README: **PDM Canvas**.
- UI language: Simplified Chinese. Table/column codes, data types, and SQL stay in English.

## Scope

- **File format:** XML-format PDM only. Binary PDM is out of scope — users must re-save it as XML in PowerDesigner.
- **Databases (initial):** Oracle 11g, MySQL, PostgreSQL. Oracle 11g is implemented and verified first.
- **Platforms:** Windows first, then macOS (Linux later). One codebase, per-platform packaging.
- **PowerDesigner version:** pin the exact version used to produce test files and record it in `test-fixtures/README.md`.

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron (packaged with Electron Forge) |
| Language | TypeScript (strict) |
| UI | React + Ant Design |
| ER diagram | AntV X6 |
| XML | Own offset-tracking scanner (`src/pdm/xml.ts`) — no DOM library |
| Tests / lint | Vitest, oxlint, oxfmt |

A Java helper process (JDBC) may be added later for reverse-engineering live databases; not needed for file editing.

## Architecture rules (do not violate)

1. **Preserve the original XML; patch, don't regenerate.** On import, keep the original file text plus element offsets alongside the editing model. On save, splice only the user's changes into the original text (`src/pdm/patch.ts`); everything else must stay byte-identical. Never rebuild a PDM from the editing model, and never round-trip through a DOM serializer — verified that xmldom rewrites CRLF→LF and `&quot;`→`"`, drifting from PowerDesigner's own output.
2. **Model and diagram are separate.** Tables, columns, keys, references, indexes are model objects; coordinates, colors, and link paths are diagram symbols. One model object may have several symbols across several diagrams. Never treat X6's JSON as the source of truth.
3. **All edits go through a single command layer** (e.g. `AddColumn`, `DeleteReference`, `MoveTableSymbol`). Property panel and canvas both dispatch commands. The command layer owns reference integrity, undo/redo, and dirty state.
4. **Parsing, reference checking, and serialization run off the UI thread** (Electron utility process).
5. **Keep native data types.** Store `NUMBER(19)`, `VARCHAR2(20)`, `BIGINT` etc. as written. A generic type may be added for UI grouping only. Cross-database type conversion is a later feature.
6. **Common model + per-database adapters.** One shared model (tables, columns, PK/FK/unique, indexes, comments, diagrams) plus Oracle 11g / MySQL / PostgreSQL adapters for types, default expressions, sequences/auto-increment, and database-specific properties. Don't fork the editor per database.

## PDM interoperability pitfalls

- Objects have `Id` (document-local, e.g. `o123`), `ObjectID` (GUID), and are referenced via `Ref`. Adding objects requires unique new `Id`s and GUIDs; deleting objects requires fixing every reference.
- Deleting a column must check PK, unique keys, indexes, references (FK joins), and diagram symbols.
- **Name** (display name, often Chinese) and **Code** (database identifier) are distinct and edited separately.
- The model may link to DBMS definitions (`.xdb`) and extended model definitions (`.xem`); preserve those links.
- Views, procedures, triggers, partitions, special indexes: preserve as-is; expose editing gradually and label what is read-only.

## Verification

"The file opens" is not enough. The acceptance loop for every change to PDM read/write:

1. Original PDM (saved by PowerDesigner) → edit & save in PDM Canvas.
2. Open in PowerDesigner → Check Model → save again.
3. Reopen in PDM Canvas.
4. Confirm columns, constraints, references, layout, and extended info are intact.

Automated tests should cover parse → patch → serialize round trips against fixtures in `test-fixtures/`, asserting unmodified content is byte-for-byte or structurally unchanged.

## Roadmap

1. **Milestone 1:** open a real Oracle 11g XML PDM → display tables, columns, FKs → edit a column comment → save as new PDM → verify in PowerDesigner.
2. Add/delete columns and tables, create FKs (exercises Id/reference maintenance).
3. Diagram editing: drag tables, persist positions, multiple diagrams.
4. MySQL and PostgreSQL adapters.
5. Later: DDL generation, reverse engineering from live databases, macOS packaging.

## Commands

- `npm start` — run the app in dev (Electron Forge + Vite). Open a file on launch: `npm start -- <path-to.pdm>`.
- `npm test` — Vitest (PDM read/patch round trips; private fixtures run only when present).
- `npm run typecheck`, `npm run lint`, `npm run lint:fix`.
- `npm run make` — build installers.

## Project layout

- `src/pdm/` — PDM read/patch module. Pure TypeScript, no Electron/DOM dependencies; runs in Node tests.
- `src/main/` — Electron main process; holds parsed documents and handles file IPC.
- `src/preload/` — exposes `window.pdmApi` (contract in `src/shared/api.ts`).
- `src/renderer/` — React + antd UI; `components/DiagramCanvas.tsx` renders PowerDesigner diagrams with X6.

- `design/` — Claude Design handoff (prototype, reference only; not shipped).
- `test-fixtures/` — sample PDM files; see its README. `synthetic/` is hand-written (committed, used in CI) and not validated by PowerDesigner.
- `test-fixtures/private/` — real-world PDMs, gitignored. Never commit, copy elsewhere, or paste their contents into issues/PRs; tests using them must skip when absent.
