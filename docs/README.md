# Maintainer documentation

Start with the [project README](../README.md) for installation, supported connections and user-facing recovery instructions.

| Document                                 | Use it for                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [Architecture](architecture.md)          | Understand lifecycle ownership, checkpoint format, replay and invariants before changing code.      |
| [Upstream sources](upstream-sources.md)  | Find authoritative Pi/Codex code and documentation when updating dependencies or protocol behavior. |
| [Maintenance and review](maintenance.md) | Make changes, review safety-sensitive behavior and assess compatibility changes.                    |
| [Testing](testing.md)                    | Run local checks, add meaningful regressions and plan authorized live acceptance.                   |

These documents describe the current implementation, not experiment history. Keep them synchronized with code. Current backend acceptance is still unverified: local tests exercise the actual Pi runtime against synthetic local responses, not OpenAI's backend.
