# Book Download MCP releases

Package: `@gjjisadog/zlibrary-mcp`; installation release version: `1.4.1`.
Repository: https://github.com/gjjisadog/book-download-mcp
Workflow: `.github/workflows/publish.yml` (npm job uses Node 22 and npm 11 OIDC).
The CLI remains `zlibrary-mcp`. Keep `package.json`, `package-lock.json`,
`pyproject.toml` and `uv.lock` versions aligned.

## GitHub installation packages

Tag pushes build and test a portable `.tgz` installation package, attach
`INSTALL.md` and `SHA256SUMS`, and create the GitHub Release. Release notes must
exist at `docs/releases/<tag>.md`; the tag must match `package.json`. The installed
archive includes compiled JavaScript and Python sources; users run UV to create
their Python environment. The package does not contain credentials or local venvs.

The GitHub release and container jobs do not require npm authentication. npm
publication is disabled by default and runs only when repository variable
`NPM_PUBLISH_ENABLED=true` is configured after the first npm release setup below.

## First npm release setup

The scope must belong to an npm account authorized to publish it. A repository
configuration cannot provision that ownership or an npm trusted publisher.
For a package that does not yet exist, an authorized maintainer must first create
it using the npm account's permitted authentication method. Build and validate the
package before publishing; `npm publish --provenance --access public` makes the scoped
package public. No npm publication is performed by this repository setup.

On the package's npm settings page, configure a GitHub Actions trusted publisher:

- Organization/user: `gjjisadog`
- Repository: `book-download-mcp`
- Workflow filename: `publish.yml`
- Environment: leave empty (the current job specifies none)
- Allowed actions: enable direct `npm publish`

The automated workflow uses OIDC without `NODE_AUTH_TOKEN`. See the
[npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).
Do not assume the upstream package's publisher authorization applies here.
After creating the package and configuring its trusted publisher, set repository
variable `NPM_PUBLISH_ENABLED=true` to opt into automated npm publication.

## Subsequent releases

Run the CI checks, confirm the trusted publisher settings, then tag the exact package
version (for example `v1.4.1`). Pushing a tag triggers GitHub packages, GHCR and (when enabled) npm publication;
the workflow rejects mismatched tag/package versions. A manual workflow run publishes
the current package version to npm only, so run it only when that version is unpublished.
