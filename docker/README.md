# Book Download MCP Docker Deployment

Run Book Download MCP in a Docker container with HTTP transport via [SuperGateway](https://github.com/supercorp-ai/supergateway).

## Quick Start

```bash
# From project root
cd docker
cp env.example .env
# Edit .env with your Z-Library credentials

# Build and run
docker compose up -d
```

The server is bound to `127.0.0.1:8000` on the host. Remote clients should use an authenticated SSH tunnel:

```bash
ssh -N -L 8000:127.0.0.1:8000 user@server
```

Then connect to `http://localhost:8000/sse` locally. For public HTTP access, keep this loopback binding and place a TLS reverse proxy with authentication in front of it; authenticate both `/sse` and `/message`. Do not publish port 8000 directly. The pinned SuperGateway 3.4.3 has no inbound API-key authentication; `--oauth2Bearer` sets an outgoing header and does not protect this server ([versioned CLI source](https://github.com/supercorp-ai/supergateway/blob/v3.4.3/src/index.ts)).

## Manual Build

```bash
# From project root
docker build -t zlibrary-mcp -f docker/Dockerfile .

# Run standalone
docker run -d \
  -p 127.0.0.1:8000:8000 \
  -e ZLIBRARY_EMAIL=your@email.com \
  -e ZLIBRARY_PASSWORD=your_password \
  -v $(pwd)/downloads:/app/downloads \
  zlibrary-mcp
```

SuperGateway protocol logging is disabled (`--logLevel none`) because this pinned version logs complete MCP messages at its default level. The application still respects `LOG_LEVEL`; use its diagnostics for troubleshooting.

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZLIBRARY_EMAIL` | Yes | Z-Library account email |
| `ZLIBRARY_PASSWORD` | Yes | Z-Library account password |
| `ZLIBRARY_MIRROR` | No | Custom Z-Library mirror URL |
| `RETRY_MAX_RETRIES` | No | Max retry attempts (default: 3) |
| `CIRCUIT_BREAKER_THRESHOLD` | No | Failures before circuit opens (default: 5) |

### Volumes

| Container Path | Description |
|----------------|-------------|
| `/app/downloads` | Downloaded books directory |

## Health Check

```bash
curl http://localhost:8000/health
```

## Connecting MCP Clients

The server exposes the MCP protocol over HTTP via SuperGateway. Configure your MCP client to connect to:

```
http://localhost:8000
```

## Architecture

```
[MCP Client] <--HTTP--> [SuperGateway:8000] <--stdio--> [zlibrary-mcp]
```

SuperGateway wraps the stdio-based MCP server to provide HTTP transport, enabling:
- Remote access to the MCP server
- Load balancing and proxying
- Health monitoring
