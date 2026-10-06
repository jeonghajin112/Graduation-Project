# Graduation-Project

Integrated graduation project repository.

## Structure

- `ap-backend`: Spring Boot backend
- `Accessibility-Dashboard`: React/Vite frontend
- `AI-module`: accessibility analysis module

## Local Run Order

1. Run the backend from `ap-backend`.
2. Run the AI module or import an analysis result into the backend.
3. Run the frontend from `Accessibility-Dashboard`.

URL analysis and project-page analysis both start the AI module from the backend.
The backend passes its bound port and context path to that process as `API_BASE_URL`,
so changing `server.port` also changes the result ingestion address. To override
the callback (for example, with a TLS hostname), set `accessibility.ai.api-base-url`;
an existing `API_BASE_URL` environment variable is also respected. Include `/api/v1`.
When running `run_all.py` manually, set `API_BASE_URL` yourself if the backend is
not at the default `http://localhost:9090/api/v1`.

## Local Secrets

Sensitive files are not included in GitHub. Each developer must configure local files such as `.env` and Google Vision credentials on their own machine.

Do not commit Google Vision keys, `.env` files, virtual environments, `node_modules`, build outputs, or generated AI result files.
