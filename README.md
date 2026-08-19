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

## Local Secrets

Sensitive files are not included in GitHub. Each developer must configure local files such as `.env` and Google Vision credentials on their own machine.

Do not commit Google Vision keys, `.env` files, virtual environments, `node_modules`, build outputs, or generated AI result files.
