# Dev Container Setup

This directory contains the configuration for developing Typster in a Dev Container.

## Prerequisites

- Docker Desktop (or Docker Engine on Linux)
- Visual Studio Code
- [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) for VS Code

## Getting Started

1. Open the project in VS Code
2. When prompted, click "Reopen in Container"
   - Or use Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) → "Dev Containers: Reopen in Container"
3. Wait for the container to build and start (first time may take a few minutes)
4. Once inside the container, dependencies will be automatically installed via `postCreateCommand`

## What's Included

- **Elixir 1.19** - Latest Elixir version
- **Node.js & npm** - For asset compilation
- **PostgreSQL 19** - Database service (accessible at `db:5432` from the container). [Migrate an existing 16 volume before rebuilding](../CONTRIBUTING.md#upgrade-a-postgresql-16-volume).
- **VS Code Extensions**:
  - ElixirLS (Elixir language server)
  - Phoenix Framework support
  - Tailwind CSS IntelliSense
  - Prettier

## Ports

- `4000` - Phoenix development server
- `5432` - PostgreSQL database

## Database Configuration

The database is automatically configured to use the `db` service hostname when running in the devcontainer. For local development outside the container, it defaults to `localhost`.

## Running the Application

Once inside the container:

```bash
# Start the Phoenix server
mix phx.server

# Or run in the background
mix phx.server &
```

The application will be available at `http://localhost:4000`

## Troubleshooting

If you encounter issues:

1. **Container won't start**: Check Docker is running and has enough resources
2. **Database connection errors**: Ensure the `db` service is healthy (check with `docker ps`)
3. **Port conflicts**: Make sure ports 4000 and 5432 aren't in use on your host machine
