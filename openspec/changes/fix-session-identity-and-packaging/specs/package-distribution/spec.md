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

The package version SHALL be `0.2.0`, reflecting a breaking change (install path rename) from `0.1.0`.

#### Scenario: Version field reflects breaking change
- **WHEN** a consumer reads `package.json`
- **THEN** the `"version"` field is `"0.2.0"`

---

### Requirement: CHANGELOG entry for 0.2.0

`CHANGELOG.md` SHALL contain a `[0.2.0]` entry documenting the package rename, the session identity format change, and the footer fix.

#### Scenario: Changelog documents 0.2.0
- **WHEN** a user reads `CHANGELOG.md`
- **THEN** they see a `[0.2.0]` section with entries for the package rename and identity/footer fixes
