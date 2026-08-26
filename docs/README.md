# Documentation

The root [README](../README.md) is the product overview, player quick start,
implemented ruleset, repository map, and local-development entry point.

Operator and specialist references live here:

| Document | Audience | Scope |
| --- | --- | --- |
| [deployment.md](deployment.md) | VM operator | First deployment, configuration, updates, backups, health checks, rollback, and Tailscale Funnel. |
| [data-and-privacy.md](data-and-privacy.md) | Host/operator | Persistent data, privacy boundaries, retention, backups, and private history commands. |
| [research-data.md](research-data.md) | Analyst/developer | Canonical event/replay schemas, integrity model, normalized views, exports, redaction, and Wrapped measures. |

Artwork-specific instructions remain in
[source-assets/README.md](../source-assets/README.md) beside the files they
govern. The optional machine-specific helper is documented in
[ops/README.md](../ops/README.md); it is not required to run Avalon.
