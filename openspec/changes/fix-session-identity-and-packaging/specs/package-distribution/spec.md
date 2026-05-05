## ADDED Requirements

### Requirement: Package name is unscoped

The npm package name SHALL be `pi-roles` (no scope prefix). The `pi install npm:pi-roles` command SHALL resolve the package without a personal or organization scope.

#### Scenario: Package manifest declares unscoped name
- **WHEN** a consumer reads `package.json`
- **THEN** the `"name"` field is `"pi-roles"` (not `"@lojacobs/pi-roles"` or any other scoped form)

#### Scenario: Install command works without scope
- **WHEN** a user runs `pi install npm:pi-roles`
- **THEN** pi resolves and installs the package from the npm registry

---

### Requirement: Version bump to 0.2.0

The package version SHALL be `0.2.0`, reflecting a breaking change (install path rename from any prior scoped publish) from `0.1.0`.

#### Scenario: Version field reflects breaking change
- **WHEN** a consumer reads `package.json`
- **THEN** the `"version"` field is `"0.2.0"`

---

### Requirement: Proper ESM distribution via dist/

The package SHALL ship compiled ESM output in `dist/` rather than raw TypeScript source. The `package.json` SHALL declare `main`, `exports`, and `types` fields pointing to the compiled output, and `files` SHALL include `dist/` (not `src/`). The `pi.extensions` entry SHALL reference `./dist/index.js`.

#### Scenario: Main entry points to compiled output
- **WHEN** a consumer requires or imports the package
- **THEN** the `"main"` field is `"./dist/index.js"`

#### Scenario: Exports map points to compiled output
- **WHEN** a consumer uses ESM import resolution
- **THEN** the `"exports"` map includes `".": "./dist/index.js"`

#### Scenario: Types point to compiled declarations
- **WHEN** a TypeScript consumer resolves types
- **THEN** the `"types"` field is `"./dist/index.d.ts"`

#### Scenario: Files field ships dist not src
- **WHEN** the package is packed for publishing (`npm pack`)
- **THEN** the `"files"` array includes `"dist/"` and does NOT include `"src/"`

#### Scenario: Pi extension entry points to compiled output
- **WHEN** pi loads the extension
- **THEN** the `"pi.extensions"` array contains `"./dist/index.js"` (not `"./src/index.ts"`)

---

### Requirement: Build toolchain for compilation

The package SHALL include a `build` script using `tsup`, a `clean` script, and a `prepublishOnly` script that cleans, builds, and typechecks before publishing. `tsup` SHALL be listed in `devDependencies`.

#### Scenario: Build script compiles TypeScript
- **WHEN** a developer runs `npm run build`
- **THEN** `tsup` compiles `src/` to `dist/`

#### Scenario: Clean script removes dist
- **WHEN** a developer runs `npm run clean`
- **THEN** the `dist/` directory is removed

#### Scenario: PrepublishOnly runs full verification
- **WHEN** `npm publish` is invoked
- **THEN** `npm run clean && npm run build && npm run typecheck` executes before publishing

#### Scenario: tsup is a devDependency
- **WHEN** a developer runs `npm install`
- **THEN** `tsup` is available as a dev dependency (version `^8.5.1` or compatible)

---

### Requirement: CHANGELOG entry for 0.2.0

`CHANGELOG.md` SHALL contain a `[0.2.0]` entry documenting the package rename (unscoping), the ESM distribution switch (`src/` → `dist/`), the session identity format change, and the footer fix.

#### Scenario: Changelog documents 0.2.0
- **WHEN** a user reads `CHANGELOG.md`
- **THEN** they see a `[0.2.0]` section with entries for the package rename, dist/ switch, identity format change, and footer fix
