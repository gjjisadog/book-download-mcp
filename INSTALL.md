# Install Book Download MCP 1.4.1

This is a portable MCP server package for macOS, Linux and Windows. It contains
compiled JavaScript and the Python bridge; it is not a desktop GUI application.
Node.js 22+ and [UV](https://docs.astral.sh/uv/getting-started/installation/) are
required. UV can install the recommended Python 3.12 automatically.

## Download and verify

Download `book-download-mcp-1.4.1.tgz` and `SHA256SUMS` from
[the GitHub release](https://github.com/gjjisadog/book-download-mcp/releases/tag/v1.4.1).
On Linux run `sha256sum --check --ignore-missing SHA256SUMS`; on macOS compare
`shasum -a 256 book-download-mcp-1.4.1.tgz` with the matching line in `SHA256SUMS`.
On Windows use `Get-FileHash .\book-download-mcp-1.4.1.tgz -Algorithm SHA256`.

## Install

Install the downloaded file with npm (no npm account is needed):

```sh
npm install --global ./book-download-mcp-1.4.1.tgz
```

Or install directly from GitHub:

```sh
npm install --global https://github.com/gjjisadog/book-download-mcp/releases/download/v1.4.1/book-download-mcp-1.4.1.tgz
```

Set up the Python environment inside the installed package. macOS / Linux:

```sh
uv sync --project "$(npm root --global)/@gjjisadog/zlibrary-mcp" --frozen --no-dev --python 3.12
```

Windows PowerShell:

```powershell
$packageDir = Join-Path (npm root --global) '@gjjisadog/zlibrary-mcp'
uv sync --project $packageDir --frozen --no-dev --python 3.12
```

The npm identity remains `@gjjisadog/zlibrary-mcp`, and the CLI is `zlibrary-mcp`.
The GitHub archive installs that package without requiring an npm registry release.
Python dependencies and the optional book-source backends need network access
during installation. Source compilation is not required.

## Connect an MCP client

Find the absolute installation path with `npm root --global` and configure:

```json
{
  "mcpServers": {
    "book-download": {
      "command": "node",
      "args": ["/absolute/npm/root/@gjjisadog/zlibrary-mcp/dist/index.js"]
    }
  }
}
```

On Windows use an absolute Windows path, escaping backslashes as `\\` in JSON.
LibGen and local document tools work without Z-Library credentials. Z-Library
requires your own account or account pool.

For accounts, create a private `accounts.env` outside the installation directory.
Use actual values, not `${VARIABLE}` templates. Add an absolute Node argument
`--env-file=/absolute/path/accounts.env` before the `dist/index.js` argument.
Protect the file with permissions `600` on macOS/Linux and do not commit it.
See the [configuration guide](https://github.com/gjjisadog/book-download-mcp#quick-start)
for credential variable names and account-pool examples.

Restart the MCP session after installation. Downloads require explicit version
confirmation; clients without form dialogs request confirmation in conversation.
