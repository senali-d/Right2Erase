# Right2Erase

## Setup

The repository includes a Makefile for preparing the demo fixture. Make sure
Docker and Node.js/npm are installed, then run:

```bash
make setup
```

`make setup` installs the fixture dependencies, starts the Docker services, and
seeds the database. It is equivalent to:

```bash
cd fixture && npm install && npm run up && npm run seed
```

To start the billing MCP server with streamable HTTP transport, use:

```bash
make mcp-billing-http
```

This is equivalent to `cd fixture && npm run mcp:billing:http`.

To reset the fixture between runs, use:

```bash
make reset
```

## Qodo Code Review Evidence
